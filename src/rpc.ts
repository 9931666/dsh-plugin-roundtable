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
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { randomUUID } from 'node:crypto'
import type { EdgeDirection } from './types.ts'
import { readMeeting, stateRootOf, withMeetingLock, writeMeeting } from './state.ts'
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
              }
              runtime.fallbackPrefs = next
              return ok<RoundTablePreferences>({
                defaultMode: next.defaultMode,
                maxRounds: next.maxRounds,
                maxTokens: next.maxTokens,
              })
            }
            await runtime.scope.update(patch as object)
            const next = runtime.scope.get()
            return ok<RoundTablePreferences>({
              defaultMode: next.defaultMode,
              maxRounds: next.maxRounds,
              maxTokens: next.maxTokens,
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
