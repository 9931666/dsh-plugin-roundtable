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
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join } from 'node:path'
import type { EdgeDirection, UserAction } from './types.ts'
import {
  appendUserAction,
  meetingDirOf,
  readMeeting,
  readUserActions,
  stateRootOf,
  withMeetingLock,
  writeMeeting,
} from './state.ts'
import { buildCharter } from './charter.ts'

/** RPC result envelope (mirrors the apiproxy wire shape). */
export type RpcResult<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/** Wire shape of the runtime preferences. */
export interface RoundTablePreferences {
  readonly defaultMode: 'orchestrated' | 'egalitarian'
  readonly maxRounds: number
  readonly maxTokens: number
  /** 互通开关：true = 显示所有圆桌会议；false = 仅显示当前对话开启的会议。 */
  readonly showAllMeetings: boolean
}

/** Holder shared between the settings fiber and the RPC fiber. */
export interface RoundTableRuntime {
  scope: SettingsScope<RoundTablePreferences> | undefined
  stateDir: string
  /** In-memory preferences used when the settings scope is not mounted. */
  fallbackPrefs: RoundTablePreferences
}

const ENDPOINT_PREFIX = 'roundtable/'

/** Test whether one endpoint belongs to this plugin. */
export function ownsEndpoint(endpoint: string): boolean {
  return endpoint.startsWith(ENDPOINT_PREFIX)
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message } }
}

/** Connection service slice used to register this plugin's own RPC channel. */
interface RpcConnection {
  readonly rpc: {
    readonly handle: (
      channel: string,
      handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
      options?: { readonly authority: 'trusted-host' | 'loopback' },
    ) => unknown
  }
}

/** Run one edge mutation under the meeting lock, resolving its state root first. */
async function withEdgeLock<T>(
  runtime: RoundTableRuntime,
  meetingId: string,
  operation: (stateRoot: string) => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> {
  const { workspaceOfMeeting } = await import('./edge-helper.ts')
  const workspace = await workspaceOfMeeting(runtime.stateDir, meetingId)
  if (workspace === undefined) return fail(`meeting "${meetingId}" not found in any workspace`)
  const stateRoot = stateRootOf(workspace, runtime.stateDir)
  return withMeetingLock(`meeting:${stateRoot}:${meetingId}`, () => operation(stateRoot))
}

/** Register the RoundTable RPC handler on the plugin's own channel. */
export function registerRpc(ctx: Context, runtime: RoundTableRuntime): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection as unknown as RpcConnection
    connection.rpc.handle(
      '/roundtable',
      async (endpoint, payload) => {
        switch (endpoint) {
          case 'roundtable/prefs.get': {
            const prefs = runtime.scope?.get() ?? runtime.fallbackPrefs
            return ok<RoundTablePreferences>({
              defaultMode: prefs.defaultMode,
              maxRounds: prefs.maxRounds,
              maxTokens: prefs.maxTokens,
              showAllMeetings: prefs.showAllMeetings,
            })
          }
          case 'roundtable/prefs.set': {
            const patch = payload as Partial<RoundTablePreferences> | undefined
            if (patch === undefined || typeof patch !== 'object' || patch === null) {
              return fail('payload must be a preferences patch object')
            }
            if (runtime.scope === undefined) {
              // Settings not mounted: keep an in-memory fallback so the settings
              // page stays usable; persistence resumes on the next clean start.
              const base = runtime.fallbackPrefs
              const next: RoundTablePreferences = {
                defaultMode: patch.defaultMode === 'orchestrated' || patch.defaultMode === 'egalitarian' ? patch.defaultMode : base.defaultMode,
                maxRounds: typeof patch.maxRounds === 'number' && Number.isFinite(patch.maxRounds) && patch.maxRounds >= 1 ? Math.floor(patch.maxRounds) : base.maxRounds,
                maxTokens: typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens) && patch.maxTokens >= 1000 ? Math.floor(patch.maxTokens) : base.maxTokens,
                showAllMeetings: typeof patch.showAllMeetings === 'boolean' ? patch.showAllMeetings : base.showAllMeetings,
              }
              runtime.fallbackPrefs = next
              return ok<RoundTablePreferences>({
                defaultMode: next.defaultMode,
                maxRounds: next.maxRounds,
                maxTokens: next.maxTokens,
                showAllMeetings: next.showAllMeetings,
              })
            }
            await runtime.scope.update(patch as object)
            const next = runtime.scope.get()
            return ok<RoundTablePreferences>({
              defaultMode: next.defaultMode,
              maxRounds: next.maxRounds,
              maxTokens: next.maxTokens,
              showAllMeetings: next.showAllMeetings,
            })
          }
          case 'roundtable/edge.set': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown; direction?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId, direction }')
            const directionRaw = typeof body?.direction === 'string' ? body.direction : ''
            if (directionRaw !== 'forward' && directionRaw !== 'bidirectional') {
              return fail('direction must be "forward" or "bidirectional"')
            }
            const direction: EdgeDirection = directionRaw
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ direction: string }>(`meeting "${meetingId}" not found`)
              const edge = meeting.edges.find((candidate) => candidate.id === edgeId)
              if (edge === undefined) return fail<{ direction: string }>(`edge "${edgeId}" not found`)
              edge.direction = direction
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok<{ direction: string }>({ direction: edge.direction })
            })
          }
          case 'roundtable/edge.add': {
            const body = payload as { meetingId?: unknown; from?: unknown; to?: unknown; direction?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const from = typeof body?.from === 'string' ? body.from.trim() : ''
            const to = typeof body?.to === 'string' ? body.to.trim() : ''
            if (meetingId === '' || from === '' || to === '') return fail('payload must be { meetingId, from, to, direction }')
            const direction: EdgeDirection = body?.direction === 'bidirectional' ? 'bidirectional' : 'forward'
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
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
            })
          }
          case 'roundtable/edge.remove': {
            const body = payload as { meetingId?: unknown; edgeId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const edgeId = typeof body?.edgeId === 'string' ? body.edgeId : ''
            if (meetingId === '' || edgeId === '') return fail('payload must be { meetingId, edgeId }')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ removed: boolean }>(`meeting "${meetingId}" not found`)
              const before = meeting.edges.length
              meeting.edges = meeting.edges.filter((edge) => edge.id !== edgeId)
              meeting.charter = buildCharter(meeting)
              await writeMeeting(stateRoot, meeting)
              return ok({ removed: before !== meeting.edges.length })
            })
          }
          case 'roundtable/meeting.delete': {
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return ok({ deleted: false })
              // Best-effort: interrupt the meeting's expert subagents first so
              // no orphan keeps running after the meeting is gone.
              const agents = (ctx as unknown as { agents?: { interrupt?: (id: string) => unknown } }).agents
              for (const node of meeting.nodes) {
                if (node.id !== '' && agents?.interrupt !== undefined) {
                  try { agents.interrupt(node.id) } catch { /* best-effort */ }
                }
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
            } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const kindRaw = typeof body?.kind === 'string' ? body.kind : ''
            if (meetingId === '' || (kindRaw !== 'add-node' && kindRaw !== 'remove-node' && kindRaw !== 'kb-path' && kindRaw !== 'other')) {
              return fail('payload must be { meetingId, kind, text } with kind in add-node|remove-node|kb-path|other')
            }
            const text = typeof body?.text === 'string' ? body.text.trim() : ''
            if (text === '') return fail('payload must include a non-empty text sentence')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
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
            })
          }
          case 'roundtable/user-actions.list': {
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
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
            const body = payload as { meetingId?: unknown; path?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            const raw = typeof body?.path === 'string' ? body.path.trim() : ''
            if (meetingId === '' || raw === '') return fail('payload must be { meetingId, path }')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const workspace = dirname(stateRoot)
              const resolved = isAbsolute(raw) ? raw : join(workspace, raw)
              let info
              try {
                info = await stat(resolved)
              } catch {
                return fail<{ path: string }>(`path not found or unreadable: ${resolved}`)
              }
              if (!info.isDirectory()) return fail<{ path: string }>(`path is not a directory: ${resolved}`)
              meeting.kbPath = resolved
              await writeMeeting(stateRoot, meeting)
              return ok({ path: resolved })
            })
          }
          case 'roundtable/kb.list': {
            // List the first level of the configured knowledge base (names,
            // kinds, formats and sizes only — the browse-only contract).
            const body = payload as { meetingId?: unknown } | undefined
            const meetingId = typeof body?.meetingId === 'string' ? body.meetingId : ''
            if (meetingId === '') return fail('payload must be { meetingId }')
            return withEdgeLock(runtime, meetingId, async (stateRoot) => {
              const meeting = await readMeeting(stateRoot, meetingId)
              if (meeting === undefined) return fail<{ path: string }>(`meeting "${meetingId}" not found`)
              const configured = meeting.kbPath ?? ''
              if (configured === '') return ok({ path: '', configured: false, error: '', files: [] })
              const listing = await listKbDirectory(configured)
              return ok({ path: configured, configured: true, error: listing.error, files: listing.files })
            })
          }
          default:
            return fail(`unknown endpoint: ${endpoint}`)
        }
      },
      // Channel trust policy is REQUIRED — omitting it makes the host
      // registration throw ("options.authority" read on undefined), the
      // channel never mounts, and every browser RPC fails with
      // "无法连接会议服务". Mirrors the ya-subagent plugin's usage.
      { authority: 'trusted-host' as const },
    )
  })
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
