/**
 * 真实用量读取（第 3 批）。
 *
 * 背景：`meeting.budget.usedTokens` 只累加**发言文本**的粗估（≈0.6 token/字），
 * 不含 system prompt、专家 persona、历史上下文与工具调用开销。真实会议数据
 * 里，它 7/7 场与"逐条发言文本估算"完全相等，而主持人自己的发言就吃掉
 * 38.9%（某一场达 73.4%）—— 用户设 200k，专家实际能用的远不到一半。v0.2.35
 * 只补了 UI 标注（"不是真实账单"），根因未修。
 *
 * 宿主其实有精确的 provider 上报值：
 * - `ctx.sessionProjections.snapshot(session, ['tokenUsage'])` 的
 *   `tokenUsage` 由每个 assistant settlement 的 usage 采样累加而来
 *   （`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` /
 *   `cacheWriteTokens`，四桶互不重叠）；
 * - `Agent.session` 是拿到 `Session` 的现成入口（`tools.ts` 早已在用
 *   `agent.session.header.cwd`）。
 *
 * **明确否定的一条**：`ctx.subagents.sendMessage` / `startContinuable` 的返回值
 * 都不带 usage，`SubagentResult` / `SubagentRunEndInfo` 也没有 —— 想接真实用量
 * 只能走"子会话的 session"这条路。
 *
 * 本模块只读、不写状态：把真实值作为 `roundtable_status` 的派生输出，而不是
 * 新落一个半成品字段（否则又是"定义了却没人用"的账）。冷会话（进程重启后的
 * 旧节点）取不到值 —— 宁可标注"不可测"，也不拿估算冒充实测。
 *
 * @module dsh-plugin-roundtable/token-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Provider-reported cumulative usage of one session. */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Sum of the four disjoint buckets. */
  total: number
}

/** Provider-anchored context occupancy of one session. */
export interface SessionPressure {
  /** Prompt size of the most recent request (uncached input + cache read/write). */
  pressureTokens: number
  /** What the NEXT request's prompt would cost. */
  projectedTokens: number
  /** Newest known route capacity (0 = adapter advertised none). */
  contextWindow: number
}

/** How many expert sessions could be measured for one meeting. */
export interface MeetingRealUsage {
  /** Sum of measured session totals. */
  measuredTotal: number
  /** Sessions that produced a provider-reported figure. */
  measuredSessions: number
  /** Child sessions that exist but could not be measured (cold / not live). */
  unmeasuredSessions: number
}

/** Structural read face of the host projection service. */
interface ProjectionReadFace {
  snapshot(session: unknown, keys?: readonly string[]): { values?: unknown } | undefined
}

function countOf(raw: Record<string, unknown>, key: string): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

/** Coerce one projection value into a {@link SessionUsage}; undefined when empty. */
export function normalizeUsage(value: unknown): SessionUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const inputTokens = countOf(raw, 'uncachedInputTokens')
  const outputTokens = countOf(raw, 'outputTokens')
  const cacheReadTokens = countOf(raw, 'cacheReadTokens')
  const cacheWriteTokens = countOf(raw, 'cacheWriteTokens')
  const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  if (total === 0) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, total }
}

/** Coerce one projection value into a {@link SessionPressure}; undefined when empty. */
export function normalizePressure(value: unknown): SessionPressure | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const pressureTokens = countOf(raw, 'pressureTokens')
  const projectedTokens = countOf(raw, 'projectedTokens')
  const contextWindow = countOf(raw, 'contextWindow')
  if (pressureTokens === 0 && projectedTokens === 0 && contextWindow === 0) return undefined
  return { pressureTokens, projectedTokens, contextWindow }
}

/**
 * Read the projection values of one LIVE session.
 *
 * Returns `undefined` — never throws — when the agent is not live, the
 * projection service is unmounted, or the host shape differs: measuring cost is
 * an observation, and it must never be able to break `roundtable_status`.
 */
function projectionValuesOf(ctx: Context, sessionId: string): Record<string, unknown> | undefined {
  if (sessionId === '') return undefined
  try {
    const agent = ctx.agents.get(sessionId as SessionId)
    const session = (agent as { session?: unknown } | undefined)?.session
    if (session === undefined || session === null) return undefined
    const projections = ctx.get('sessionProjections') as ProjectionReadFace | undefined
    if (projections === undefined || typeof projections.snapshot !== 'function') return undefined
    const snapshot = projections.snapshot(session, ['tokenUsage', 'contextPressure'])
    const values = snapshot?.values
    if (values === null || typeof values !== 'object') return undefined
    return values as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Provider-reported usage of one live session (undefined when unavailable). */
export function liveSessionUsage(ctx: Context, sessionId: string): SessionUsage | undefined {
  return normalizeUsage(projectionValuesOf(ctx, sessionId)?.tokenUsage)
}

/** Provider-anchored pressure of one live session (undefined when unavailable). */
export function liveSessionPressure(ctx: Context, sessionId: string): SessionPressure | undefined {
  return normalizePressure(projectionValuesOf(ctx, sessionId)?.contextPressure)
}

/**
 * Sum real usage across one meeting's expert child sessions.
 *
 * Each distinct session is measured once; ids that no longer resolve to a live
 * agent are counted as `unmeasuredSessions` so the caller can say "3 of 5
 * measured" instead of silently reporting a too-small total.
 */
export function meetingRealUsage(ctx: Context, sessionIds: readonly string[]): MeetingRealUsage {
  const seen = new Set<string>()
  let measuredTotal = 0
  let measuredSessions = 0
  let unmeasuredSessions = 0
  for (const id of sessionIds) {
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const usage = liveSessionUsage(ctx, id)
    if (usage === undefined) {
      unmeasuredSessions += 1
      continue
    }
    measuredTotal += usage.total
    measuredSessions += 1
  }
  return { measuredTotal, measuredSessions, unmeasuredSessions }
}
