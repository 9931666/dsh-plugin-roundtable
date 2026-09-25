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
import { usageSectionText } from './prompt.ts'
import { attachNodeEvents } from './node-events.ts'
import { connectionFenceOf, MAX_RPC_BODY_BYTES, rejectWebRequest } from './web-guard.ts'
import { collectMeetingSnapshots } from './snapshot.ts'
import { registerRpc, RPC_ROUTE, type RoundTableRuntime } from './rpc.ts'
import {
  WEB_SERVER_KEYS,
  WORKSPACE_KEYS,
  webRouteHostOf,
  workspaceRegistryOf,
} from './harness-compat.ts'
import { setWorkspaceCandidates, workspaceCandidates } from './workspace-candidates.ts'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'roundtable'

/**
 * REQUIRED services only — and the list is load-gating, which is why it is
 * short. cordis has no "optional inject" form (`Inject` is `string[] | Record`
 * and the record form is only intercept config), so every name listed here
 * keeps the whole plugin fiber PENDING until that service exists: no
 * `roundtable_*` tools, no `/plugins/dsh-plugin-roundtable/*` routes and no GUI
 * tab. A missing OPTIONAL capability listed here therefore presents to the user
 * as "圆桌会议整个不见了 / 无法调用界面" with no error anywhere.
 *
 * `userQuestions` and `skills` are deliberately NOT listed: both are optional
 * capabilities that the plugin reads live through `ctx.get(...)`:
 *   - skills.ts hard constraint #1 — the plugin MUST load in a profile without
 *     the skill service and degrade to an empty catalog;
 *   - tools.ts falls back to `decision: 'unavailable'` when the userQuestions
 *     service is absent (the captain then states the draft in words).
 * v0.2.36 removed both from this list; v0.2.21 had already fixed the mirrored
 * over-constraint on the browser half (`connection`).
 */
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

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
  /** B3+ 用户自建阵容预设：一次把多位专家排进待加入队列。
   *  与角色预设同样**不预置内置阵容**；条目级校验在 rpc.ts 手写
   *  （schemastery 不强制 required）。新增字段是可选且带默认值，
   *  因此旧偏好对象无需版本迁移即可读。 */
  squads: z.array(z.object({
    id: z.string(),
    name: z.string(),
    members: z.array(z.object({
      key: z.string(),
      role: z.string(),
      provider: z.string(),
      model: z.string(),
    })),
  })).default([]),
})

// 主持人 usage 段已迁往 prompt.ts（纯文本模块，体积可被测试断言）。


export function apply(ctx: Context, config: Config): void {
  const resolved = {
    stateDir: config.stateDir ?? '.roundtable',
    memberProvider: config.memberProvider ?? 'spawn',
    maxNodes: config.maxNodes ?? 8,
    defaultMode: config.defaultMode ?? 'orchestrated',
    memberMaxDepth: config.memberMaxDepth ?? 1,
  }

  // Usage policy into the global system prompt. The text lives in prompt.ts so
  // that test/prompt-budget.test.mjs can assert its size.
  ctx.systemPrompt.section({
    name: 'roundtable:usage',
    order: config.promptSectionOrder ?? 116,
    text: usageSectionText(),
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
      squads: [],
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
  // 第 1 批：接入宿主子代理生命周期 —— 专家产出自动落盘（即使它没调
  // roundtable_speak 或中途中断），失败原因写进 node.lastError。
  attachNodeEvents(ctx)
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
    // 服务解析统一走 harness-compat：候选键探测 + 探测结果留痕（诊断用），
    // 且**绝不成为加载门禁** —— 取不到就静默降级，插件其余部分照常工作。
    const webServer = webRouteHostOf(ctx)
    if (webServer === undefined) return
    // 第 2 批（P5）：宿主 webserver 不会自动施加 Host/Origin + 浏览器认证栅栏，
    // 必须由路由自己调 `connection.requestRejection`。取不到该服务时放行（最小
    // profile 不能因此瘫痪），但只要能取到就一定要用。
    const fence = connectionFenceOf(ctx.get('connection'))

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
          const rejection = rejectWebRequest(fence, req.headers)
          if (rejection !== undefined) {
            send(rejection, { ok: false, error: { code: 'forbidden', message: 'connection trust check failed' } })
            return
          }
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
            send(405, { ok: false, error: { code: 'internal', message: 'this route accepts POST only' } })
            return
          }
          let body: unknown
          try {
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of req) {
              size += (chunk as Buffer).length
              // 第 2 批：无上限的请求体等于让任何本机页面把整包塞进内存。
              if (size > MAX_RPC_BODY_BYTES) {
                send(413, { ok: false, error: { code: 'internal', message: 'request body too large' } })
                return
              }
              chunks.push(chunk as Buffer)
            }
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
    const workspaceRegistry = workspaceRegistryOf(ctx)
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
        // 第 2 批（P5）：这条 GET 会吐出所有会议的摘要、评审方案与发言。
        const rejection = rejectWebRequest(fence, req.headers)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ meetings: [] }))
          return
        }
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
