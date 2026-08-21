/**
 * Web snapshot collection: reads the disk truth under every workspace's
 * state root and merges live node activity. The browser topology tab polls
 * `/plugins/dsh-plugin-roundtable/state` for this.
 * @module dsh-plugin-roundtable/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { listMeetings, readMeeting, readTranscript } from './state.ts'
import { aggregateUtterances } from './aggregator.ts'
import { ACTIVE_NODE_STATUSES } from './types.ts'

/** One meeting snapshot for the Web UI. */
export interface MeetingSnapshot {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  budget: {
    maxRounds: number
    maxTokens: number
    usedRounds: number
    usedTokens: number
  }
  nodes: {
    id: string
    key: string
    role: string
    provider: string
    model: string
    status: string
    activity: string
  }[]
  edges: {
    id: string
    from: string
    to: string
    direction: string
  }[]
  pendingDecisions: {
    id: string
    question: string
    options: string[]
  }[]
  digest: string
}

/** Collect snapshots across state roots, optionally filtered by captain session. */
export async function collectMeetingSnapshots(
  ctx: Context,
  roots: readonly { workspace: string; stateRoot: string }[],
  sessionFilter?: string,
): Promise<MeetingSnapshot[]> {
  const snapshots: MeetingSnapshot[] = []
  for (const root of roots) {
    for (const meetingId of await listMeetings(root.stateRoot)) {
      const meeting = await readMeeting(root.stateRoot, meetingId)
      if (meeting === undefined) continue
      if (sessionFilter !== undefined && meeting.captainSessionId !== sessionFilter) continue
      const utterances = await readTranscript(root.stateRoot, meetingId)
      snapshots.push({
        id: meeting.id,
        name: meeting.name,
        goal: meeting.goal,
        mode: meeting.mode,
        status: meeting.status,
        round: meeting.round,
        workspace: root.workspace,
        budget: {
          maxRounds: meeting.budget.maxRounds,
          maxTokens: meeting.budget.maxTokens,
          usedRounds: meeting.budget.usedRounds,
          usedTokens: meeting.budget.usedTokens,
        },
        nodes: meeting.nodes
          .filter((node) => node.status !== 'removed')
          .map((node) => {
            let activity = 'unspawned'
            if (node.id !== '' && ACTIVE_NODE_STATUSES.includes(node.status)) {
              const live = ctx.agents.get(node.id as SessionId)
              activity = live === undefined ? 'ready' : live.status
            }
            return {
              id: node.id,
              key: node.key,
              role: node.role ?? '',
              provider: node.provider ?? '',
              model: node.model ?? '',
              status: node.status,
              activity,
            }
          }),
        edges: meeting.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          direction: edge.direction,
        })),
        pendingDecisions: meeting.decisions
          .filter((decision) => decision.status === 'pending')
          .map((decision) => ({ id: decision.id, question: decision.question, options: decision.options })),
        digest: aggregateUtterances(utterances),
      })
    }
  }
  return snapshots
}
