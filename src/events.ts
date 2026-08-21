/**
 * Durable session events for meeting lifecycle, appended to the captain's
 * session log for audit/replay. The events are merge-extensible additions to
 * the session event map.
 * @module dsh-plugin-roundtable/events
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'roundtable/meeting-created': {
      meetingId: string
      meetingName: string
      mode: string
    }
    'roundtable/node-added': {
      meetingId: string
      nodeKey: string
      nodeId: string
    }
    'roundtable/node-removed': {
      meetingId: string
      nodeKey: string
    }
    'roundtable/edge-set': {
      meetingId: string
      from: string
      to: string
      direction: string
    }
    'roundtable/decision-requested': {
      meetingId: string
      decisionId: string
    }
    'roundtable/decision-resolved': {
      meetingId: string
      decisionId: string
    }
    'roundtable/meeting-closed': {
      meetingId: string
    }
  }
}

/** The full roundtable event names. */
export type RoundTableEventName =
  | 'roundtable/meeting-created'
  | 'roundtable/node-added'
  | 'roundtable/node-removed'
  | 'roundtable/edge-set'
  | 'roundtable/decision-requested'
  | 'roundtable/decision-resolved'
  | 'roundtable/meeting-closed'

/** Session slice exposing the append method for typed event emission. */
interface SessionAppender {
  append: (type: string, data: unknown) => void
}

/** Append one meeting event into the captain's session (best effort). */
export function appendMeetingEvent(
  captain: Pick<Agent, 'session'>,
  type: RoundTableEventName,
  data: unknown,
): void {
  try {
    ;(captain.session as unknown as SessionAppender).append(type, data)
  } catch {
    // Event logging is best effort; state files remain the truth source.
  }
}
