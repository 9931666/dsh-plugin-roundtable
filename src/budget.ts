/**
 * Meeting budget: round/token caps and the mute (闭麦) gate.
 * @module dsh-plugin-roundtable/budget
 */

import type { Meeting } from './types.ts'

/** Which budget axis is exceeded, if any. */
export function budgetExceeded(meeting: Meeting): 'rounds' | 'tokens' | undefined {
  // 设 N 轮就能开 N 轮：`round` 是"已开启的轮次"，只有想开第 N+1 轮时才触顶。
  // （旧口径 `>=` 会让 maxRounds=10 实际只能开 9 轮——对面向用户的设置项不直觉。）
  if (meeting.round > meeting.budget.maxRounds) return 'rounds'
  if (meeting.budget.usedTokens >= meeting.budget.maxTokens) return 'tokens'
  return undefined
}

/** Error when the meeting has ended. */
export class MeetingEndedError extends Error {
  constructor(meetingId: string) {
    super(`roundtable: meeting "${meetingId}" has ended — start a new meeting`)
    this.name = 'MeetingEndedError'
  }
}

/** Error when the meeting is muted (闭麦) on a budget axis. */
export class MeetingMutedError extends Error {
  readonly axis: 'rounds' | 'tokens'
  constructor(meetingId: string, axis: 'rounds' | 'tokens') {
    super(
      `roundtable: meeting "${meetingId}" is muted on ${axis} — the captain may top up the budget with roundtable_set_budget or close the meeting`,
    )
    this.name = 'MeetingMutedError'
    this.axis = axis
  }
}

/**
 * Gate a write against the meeting's status and budget WITHOUT mutating it.
 *
 * The previous `ensureActive` both flipped `status` to `'muted'` and then threw
 * on the same call. Because the throw happened before the caller could persist
 * anything, `muted` never reached disk, and the very tools meant to resolve the
 * situation (`roundtable_set_budget`, `roundtable_close`, the two exporters)
 * were rejected by that same gate — a meeting that had spent its budget stayed
 * `active` forever while refusing every action.
 *
 * @param meeting - meeting to test.
 * @param options.allowMuted - resolve/escalate paths (top up the budget, close,
 *   export, clear the user-action queue) stay reachable while muted; everything
 *   that produces new work still throws.
 */
export function assertUsable(meeting: Meeting, options: { allowMuted?: boolean } = {}): void {
  if (meeting.status === 'ended' || meeting.status === 'archived') {
    throw new MeetingEndedError(meeting.id)
  }
  if (options.allowMuted === true) return
  const axis = budgetExceeded(meeting)
  if (axis !== undefined) throw new MeetingMutedError(meeting.id, axis)
}

/**
 * Persist the fact that the meeting is out of budget.
 *
 * @param meeting - meeting mutated in place.
 * @returns true when the status just became `'muted'`, in which case the caller
 *   owns writing the meeting back so the mute is actually observable.
 */
export function markMuted(meeting: Meeting): boolean {
  if (meeting.status !== 'active') return false
  if (budgetExceeded(meeting) === undefined) return false
  meeting.status = 'muted'
  return true
}

/** Estimate the token cost of a text (coarse: ~0.6 tokens per CJK char, ~0.3 per latin). */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) cjk += 1
    else if (char.trim() !== '') other += 1
  }
  return Math.ceil(cjk * 0.6 + other * 0.3)
}

/** Advance the meeting round and return the new round number. */
export function beginRound(meeting: Meeting): number {
  meeting.round += 1
  meeting.budget.usedRounds = meeting.round
  return meeting.round
}
