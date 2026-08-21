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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
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
  /** Default collaboration mode (default `orchestrated`). */
  defaultMode?: 'orchestrated' | 'egalitarian'
  /** Node delegation depth cap (default `1`). */
  memberMaxDepth?: number
  /** Prompt-section order for the usage policy (default `116`). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.roundtable'),
  memberProvider: z.string().default('spawn'),
  maxNodes: z.natural().min(1).default(8),
  defaultMode: z.union(['orchestrated', 'egalitarian']).default('orchestrated'),
  memberMaxDepth: z.natural().default(1),
  promptSectionOrder: z.natural().default(116),
})

/** Settings namespace for the runtime-tunable preferences (mode default, budget defaults). */
export const SETTINGS_NAMESPACE = settingsNamespace('roundtable')

/** User-tunable preference schema persisted under the `roundtable` namespace. */
const PreferenceSchema = z.object({
  defaultMode: z.union(['orchestrated', 'egalitarian']).default('orchestrated'),
  maxRounds: z.natural().default(10),
  maxTokens: z.natural().default(200_000),
})

/** The model-facing usage policy: when and how to drive RoundTable. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run a round-table meeting (圆桌会议) — e.g. "开个圆桌会议讨论 X", "让几个专家辩论 Y", "use RoundTable to decide Z" — you are the captain (主持人) of a multi-expert meeting. Follow this protocol:
1. Call roundtable_create with a meeting name, the goal, and the collaboration mode. Default to the user's configured mode (orchestrated unless asked otherwise); for egalitarian mode also bound max_rounds/max_tokens so the debate cannot run away.
2. Call roundtable_add_node once per expert role the goal needs (researcher, engineer, reviewer, ...). Nodes are durable subagents that carry the《全局协作总纲》as their persona. By default a node inherits your current provider/model; pass provider/model only when the user explicitly wants a different route for that expert. Never ask the user to pick per node.
3. Wire the topology with roundtable_connect (forward = pipeline hand-off, bidirectional = debate channel) to reflect the intended collaboration, and drop stale edges with roundtable_disconnect.
4. Lead by delegation: send tasks and relayed opinions to nodes with roundtable_send_message, monitor with roundtable_status, and pull the aggregation gateway digest with roundtable_summarize. Do not duplicate a node's work merely because its turn is slow. In orchestrated mode you relay everything; in egalitarian mode nodes debate each other directly and you only referee (watch the budget).
5. When experts disagree or a decision needs the user, call roundtable_request_decision with the question and option labels (the meeting pauses until the human answers). Never decide on the user's behalf.
6. Before handing a goal to a black-box worker model (no visible reasoning, e.g. a video/image model), call roundtable_proxy_think to obtain the director template: write the [DeepSeek 代理思考] reasoning, translate exact parameters, state expectations and fallbacks, so the global thinking chain stays transparent.
7. Watch the budget in roundtable_status. A muted (闭麦) meeting can be topped up with roundtable_set_budget. Present the consolidated result, then roundtable_close the meeting.

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
    'roundtable_set_budget',
    'roundtable_close',
    'roundtable_proxy_think',
  ].join(', ')
  ctx.systemPrompt.section({
    name: 'roundtable:usage',
    order: config.promptSectionOrder ?? 116,
    text: usageSectionText(toolNames),
  })

  registerRoundTableTools(ctx, {
    stateDir: resolved.stateDir,
    memberProvider: resolved.memberProvider,
    maxNodes: resolved.maxNodes,
    defaultMode: resolved.defaultMode,
    memberMaxDepth: resolved.memberMaxDepth,
  })

  // Settings-backed runtime preferences (mode default, budget defaults). The
  // cordis.yml config is the composition base; the user layer wins. Settings
  // are consumed by the client settings page (via RPC) and by the tools'
  // defaults.
  const runtime: RoundTableRuntime = { scope: undefined, stateDir: resolved.stateDir }
  ctx.inject(['settings'], (settingsCtx) => {
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
