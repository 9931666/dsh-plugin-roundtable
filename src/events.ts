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

/**
 * Append one meeting event into the captain's session (best effort).
 *
 * NOTE (persistence contract): this harness's session-read path refuses to
 * interpret a log containing an event type outside its fixed
 * `KNOWN_SESSION_EVENT_TYPES` vocabulary unless the envelope carries the
 * `ignorable` marker. Out-of-repo plugin events such as `roundtable/*` are
 * outside that list by construction, and `Session.append` exposes no way to
 * set `ignorable`. Writing them therefore made a captain's history
 * unloadable ("unknown to this harness … not marked ignorable"). Meeting
 * state is already the durable truth source (`<stateDir>/<meetingId>`), so
 * these session events are deliberately no-ops: keeping the audit in the
 * state files instead of the session log preserves history compatibility
 * while losing nothing.
 */
export function appendMeetingEvent(
  _captain: Pick<Agent, 'session'>,
  _type: RoundTableEventName,
  _data: unknown,
): void {
  // Deliberate no-op: see the persistence-contract note above.
}
