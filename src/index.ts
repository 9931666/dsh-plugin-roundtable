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
import { registerRoundTableTools } from './tools.ts'
import { collectMeetingSnapshots } from './snapshot.ts'
import { registerRpc, type RoundTableRuntime } from './rpc.ts'
import { setWorkspaceCandidates, workspaceCandidates } from './workspace-candidates.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'roundtable'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt', 'userQuestions']

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
})

/** The model-facing usage policy: when and how to drive RoundTable. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run a round-table meeting (圆桌会议) — e.g. "开个圆桌会议讨论 X", "让几个专家辩论 Y", "use RoundTable to decide Z" — you are the captain (主持人) of a multi-expert meeting. Follow this protocol:
1. Call roundtable_create with a meeting name, the goal, and the collaboration mode. Default to the user's configured mode (orchestrated unless asked otherwise); for egalitarian mode also bound max_rounds/max_tokens so the debate cannot run away; for "redteam" (针锋相对) the meeting attacks an already-settled plan — experts only find flaws, no alternative proposals.
2. Call roundtable_add_node once per expert role the goal needs (researcher, engineer, reviewer, ...). Nodes are durable subagents that carry the《全局协作总纲》as their persona. By default a node inherits your current provider/model; pass provider/model only when the user explicitly wants a different route for that expert. Never ask the user to pick per node.
3. Wire the topology with roundtable_connect (forward = pipeline hand-off, bidirectional = debate channel) to reflect the intended collaboration, and drop stale edges with roundtable_disconnect.
4. Lead by delegation: send tasks and relayed opinions to nodes with roundtable_send_message, monitor with roundtable_status, and pull the aggregation gateway digest with roundtable_summarize. Do not duplicate a node's work merely because its turn is slow. In orchestrated mode you relay everything; in egalitarian mode nodes debate each other directly and you only referee (watch the budget).
5. When experts disagree or a decision needs the user, call roundtable_request_decision with the question and option labels (the meeting pauses until the human answers). Never decide on the user's behalf.
6. Before handing a goal to a black-box worker model (no visible reasoning, e.g. a video/image model), call roundtable_proxy_think to obtain the director template: write the [DeepSeek 代理思考] reasoning, translate exact parameters, state expectations and fallbacks, so the global thinking chain stays transparent.
7. Watch the budget in roundtable_status. A muted (闭麦) meeting can be topped up with roundtable_set_budget. Present the consolidated result, then roundtable_close the meeting.
8. UI edits never touch meeting state directly: expert changes made in the Web UI (add/remove expert) are recorded as pending lines in the meeting's user-actions.jsonl (one JSON per line; read the "text" field). At the start of every round check roundtable_status for pending_actions: when present, execute each line with the matching roundtable_* tool (roundtable_add_node / roundtable_remove_node / ...), and only after EVERY action succeeded call roundtable_actions_clear to empty the file. If one action fails, keep the record and explain the failure in your reply — never clear a partially-executed file.
9. Knowledge-base relay (主持人中转): the meeting's knowledge-base directory is recorded in the meeting state (kb_path, shown in roundtable_status). When an expert needs reference material, YOU read the specific file(s) with your file tools and relay the content to the expert — never copy the whole library. Read on demand, prefer summaries, and cap single-file size to avoid double token cost (you read + expert reads). A "已修改知识库部分内容" pending action means the KB changed: re-browse it to refresh your understanding.
10. 针锋相对 (adversarial review): after you and the user settle a concrete plan, ASK whether they want to start this mode. If yes: call roundtable_start_review with the user's original question and the settled plan, then add red-team experts (role 红队审查) whose ONLY job is to attack the plan (no alternative proposals). When the experts have spoken, call roundtable_collect_review to gather their objections into the review record; the Web review window then opens automatically. The user clicks 「支持」 on real flaws — those endorsements arrive as pending user actions ("用户认定缺陷…"), so when you revise the plan next round, treat them as a known-flaws checklist.

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
    'roundtable_create',
    'roundtable_add_node',
    'roundtable_remove_node',
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

  // Browser RPC: preferences + edge direction edits from the topology tab.
  registerRpc(ctx, runtime)

  // Web snapshot route (browser topology tab polls this). Headless profiles
  // may not mount the web server: register lazily on service availability.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as WorkspaceListHost | undefined
    if (webServer === undefined || workspaceRegistry === undefined) return
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
