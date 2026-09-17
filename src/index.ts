/**
 * RoundTable for DeepSeek Harness — host plugin entry.
 *
 * A host-plane plugin that registers the `roundtable_*` tools and one usage
 * section into the global system prompt. After installation any session can
 * run a visualized round-table meeting through natural language: the model
 * creates a meeting (it becomes the captain), adds expert nodes as durable
 * continuable subagents, wires directed edges, collects contributions through
 * the aggregation gateway, and asks the human when a decision is needed.
 * The Web GUI shows the meeting as a topology tab via the `conversation.view`
 * slot, fed by the `/plugins/dsh-plugin-roundtable/state` snapshot route.
 *
 * @module dsh-plugin-roundtable
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
// Declaration merge only: makes ctx.userQuestions visible.
import type {} from '@deepseek-ai/dsh-user-questions'
// Declaration merge only: makes ctx.skills visible (R2: DSH 原生 skill 能力).
import type {} from '@deepseek-ai/dsh-skill'
import { registerRoundTableTools } from './tools.ts'
import { collectMeetingSnapshots } from './snapshot.ts'
import { registerRpc, RPC_ROUTE, type RoundTableRuntime } from './rpc.ts'
import { setWorkspaceCandidates, workspaceCandidates } from './workspace-candidates.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'roundtable'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'userQuestions', 'skills']

/** Plugin configuration. */
export interface Config {
  /** State directory name under the captain's workspace (default `.roundtable`). */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn nodes (default `spawn`). */
  memberProvider?: string
  /** Meeting size cap in nodes (default `8`). */
  maxNodes?: number
  /** Default collaboration mode (default `orchestrated`; `redteam` = 针锋相对评审). */
  defaultMode?: 'orchestrated' | 'egalitarian' | 'redteam'
  /** Node delegation depth cap (default `1`). */
  memberMaxDepth?: number
  /** Prompt-section order for the usage policy (default `116`). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.roundtable'),
  memberProvider: z.string().default('spawn'),
  maxNodes: z.natural().min(1).default(8),
  defaultMode: z.union(['orchestrated', 'egalitarian', 'redteam']).default('orchestrated'),
  memberMaxDepth: z.natural().default(1),
  promptSectionOrder: z.natural().default(116),
})

/** Settings namespace for the runtime-tunable preferences (mode default, budget defaults). */
export const SETTINGS_NAMESPACE = 'roundtable' as const

/** User-tunable preference schema persisted under the `roundtable` namespace. */
const PreferenceSchema = z.object({
  defaultMode: z.union(['orchestrated', 'egalitarian', 'redteam']).default('orchestrated'),
  maxRounds: z.natural().default(10),
  maxTokens: z.natural().default(200_000),
  showAllMeetings: z.boolean().default(true),
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  expertMaxTokens: z.natural().default(0),
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  expertMaxOpinions: z.natural().default(0),
  /** E1/E4 反馈：会议结束后是否询问轻量反馈（默认开，可在设置页关闭）。 */
  feedbackEnabled: z.boolean().default(true),
  /** R2.2/D5 skill 传递方式：relay=主持人中转（省 token、可预测）；direct=专家自行调用 `skill` 工具。 */
  skillDelivery: z.union(['relay', 'direct']).default('relay'),
  /** R3 右栏面板可见性：被列出的面板在拓扑页隐藏（空 = 全部显示）。 */
  hiddenPanels: z.array(z.string()).default([]),
  /** B3 用户自建角色预设：设置页维护，专家管理面板一键填充。
   *  刻意**不预置任何内置角色** —— 列表空着，等用户自己建。
   *  注意 schemastery 不强制 required，字段级校验在 rpc.ts 手写。 */
  rolePresets: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    provider: z.string(),
    model: z.string(),
  })).default([]),
})

/** The model-facing usage policy: when and how to drive RoundTable. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run a round-table meeting (圆桌会议) — e.g. "开个圆桌会议讨论 X", "让几个专家辩论 Y", "use RoundTable to decide Z" — you are the captain (主持人) of a multi-expert meeting. Follow this protocol:
1. NEVER create a meeting straight away. First call roundtable_plan_meeting with the meeting name, the goal, and the experts you intend to use (key/role/provider/model, only pass provider/model when the user explicitly wants a different route for that expert) plus the parameters you derived. It does NOT create anything: it shows the human a readable SETTINGS CARD (roster + mode + budget + knowledge base + selected skills) and blocks until they answer, returning decision="approved" (create with exactly those values) or decision="revise" with the user's own words — update the draft, keep every unchanged field as-is, and call it again (it will show the revised card with revised=true). Always show the card, even for a single expert. If it returns decision="unavailable", state the draft in words, get explicit agreement, then create.
2. Call roundtable_create only with the confirmed values (name, goal, mode, max_rounds, max_tokens, kb_path, skills, skill_delivery). Default to the user's configured mode (orchestrated unless asked otherwise); for egalitarian mode also bound max_rounds/max_tokens so the debate cannot run away; for "redteam" (针锋相对) the meeting attacks an already-settled plan — experts only find flaws, no alternative proposals.
3. Call roundtable_add_node once per expert role the goal needs (researcher, engineer, reviewer, ...). Nodes are durable subagents that carry the《全局协作总纲》as their persona. R-A: the user maintains self-built role presets (设置 → 圆桌会议 → 角色预设); call roundtable_list_presets FIRST and, when a preset fits, pass its id as \`preset\` to add_node (or reuse its role verbatim) so the meeting runs the text the user actually wrote — do NOT invent a substitute role for a task a preset already covers. If the catalogue is empty, write the role yourself and say it is ad-hoc. By default a node inherits your current provider/model; pass provider/model only when the user explicitly wants a different route for that expert. Never ask the user to pick per node.
4. Wire the topology with roundtable_connect (forward = pipeline hand-off, bidirectional = debate channel) to reflect the intended collaboration, and drop stale edges with roundtable_disconnect.
5. Lead by delegation: send tasks and relayed opinions to nodes with roundtable_send_message, monitor with roundtable_status, and pull the aggregation gateway digest with roundtable_summarize. Do not duplicate a node's work merely because its turn is slow. In orchestrated mode you relay everything; in egalitarian mode nodes debate each other directly and you only referee (watch the budget).
6. When experts disagree or a decision needs the user, call roundtable_request_decision with the question and option labels (the meeting pauses until the human answers). Never decide on the user's behalf.
7. Before handing a goal to a black-box worker model (no visible reasoning, e.g. a video/image model), call roundtable_proxy_think to obtain the director template: write the [DeepSeek 代理思考] reasoning, translate exact parameters, state expectations and fallbacks, so the global thinking chain stays transparent.
8. Watch the budget in roundtable_status. HONESTY RULE: the token figure there is an ESTIMATE OF SPOKEN TEXT ONLY (≈0.6 token per CJK char) — it excludes system prompts, expert personas, conversation history and tool overhead, so it is NOT the real LLM spend. Treat it as a "how much have we said" gauge, not a cost meter, and say so when you report it to the user. A muted (闭麦) meeting can be topped up with roundtable_set_budget. Present the consolidated result, then roundtable_close the meeting.
9. UI edits never touch meeting state directly: expert changes made in the Web UI (add/remove expert) are recorded as pending lines in the meeting's user-actions.jsonl (one JSON per line; read the "text" field). At the start of every round check roundtable_status for pending_actions: when present, execute each line with the matching roundtable_* tool (roundtable_add_node / roundtable_remove_node / ...), and only after EVERY action succeeded call roundtable_actions_clear to empty the file. If one action fails, keep the record and explain the failure in your reply — never clear a partially-executed file. roundtable_actions_clear also reports "malformed": a non-zero count means that many recorded lines were not valid JSON, so those user operations could NOT be executed and are now gone — say so plainly to the user instead of reporting a clean sweep.
10. Knowledge-base relay (主持人中转): the meeting's knowledge-base directory is recorded in the meeting state (kb_path, shown in roundtable_status). When an expert needs reference material, YOU read the specific file(s) with your file tools and relay the content to the expert — never copy the whole library. Before reading any KB file, check the "KB digest cache" section of roundtable_status: an entry marked [HIT] means the cached summary still matches the current file contents, so reuse that digest directly and do NOT read the file again — you reading it plus the expert reads it is exactly where the double token cost comes from. Only on a miss (no entry, or [STALE]) read the file, then store the distilled points with roundtable_kb_digest so the next need is free. Keep digests short: they are summaries, not file copies. A "已修改知识库部分内容" pending action means the KB changed: re-browse it to refresh your understanding.
11. Skills (DSH native, v0.2.31): a meeting may carry a skill list (shown as skills in roundtable_status) with a delivery mode of its own (skill_delivery). In "relay" mode YOU read the skill body (ctx.skills.get) and hand the relevant points to the expert — never ask an expert to load it. In "direct" mode each expert loads skills itself with the native \`skill\` tool from the names listed in its persona; do not relay the body. Pick the skills on the settings card from the real catalog; never invent a skill name. If the user asks to add skills mid-meeting, the meeting's own list cannot change — note it and use the relay path for the new material.
12. 针锋相对 (adversarial review): after you and the user settle a concrete plan, ASK whether they want to start this mode. If yes: call roundtable_start_review with the user's original question and the settled plan, then add red-team experts (role 红队审查) whose ONLY job is to attack the plan (no alternative proposals). When the experts have spoken, call roundtable_collect_review to gather their objections into the review record; the Web review window then opens automatically. The user clicks 「支持」 on real flaws and must type a reason when 「驳回」 (驳回必填理由) — endorsements arrive as pending user actions ("用户认定缺陷…"), so treat them as a known-flaws checklist when you revise the plan. After the user finishes and you have revised the plan, call roundtable_finish_review (附上修订说明) to close the pass. Closed loop (闭环复审, C3): a review may run at most 3 passes total (first + up to 2 re-reviews, max_review_pass=3); each re-review is started again with roundtable_start_review and must only check whether the previous pass's endorsed flaws were fixed — do NOT let experts introduce brand-new scoring. When the cap is reached you may continue only after the user explicitly approves (user_approved_extra_pass=true). Present the consolidated result, and export the record with roundtable_export_review into a Markdown deliverable the user can keep or paste into an issue.

13. Exporting the whole meeting: roundtable_export_meeting turns the ENTIRE meeting into a Markdown deliverable — issue-style header (plugin version, mode, time span, budget), goal, expert roster with routes, the decision log, every round of the transcript with speaker → audience, the review record when one exists, and the user's adjustment log. It returns the Markdown to you AND writes it to <meetingDir>/export.md so the user can open the file directly; it also works while the meeting is still running (the header then marks it as an in-progress snapshot). Use roundtable_export_review when only the 针锋相对 record is wanted.

Tools: ${toolNames}`
}

/** Web-server service slice used to register the snapshot route. */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Workspace registry slice used to enumerate state roots. */
interface WorkspaceListHost {
  list(): { title: string; path: string }[]
}

/** Structural service-key candidates (newest first). */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

export function apply(ctx: Context, config: Config): void {
  const resolved = {
    stateDir: config.stateDir ?? '.roundtable',
    memberProvider: config.memberProvider ?? 'spawn',
    maxNodes: config.maxNodes ?? 8,
    defaultMode: config.defaultMode ?? 'orchestrated',
    memberMaxDepth: config.memberMaxDepth ?? 1,
  }

  // Usage policy into the global system prompt.
  const toolNames = [
    'roundtable_plan_meeting',
    'roundtable_create',
    'roundtable_add_node',
    'roundtable_remove_node',
    'roundtable_list_presets',
    'roundtable_connect',
    'roundtable_disconnect',
    'roundtable_speak',
    'roundtable_send_message',
    'roundtable_summarize',
    'roundtable_request_decision',
    'roundtable_status',
    'roundtable_actions_clear',
    'roundtable_start_review',
    'roundtable_collect_review',
    'roundtable_finish_review',
    'roundtable_export_review',
    'roundtable_export_meeting',
    'roundtable_kb_digest',
    'roundtable_set_budget',
    'roundtable_close',
    'roundtable_proxy_think',
  ].join(', ')
  ctx.systemPrompt.section({
    name: 'roundtable:usage',
    order: config.promptSectionOrder ?? 116,
    text: usageSectionText(toolNames),
  })

  // Settings-backed runtime preferences (mode default, budget defaults, expert
  // answer limits). The cordis.yml config is the composition base; the user
  // layer wins. Settings are consumed by the client settings page (via RPC)
  // and by the tools' defaults. Declared before the tools so their lazy
  // getExpertLimits closure can read the live scope.
  const runtime: RoundTableRuntime = {
    scope: undefined,
    stateDir: resolved.stateDir,
    fallbackPrefs: {
      defaultMode: resolved.defaultMode,
      maxRounds: 10,
      maxTokens: 200_000,
      showAllMeetings: true,
      expertMaxTokens: 0,
      expertMaxOpinions: 0,
      feedbackEnabled: true,
      skillDelivery: 'relay',
      hiddenPanels: [],
      rolePresets: [],
    },
  }

  registerRoundTableTools(ctx, {
    stateDir: resolved.stateDir,
    memberProvider: resolved.memberProvider,
    maxNodes: resolved.maxNodes,
    defaultMode: resolved.defaultMode,
    memberMaxDepth: resolved.memberMaxDepth,
    // 观点拆分 LLM 路由：默认 deepseek-official/deepseek-v4-flash（实测可用），
    // 后续可配置化；不可用时 collect 自动整条兜底（三道防线②）。
    reviewSplit: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxOpinions: 3,
    },
    // Read live every spawn so a settings change applies to newly added
    // experts without a restart.
    getExpertLimits: () => {
      const prefs = runtime.scope?.get() ?? runtime.fallbackPrefs
      return {
        maxTokens: prefs.expertMaxTokens ?? 0,
        maxOpinions: prefs.expertMaxOpinions ?? 0,
      }
    },
    // R2.2/D5：skill 传递方式的默认值，读设置页（实时）。
    getSkillDelivery: () => (runtime.scope?.get() ?? runtime.fallbackPrefs).skillDelivery ?? 'relay',
    // R-A 修复：把用户自建角色预设暴露给工具层（实时读取）。
    // 此前预设只被浏览器表单消费，agent 侧拿不到 —— 主持人结构上无法「按预设建节点」。
    getRolePresets: () => (runtime.scope?.get() ?? runtime.fallbackPrefs).rolePresets ?? [],
    // R1 第 3 条：卡片默认值的设置页那一层。
    getPlannedDefaults: () => {
      const prefs = runtime.scope?.get() ?? runtime.fallbackPrefs
      return {
        mode: prefs.defaultMode,
        maxRounds: prefs.maxRounds,
        maxTokens: prefs.maxTokens,
        skillDelivery: prefs.skillDelivery ?? 'relay',
      }
    },
  })
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, PreferenceSchema, {
        base: { defaultMode: resolved.defaultMode },
      }) as unknown as RoundTableRuntime['scope']
      runtime.scope = scope
      scope?.watch((value) => {
        const preference = value as { defaultMode?: 'orchestrated' | 'egalitarian' } | undefined
        if (preference?.defaultMode === 'orchestrated' || preference?.defaultMode === 'egalitarian') {
          resolved.defaultMode = preference.defaultMode
        }
      })
    } catch (error) {
      settingsCtx.logger.warn('roundtable: settings namespace registration failed; preferences fall back to config defaults', error)
    }
  })

  // Browser RPC (preferences, edge edits, KB path, review 表态 …). The same
  // dispatch body is mounted on the plugin's own web route below.
  const dispatchRpc = registerRpc(ctx, runtime)

  // Web surface: the snapshot route AND the RPC route (browser settings page +
  // topology tab edits). Both ride the plugin's own `webServer` registration —
  // the transport that is reliably reachable — instead of depending on the
  // host's generic connection channel. Headless profiles may not mount the web
  // server: register lazily on service availability.
  let webRegistered = false
  let rpcRouteRegistered = false
  const registerWebSurface = (): void => {
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    if (webServer === undefined) return

    // RPC route: needs only the web server, so it mounts on its own.
    if (!rpcRouteRegistered) {
      rpcRouteRegistered = true
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: RPC_ROUTE,
        handler: async (req, res) => {
          const send = (status: number, body: unknown): void => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(JSON.stringify(body))
          }
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            send(405, { ok: false, error: { code: 'internal', message: 'this route accepts POST only' } })
            return
          }
          let body: unknown
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          } catch {
            send(400, { ok: false, error: { code: 'internal', message: 'body must be JSON' } })
            return
          }
          const message = body as { endpoint?: unknown; payload?: unknown } | null
          if (message === null || typeof message !== 'object' || typeof message.endpoint !== 'string') {
            send(400, { ok: false, error: { code: 'internal', message: 'body must be { endpoint, payload? }' } })
            return
          }
          // dispatch 自身绝不抛错（见 rpc.ts）。
          send(200, await dispatchRpc(message.endpoint, message.payload))
        },
      }), 'roundtable: rpc route')
    }

    if (webRegistered) return
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceListHost | undefined
    if (workspaceRegistry === undefined) return
    webRegistered = true
    const refreshCandidates = (): void => {
      setWorkspaceCandidates(workspaceRegistry.list().map((workspace) => ({
        title: workspace.title,
        path: workspace.path,
      })))
    }
    refreshCandidates()
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-plugin-roundtable/state',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const roots = workspaceCandidates().map((workspace) => ({
          workspace: workspace.title,
          stateRoot: join(workspace.path, resolved.stateDir),
        }))
        const sessionFilter = url.searchParams.get('session') ?? undefined
        const snapshots = await collectMeetingSnapshots(ctx, roots, sessionFilter)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ meetings: snapshots }))
      },
    }), 'roundtable: snapshot route')
  }
  registerWebSurface()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName as (typeof WEB_SERVER_KEYS)[number])
      || WORKSPACE_KEYS.includes(serviceName as (typeof WORKSPACE_KEYS)[number])) {
      registerWebSurface()
    }
  })
}
