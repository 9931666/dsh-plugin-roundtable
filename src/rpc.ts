/**
 * RPC handlers for the browser topology tab:
 *   - `roundtable/prefs.get`   → { defaultMode, maxRounds, maxTokens }
 *   - `roundtable/prefs.set`   → persist user preferences
 *   - `roundtable/edge.set`    → flip one edge's direction (UI right-click menu)
 *   - `roundtable/edge.add`    → drag-to-connect a new channel
 *   - `roundtable/edge.remove` → remove an edge
 *
 * Registered on the host through `ctx.inject(['connection'])` on the plugin's
 * OWN RPC channel `/roundtable` (NOT the shared `/api` one). The `/api`
 * channel is a single-interceptor shared channel owned by dsh-api-gateway, so
 * registering a second `intercept('/api')` here throws
 * "shared RPC channel /api already has an interceptor" and silently drops
 * every roundtable RPC — which is exactly why drag-to-connect looked dead for
 * both removed AND active nodes. Using `rpc.handle('/roundtable', ...)` gives
 * this plugin its own prefix-routed channel, mirroring the ya-subagent plugin.
 * @module dsh-plugin-roundtable/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
// Value import triggers `declare module 'cordis'` merge for `ctx.connection`.
import type {} from '@deepseek-ai/dsh-client-connection'
// Declaration merge only: makes ctx.llm visible for the model-list RPC.
import type {} from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { auditEndpointDeclarations, checkEndpointGate, ENDPOINT_INDEX } from './rpc-endpoints.ts'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { EdgeDirection, FeedbackEntry, UserAction } from './types.ts'
// 偏好形状、净化规则与自持久化存储都住在 preferences.ts：宿主 0.2.0-rc.2 把
// `settings` 服务重构成 `SettingsForms`（投影 profile 配置），插件不再能注册
// 自己的命名空间，因此偏好改为落 DSH home 下的 JSON 文件。
import {
  ROLE_PRESET_MAX,
  ROUNDTABLE_PANELS,
  SQUAD_MAX,
  SQUAD_MEMBER_MAX,
  sanitizeHiddenPanels,
  sanitizeRolePresets,
  sanitizeSquads,
  type PreferenceStore,
  type RoundTablePreferences,
} from './preferences.ts'
import { interruptNodeByParent } from './members.ts'
import {
  appendFeedback,
  appendUserAction,
  clearFeedback,
  clearFeedbackForMeeting,
  meetingDirOf,
  readFeedback,
  readMeeting,
  readReview,
  readUserActions,
  setViewpointStatus,
  stateRootOf,
  withMeetingLock,
  writeMeeting,
} from './state.ts'
import { buildCharter } from './charter.ts'
import { effectWithOptionalDisposer } from './harness-compat.ts'

/** RPC result envelope (mirrors the apiproxy wire shape). */
export type RpcResult<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/**
 * 偏好形状与净化规则住在 `preferences.ts`（那里的模块注释说明了原因：宿主
 * 0.2.0-rc.2 把 `settings` 服务重构成 `SettingsForms`，插件不再能注册自己的
 * 命名空间）。这里 re-export 只为不打断既有引用路径。
 */
export type { RoundTablePreferences }
// 与旧版一致：净化函数与上限常量仍从 rpc.ts 可取（测试与工具都按这个路径导入）。
export {
  ROLE_PRESET_MAX,
  ROUNDTABLE_PANELS,
  SQUAD_MAX,
  SQUAD_MEMBER_MAX,
  sanitizeHiddenPanels,
  sanitizeRolePresets,
  sanitizeSquads,
}

/** 自持久化偏好存储 + 会议 state 根，共享给工具与 RPC 两条执行路径。 */
export interface RoundTableRuntime {
  /** 偏好读写（见 preferences.ts：宿主 settings 服务在 0.2.0-rc.2 已重构）。 */
  prefs: PreferenceStore
  stateDir: string
}

/**
 * Browser-facing POST route for this plugin's RPC.
 *
 * It mirrors the snapshot route's transport (the plugin's own `webServer`
 * registration) instead of relying on the host's generic connection channel,
 * which is what the client actually reaches.
 */
export const RPC_ROUTE = '/plugins/dsh-plugin-roundtable/rpc'

/** One endpoint dispatch: `(endpoint, payload) => envelope`, never throws. */
export type RpcDispatch = (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message } }
}

/** Connection service slice used to register this plugin's own RPC channel. */
interface RpcConnection {
  readonly rpc: {
    /**
     * 0.1.5-rc.1 起为两参签名：`handle(channel, handler) => disposer`。
     * 0.1.1 时代的第三参 `{ authority }` 已被移除；实测运行时忽略多余实参，
     * 因此本 shim 只保留真实形状，避免后人照抄不存在的选项。
     */
    readonly handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    ) => unknown  }
}

/** Run one meeting mutation under the meeting lock, resolving its state root first. */async function withMeetingRpcLock<T>(
  runtime: RoundTableRuntime,
  meetingId: string,
  operation: (stateRoot: string) => Promise<RpcResult<T>>,
  options: { requireActive?: boolean; preferredWorkspace?: string } = {},
): Promise<RpcResult<T>> {
  const { workspaceOfMeeting } = await import('./edge-helper.ts')
  // 前端已知会议属于哪个工作区（快照里每场会议都带 `workspace`），传进来就
  // 只认它 —— 同名会议跨工作区时不会改错对象（M8）。
  const workspace = await workspaceOfMeeting(runtime.stateDir, meetingId, options.preferredWorkspace)
  if (workspace === undefined) {
    return fail(options.preferredWorkspace === undefined
      ? `meeting "${meetingId}" not found in any workspace`
      : `meeting "${meetingId}" not found in workspace "${options.preferredWorkspace}"`)
  }
  const stateRoot = stateRootOf(workspace, runtime.stateDir)
  return withMeetingLock(`meeting:${stateRoot}:${meetingId}`, async () => {
    if (options.requireActive === true) {
      // P10（第 2 批）：工具侧一直有 `assertUsable` 闸门，RPC 侧却完全没有状态机
      // 校验 —— 已结束会议的拓扑与知识库还能被改（导出物与快照随即不一致），而
      // 给已结束会议排的专家操作永远不会有人执行，只能变成孤儿记录挂在 UI 上。
      const meeting = await readMeeting(stateRoot, meetingId)
      if (meeting !== undefined && (meeting.status === 'ended' || meeting.status === 'archived')) {
        return fail<T>(`meeting "${meetingId}" has ended — its topology is read-only`)
      }
    }
    return operation(stateRoot)
  })
}

/** 观点三态写入（V0.2.2）。幂等；状态变化时写结构化 user-action（V2 回写负载）。
 *  驳回必须附理由（C2），由 setViewpointStatus 强制非空。
 *  P1 务实降级：connection 通道不暴露调用者 session 身份（handler 仅
 *  endpoint/payload/signal），无法做 captainSessionId 校验——以「会议归属
 *  校验（withMeetingRpcLock）+ 状态机校验（reviewing 阶段拒绝）」作为防线。 */
async function applyViewpointStatus(
  runtime: RoundTableRuntime,
  meetingId: string,
  viewpointId: string,
  status: 'pending' | 'endorsed' | 'rejected',
  rejectReason?: string,
): Promise<RpcResult<{ changed: boolean; status: string }>> {
  return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
    const review = await readReview(stateRoot, meetingId)
    if (review === undefined) return fail(`no review in progress for meeting "${meetingId}"`)
    const viewpoint = review.viewpoints.find((candidate) => candidate.id === viewpointId)
    if (viewpoint === undefined) return fail(`viewpoint "${viewpointId}" not found`)
    if (review.status === 'reviewing') {
      return fail('review is still collecting viewpoints — call roundtable_collect_review before endorsing or rejecting')
    }
    if (review.status === 'done') {
      return fail('this review pass is finished — start a new pass (roundtable_start_review) to re-review')
    }
    let changed: boolean
    try {
      changed = await setViewpointStatus(stateRoot, meetingId, viewpointId, status, rejectReason)
    } catch (error) {
      return fail((error as Error).message)
    }
    if (changed && status !== 'pending') {
      const label = status === 'endorsed' ? '用户认定缺陷' : '用户驳回观点'
      const reasonText = status === 'rejected' && rejectReason !== undefined && rejectReason.trim() !== ''
        ? `；理由：${rejectReason.trim().replace(/\s+/g, ' ').slice(0, 120)}`
        : ''
      await appendUserAction(stateRoot, meetingId, {
        id: randomUUID(),
        ts: Date.now(),
        kind: 'other',
        nodeKey: viewpoint.nodeKey,
        // V2：回写负载升级为结构化行 id（utteranceId#seq），主持人据此精确回改。
        text: `${label}（针锋相对评审 ${viewpoint.id}）${reasonText}：${viewpoint.content.replace(/\s+/g, ' ').slice(0, 60)}`,
      })
    }
    return ok({ changed, status })
  })
}

/**
 * Register the RoundTable RPC handler.
 *
 * Two transports share ONE dispatch body, so the browser can reach the plugin
 * even when the host's generic `connection` channel is not mounted (or its
 * `/roundtable` prefix got dropped by a live plugin reload):
 *   1. the host `connection` RPC channel `/roundtable` (kept for compatibility);
 *   2. the plugin's own `webServer` POST route `<RPC_ROUTE>` — the same
 *      transport as the `/plugins/dsh-plugin-roundtable/state` snapshot route,
 *      which is what the browser actually uses.
 *
 * @returns the dispatch function, so the caller can mount it on a web route.
 */
export function registerRpc(ctx: Context, runtime: RoundTableRuntime): RpcDispatch {
  // 启动时自检声明表（重复、缺说明、global 却要求闸门…）。
  // 只记日志不阻断：这类问题不该让整个插件不可用，但必须看得见。
  const declarationProblems = auditEndpointDeclarations()
  if (declarationProblems.length > 0) {
    ctx.logger.warn(`roundtable: rpc endpoint declarations need attention:\n  - ${declarationProblems.join('\n  - ')}`)
  }

  const dispatch: RpcDispatch = async (endpoint, payload) => {
    try {
      switch (endpoint) {
          case 'roundtable/prefs.get': {
            const prefs = runtime.prefs.get()
            return ok<RoundTablePreferences>({
              defaultMode: prefs.defaultMode,
              maxRounds: prefs.maxRounds,
              maxTokens: prefs.maxTokens,
              showAllMeetings: prefs.showAllMeetings,
              expertMaxTokens: prefs.expertMaxTokens ?? 0,
              expertMaxOpinions: prefs.expertMaxOpinions ?? 0,
              feedbackEnabled: prefs.feedbackEnabled ?? true,
              skillDelivery: prefs.skillDelivery === 'direct' ? 'direct' : 'relay',
              hiddenPanels: sanitizeHiddenPanels(prefs.hiddenPanels),
              legendHidden: prefs.legendHidden === true,
              sidebarEntryEnabled: prefs.sidebarEntryEnabled ?? true,
              conversationTabEnabled: prefs.conversationTabEnabled ?? true,
              rolePresets: sanitizeRolePresets(prefs.rolePresets),
              squads: sanitizeSquads(prefs.squads),
            })
          }
          case 'roundtable/prefs.set': {
            const patch = payload as Partial<RoundTablePreferences> | undefined
            if (patch === undefined || typeof patch !== 'object' || patch === null) {
              return fail('payload must be a preferences patch object')
            }
            // 写入前先净化：坏数据不落库（schemastery 不会替我们拦）。
            // preferences.ts 的 normalizePreferences 同时承担"只覆盖出现过的字段"
            // 这层语义 —— 与旧宿主 `SettingsScope.update(patch)` 的行为一致。
            const sanitized: Record<string, unknown> = { ...patch }
            if (patch.hiddenPanels !== undefined) sanitized.hiddenPanels = sanitizeHiddenPanels(patch.hiddenPanels)
            if (patch.legendHidden !== undefined) sanitized.legendHidden = patch.legendHidden === true
            if (patch.rolePresets !== undefined) sanitized.rolePresets = sanitizeRolePresets(patch.rolePresets)
            if (patch.squads !== undefined) sanitized.squads = sanitizeSquads(patch.squads)
            const next = await runtime.prefs.update(sanitized)
            return ok<RoundTablePreferences>({
              defaultMode: next.defaultMode,
              maxRounds: next.maxRounds,
              maxTokens: next.maxTokens,
              showAllMeetings: next.showAllMeetings,
              expertMaxTokens: next.expertMaxTokens ?? 0,
              expertMaxOpinions: next.expertMaxOpinions ?? 0,
              feedbackEnabled: next.feedbackEnabled ?? true,
              skillDelivery: next.skillDelivery === 'direct' ? 'direct' : 'relay',
              hiddenPanels: sanitizeHiddenPanels(next.hiddenPanels),
              legendHidden: next.legendHidden === true,
              sidebarEntryEnabled: next.sidebarEntryEnabled ?? true,
              conversationTabEnabled: next.conversationTabEnabled ?? true,
              rolePresets: sanitizeRolePresets(next.rolePresets),
              squads: sanitizeSquads(next.squads),
            })
          }
          case 'roundtable/edge.set': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown; direction?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            // 客户端知道这场会议属于哪个工作区；带上它，RPC 就不会在同名会议
            // 跨工作区时改错对象（M8）。
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId, direction }')
            const directionRaw = typeof body?.direction === 'string' ? body.direction : ''
            if (directionRaw !== 'forward' && directionRaw !== 'bidirectional') {
              return fail('direction must be "forward" or "bidirectional"')
            }
            const direction: EdgeDirection = directionRaw
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ direction: string }>(`meeting "${meetingId}" not found`)
              const edge = meeting.edges.find((candidate) => candidate.id === edgeId)
              if (edge === undefined) return fail<{ direction: string }>(`edge "${edgeId}" not found`)
              edge.direction = direction
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok<{ direction: string }>({ direction: edge.direction })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/edge.add': {
            const body = payload as { meetingId?: unknown; from?: unknown; to?: unknown; direction?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            const from = typeof body?.from === 'string' ? body.from.trim() : ''
            const to = typeof body?.to === 'string' ? body.to.trim() : ''
            if (meetingId === '' || from === '' || to === '') return fail('payload must be { meetingId, from, to, direction }')
            const direction: EdgeDirection = body?.direction === 'bidirectional' ? 'bidirectional' : 'forward'
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<Record<string, string>>(`meeting "${meetingId}" not found`)
              const valid = (key: string): boolean => key === 'captain' || key === 'aggregator'
                || meeting.nodes.some((node) => node.key === key && node.status !== 'removed')
              if (!valid(from)) return fail<Record<string, string>>(`unknown endpoint "${from}"`)
              if (!valid(to)) return fail<Record<string, string>>(`unknown endpoint "${to}"`)
              if (from === to) return fail<Record<string, string>>('an edge cannot connect a participant to itself')
              if (meeting.edges.some((edge) => edge.from === from && edge.to === to)) {
                return fail<Record<string, string>>(`channel ${from} → ${to} already exists`)
              }
              const edge = { id: randomUUID(), from, to, direction, createdAt: Date.now() }
              meeting.edges.push(edge)
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok({ edgeId: edge.id, from: edge.from, to: edge.to, direction: edge.direction })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/edge.remove': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ removed: boolean }>(`meeting "${meetingId}" not found`)
              const before = meeting.edges.length
              meeting.edges = meeting.edges.filter((edge) => edge.id !== edgeId)
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok({ removed: before !== meeting.edges.length })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/meeting.delete': {
            const body = payload as { meetingId?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return ok({ deleted: false })
              // Best-effort: interrupt the meeting's expert subagents first so
              // no orphan keeps running after the meeting is gone. 优先用不依赖
              // live 父 Agent 的入口 —— 删会议时队长常常已经不在线，而
              // `agents.interrupt` 那时只是静默 no-op。
              for (const node of meeting.nodes) {
                if (node.id === '') continue
                if (interruptNodeByParent(ctx, node.id, meeting.captainSessionId)) continue
                const agents = (ctx as unknown as { agents?: { interrupt?: (id: string) => unknown } }).agents
                try { agents?.interrupt?.(node.id) } catch { /* best-effort */ }
              }
              await rm(meetingDirOf(stateRoot, meetingId), { recursive: true, force: true })
              return ok({ deleted: true })
            })
          }
          case 'roundtable/user-actions.append': {
            // The Web UI records an expert edit here instead of touching
            // meeting state; the captain drains the file next round.
            const body = payload as {
              meetingId?: unknown
              kind?: unknown
              nodeKey?: unknown
              role?: unknown
              provider?: unknown
              model?: unknown
              text?: unknown
              workspace?: unknown
            } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            const kindRaw = typeof body?.kind === 'string' ? body.kind : ''
            if (meetingId === '' || (kindRaw !== 'add-node' && kindRaw !== 'remove-node' && kindRaw !== 'kb-path' && kindRaw !== 'other')) {
              return fail('payload must be { meetingId, kind, text } with kind in add-node|remove-node|kb-path|other')
            }
            const text = typeof body?.text === 'string' ? body.text.trim() : ''
            if (text === '') return fail('payload must include a non-empty text sentence')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const action: UserAction = {
                id: randomUUID(),
                ts: Date.now(),
                kind: kindRaw as UserAction['kind'],
                nodeKey: typeof body?.nodeKey === 'string' && body.nodeKey.trim() !== '' ? body.nodeKey.trim() : undefined,
                role: typeof body?.role === 'string' && body.role.trim() !== '' ? body.role.trim() : undefined,
                provider: typeof body?.provider === 'string' && body.provider.trim() !== '' ? body.provider.trim() : undefined,
                model: typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : undefined,
                text,
              }
              await appendUserAction(stateRoot, meetingId, action)
              return ok({ id: action.id })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/user-actions.list': {
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              return ok<UserAction[]>(await readUserActions(stateRoot, meetingId))
            })
          }
          case 'roundtable/models.list': {
            // Model dropdown for the expert-management UI: every registered
            // provider route plus the models it advertises (advisory catalog).
            const llm = ctx.get('llm') as
              | {
                  listProviders(): { id: string; name: string }[]
                  listModels(provider: string): Promise<{ id: string; name: string }[]>
                }
              | undefined
            if (llm === undefined) return ok({ providers: [] })
            const providers: { id: string; name: string; models: { id: string; name: string }[] }[] = []
            for (const provider of llm.listProviders()) {
              let models: { id: string; name: string }[] = []
              try {
                models = await llm.listModels(provider.id)
              } catch {
                // A provider may fail to enumerate its catalog (e.g. missing
                // key); it still appears with an empty model list so the UI
                // stays usable.
                models = []
              }
              providers.push({
                id: provider.id,
                name: provider.name,
                models: models.map((model) => ({ id: model.id, name: model.name })),
              })
            }
            return ok({ providers })
          }
          case 'roundtable/kb.path.set': {
            // Knowledge-base path (阅览版): validated, stored on the meeting,
            // never reads file contents. Relative paths resolve against the
            // meeting's own workspace.
            const body = payload as { meetingId?: unknown; path?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const raw = typeof body?.path === 'string' ? body.path.trim() : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            if (meetingId === '' || raw === '') return fail('payload must be { meetingId, path }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const workspace = dirname(stateRoot)
              // 用 `resolve` 而不是 `join`：`join` 只拼接、不折叠 `..`，相对路径
              // 会带着未规范化的 `../` 一路往下传；`resolve` 折叠成真实路径，行为
              // 可预期。**绝对路径照原样接受** —— 设置页文案与工具参数本来就允许
              // 用户填任意目录（"一切以用户为主"）。
              const resolved = isAbsolute(raw) ? raw : resolve(workspace, raw)
              let info
              try {
                info = await stat(resolved)
              } catch {
                // 只回显用户输入，不回显服务端绝对路径：错误信息会走浏览器。
                return fail<{ path: string }>(`path not found or unreadable: ${raw}`)
              }
              if (!info.isDirectory()) return fail<{ path: string }>(`path is not a directory: ${raw}`)
              meeting.kbPath = resolved
              await writeMeeting(stateRoot, meeting)
              return ok({ path: resolved })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/kb.list': {
            // List the first level of the configured knowledge base (names,
            // kinds, formats and sizes only — the browse-only contract).
            const body = payload as { meetingId?: unknown; workspace?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const preferredWorkspace = typeof body?.workspace === 'string' && body.workspace.trim() !== ''
              ? body.workspace.trim()
              : undefined
            if (meetingId === '') return fail('payload must be { meetingId }')
            // 闸门与 kb.path.set 对称：已结束/归档会议不该再被枚举目录。
            // 早先这里漏了 `{ requireActive: true }`——其余 5 个变更端点都带，
            // 只有它没有，是"闸门靠每个 case 手抄"的直接后果（H5）。
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const configured = meeting.kbPath ?? ''
              if (configured === '') return ok({ path: '', configured: false, error: '', files: [] })
              const listing = await listKbDirectory(configured)
              return ok({ path: configured, configured: true, error: listing.error, files: listing.files })
            }, { requireActive: true, ...(preferredWorkspace === undefined ? {} : { preferredWorkspace }) })
          }
          case 'roundtable/review.get': {
            // 针锋相对评审状态：前端评审弹窗轮询此接口。
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              const review = await readReview(stateRoot, meetingId)
              return ok({ review: review ?? null })
            })
          }
          case 'roundtable/review.endorse': {
            // V0.2.1 兼容别名：映射到三态 setStatus('endorsed')。
            const body = payload as { meetingId?: unknown; viewpointId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const viewpointId = typeof body?.viewpointId === 'string' ? body.viewpointId : ''
            if (meetingId === '' || viewpointId === '') return fail('payload must be { meetingId, viewpointId }')
            return applyViewpointStatus(runtime, meetingId, viewpointId, 'endorsed')
          }
          case 'roundtable/review.setStatus': {
            // V0.2.2 三态：pending/endorsed/rejected 可互切（支持可取消、驳回）。
            // 驳回必填理由（C2）：payload.reject_reason 非空，由 setViewpointStatus 强制。
            const body = payload as { meetingId?: unknown; viewpointId?: unknown; status?: unknown; reject_reason?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const viewpointId = typeof body?.viewpointId === 'string' ? body.viewpointId : ''
            const status = body?.status
            if (meetingId === '' || viewpointId === '') return fail('payload must be { meetingId, viewpointId, status }')
            if (status !== 'pending' && status !== 'endorsed' && status !== 'rejected') {
              return fail('status must be "pending" | "endorsed" | "rejected"')
            }
            const rejectReason = typeof body?.reject_reason === 'string' ? body.reject_reason : undefined
            if (status === 'rejected' && (rejectReason === undefined || rejectReason.trim() === '')) {
              return fail('rejecting a viewpoint requires a non-empty reject_reason (驳回必填理由)')
            }
            return applyViewpointStatus(runtime, meetingId, viewpointId, status, rejectReason)
          }
          case 'roundtable/feedback.append': {
            // E1/E3 匿名反馈：前端在会议结束后询问，条目写工作区级 feedback.jsonl。
            const body = payload as {
              meetingId?: unknown
              mode?: unknown
              providers?: unknown
              models?: unknown
              usedRounds?: unknown
              usedTokens?: unknown
              rating?: unknown
              note?: unknown
            } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const mode = typeof body?.mode === 'string' ? body.mode : ''
            if (meetingId === '' || mode === '') return fail('payload must be { meetingId, mode, rating, ... }')
            const ratingRaw = typeof body?.rating === 'string' ? body.rating : ''
            if (ratingRaw !== 'good' && ratingRaw !== 'meh' && ratingRaw !== 'bad') {
              return fail('rating must be "good" | "meh" | "bad"')
            }
            const asStringList = (value: unknown): string[] =>
              Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
            const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : ''
            const entry: FeedbackEntry = {
              id: randomUUID(),
              ts: Date.now(),
              meetingId,
              mode,
              providers: asStringList(body?.providers),
              models: asStringList(body?.models),
              usedRounds: typeof body?.usedRounds === 'number' ? Math.max(0, Math.floor(body.usedRounds)) : 0,
              usedTokens: typeof body?.usedTokens === 'number' ? Math.max(0, Math.floor(body.usedTokens)) : 0,
              rating: ratingRaw,
              note: note === '' ? undefined : note,
            }
            return withMeetingRpcLock(runtime, meetingId, async (stateRoot) => {
              // 先清掉该会议的历史条目再追加（同一会议只保留最新一条反馈）。
              await clearFeedbackForMeeting(stateRoot, meetingId)
              await appendFeedback(stateRoot, entry)
              return ok({ id: entry.id })
            })
          }
          case 'roundtable/feedback.list': {
            const body = payload as { workspace?: unknown } | undefined
            const workspace = typeof body?.workspace === 'string' ? body.workspace : ''
            const roots = await feedbackStateRoots(runtime, workspace)
            const entries: FeedbackEntry[] = []
            for (const stateRoot of roots) {
              entries.push(...await readFeedback(stateRoot))
            }
            entries.sort((a, b) => b.ts - a.ts)
            return ok({ entries: entries.slice(0, 200) })
          }
          case 'roundtable/feedback.clear': {
            const body = payload as { workspace?: unknown } | undefined
            const workspace = typeof body?.workspace === 'string' ? body.workspace : ''
            const roots = await feedbackStateRoots(runtime, workspace)
            let cleared = 0
            for (const stateRoot of roots) {
              cleared += await clearFeedback(stateRoot)
            }
            return ok({ cleared })
          }
          default:
            return fail(`unknown endpoint: ${endpoint}`)
        }
    } catch (error: unknown) {
      // HTTP 回退路由必须"永不抛"，否则 webServer 会以 400 收场、客户端只能
      // 看到 fetch 失败而不是真正的错误信息。
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 闸门守卫：把"端点声明"与"实现是否真加闸门"对账。
   *
   * 这一层挡的是 H5 那类事故 —— `kb.list` 漏了 `{ requireActive: true }`，
   * 而漏写**不会有任何报错**，只有人工比对才能发现。现在：
   *   - 端点未在 `rpc-endpoints.ts` 登记 → 拒绝（强制登记）；
   *   - 声明为"要求 active 的会议写入"但实现没传 → 拒绝并说明原因。
   *
   * 已知局限：`passedRequireActive` 由下表**人工维护**，不是从实现里自动提取
   * （自动提取需要把 switch 拆成 handler 表，那是更大的重构）。
   * 所以这张表的价值在于"改实现时必须同步改这里"，而不是全自动保证。
   */
  const ACTIVE_GATED: ReadonlySet<string> = new Set([
    'roundtable/edge.add',
    'roundtable/edge.set',
    'roundtable/edge.remove',
    'roundtable/user-actions.append',
    'roundtable/kb.path.set',
    'roundtable/kb.list',
  ])

  /**
   * 带守卫的 dispatch（对外暴露的就是它）。
   *
   * 未登记的端点直接拒绝；声明与实现不一致时拒绝并给出明确原因，
   * 而不是让它静默跑到一个没有闸门的实现里。
   */
  const guardedDispatch: RpcDispatch = async (endpoint, payload) => {
    const gateProblem = checkEndpointGate(endpoint, ACTIVE_GATED.has(endpoint))
    if (gateProblem !== undefined) {
      // 未登记端点：交给下方 dispatch 统一回 "unknown endpoint"，
      // 避免把内部实现细节暴露给浏览器。
      if (!ENDPOINT_INDEX.has(endpoint)) return dispatch(endpoint, payload)
      ctx.logger.warn(`roundtable: refusing rpc "${endpoint}": ${gateProblem}`)
      return fail(`endpoint "${endpoint}" is misconfigured on the host side (gate declaration mismatch)`)
    }
    return dispatch(endpoint, payload)
  }

  // Transport 1: the host's generic connection channel (compatibility path).
  // Two arguments only: the 0.1.1-era `{ authority: 'trusted-host' }` trust
  // policy was removed from `connection.rpc.handle` — 0.1.5 declares
  // `handle(channel, handler) => disposer`. Historical note: back then,
  // omitting the option made host registration throw ("options.authority" read
  // on undefined), the channel never mounted, and every browser RPC failed with
  // "无法连接会议服务". That failure mode is gone; passing the extra object
  // today is silently ignored, which is exactly why it went unnoticed until
  // v0.2.21 aligned this shim with the real signature.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection as unknown as RpcConnection
    const disposer: unknown = connection.rpc.handle('/roundtable', guardedDispatch)
    // `connection.rpc.handle` 的返回值形状随 rc 线变过（disposer / undefined /
    // Promise）。形状判定收在 harness-compat 里：不是函数时不注册清理器，
    // 免得多挂一个永远不执行的 effect。
    effectWithOptionalDisposer(connectionCtx, disposer, 'roundtable: rpc channel')
  })
  return guardedDispatch
}

/** One knowledge-base directory entry (阅览版: name/kind/format/size only). */
export interface KbEntry {
  name: string
  kind: 'file' | 'dir'
  /** Lowercased extension without the dot (empty for directories). */
  ext: string
  size: number
  mtimeMs: number
}

/**
 * Resolve the state roots whose feedback.jsonl should be read/cleared:
 * every known workspace candidate (optionally narrowed to one named
 * workspace). A candidate whose state root directory does not exist yet
 * contributes nothing.
 */
async function feedbackStateRoots(runtime: RoundTableRuntime, workspaceName?: string): Promise<string[]> {
  const { workspaceCandidates } = await import('./workspace-candidates.ts')
  const { stat } = await import('node:fs/promises')
  const candidates = workspaceCandidates()
    .filter((candidate) => workspaceName === undefined || candidate.title === workspaceName)
  const roots: string[] = []
  for (const candidate of candidates) {
    const root = stateRootOf(candidate.path, runtime.stateDir)
    try {
      const info = await stat(root)
      if (info.isDirectory()) roots.push(root)
    } catch {
      // Directory not created yet: skip.
    }
  }
  return roots
}

/**
 * List the first level of a knowledge-base directory (browse-only): skips
 * dot-hidden entries, caps the result at 300 items so a huge folder cannot
 * blow up the UI, and tolerates per-entry stat failures.
 */
export async function listKbDirectory(dir: string): Promise<{ error: string; files: KbEntry[] }> {
  let info
  try {
    info = await stat(dir)
  } catch {
    return { error: 'path not found or unreadable', files: [] }
  }
  if (!info.isDirectory()) return { error: 'not a directory', files: [] }
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { error: 'directory unreadable', files: [] }
  }
  const files: KbEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    let size = 0
    let mtimeMs = 0
    try {
      const entryStat = await stat(full)
      size = entryStat.size
      mtimeMs = entryStat.mtimeMs
    } catch {
      // Best-effort: an entry that vanished mid-listing still shows its name.
    }
    files.push({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
      ext: entry.isDirectory() ? '' : extname(entry.name).replace(/^\./, '').toLowerCase(),
      size,
      mtimeMs,
    })
    if (files.length >= 300) break
  }
  return { error: '', files }
}
