/**
 * Meeting budget: round/token caps and the mute (闭麦) gate.
 * @module dsh-plugin-roundtable/budget
 */

import type { Meeting } from './types.ts'

/** Which budget axis is exceeded, if any. */
export function budgetExceeded(meeting: Meeting): 'rounds' | 'tokens' | undefined {
  if (meeting.round >= meeting.budget.maxRounds) return 'rounds'
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

/** Mutate the meeting: apply the mute gate and reject terminal meetings. */
export function ensureActive(meeting: Meeting): void {
  if (meeting.status === 'ended' || meeting.status === 'archived') {
    throw new MeetingEndedError(meeting.id)
  }
  const exceeded = budgetExceeded(meeting)
  if (exceeded !== undefined && meeting.status !== 'muted') {
    meeting.status = 'muted'
  }
  if (meeting.status === 'muted') {
    const axis = budgetExceeded(meeting)
    if (axis !== undefined) throw new MeetingMutedError(meeting.id, axis)
  }
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
