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
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import type { Meeting, MeetingUtterance } from './types.ts'

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
  messages: {
    id: string
    from: string
    to: string
    ts: number
  }[]
  recent: {
    id: string
    from: string
    to: string
    text: string
    ts: number
    round: number
  }[]
}

/** Orchestrated meetings show an implicit star topology even before the
 * captain wires explicit edges: captain ⇄ each node, each node → aggregator.
 *
 * Real edges (the ones the user drags) are always included AND the synthetic
 * skeleton is kept as a faded backdrop for any pair not explicitly wired, so
 * dragging a new channel never makes the whole topology jump/vanish — the
 * user sees their wire land on top of a stable skeleton instead of the
 * skeleton disappearing the moment they add one edge.
 */
function synthesizedEdges(meeting: Meeting): MeetingSnapshot['edges'] {
  const real = meeting.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    direction: edge.direction,
  }))
  if (meeting.mode !== 'orchestrated') return real
  const covered = new Set(real.flatMap((edge) => [`${edge.from}→${edge.to}`, `${edge.to}→${edge.from}`]))
  const out: MeetingSnapshot['edges'] = [...real]
  for (const node of meeting.nodes) {
    if (node.status === 'removed') continue
    if (!covered.has(`${CAPTAIN_KEY}→${node.key}`)) {
      out.push({ id: `synthetic:${CAPTAIN_KEY}:${node.key}`, from: CAPTAIN_KEY, to: node.key, direction: 'bidirectional' })
    }
    if (!covered.has(`${node.key}→${AGGREGATOR_KEY}`)) {
      out.push({ id: `synthetic:${node.key}:${AGGREGATOR_KEY}`, from: node.key, to: AGGREGATOR_KEY, direction: 'forward' })
    }
  }
  return out
}

/** Recent directed message pulses for the flow animation (newest first). */
function recentDirectedMessages(utterances: readonly MeetingUtterance[]): MeetingSnapshot['messages'] {
  const out: MeetingSnapshot['messages'] = []
  for (let i = utterances.length - 1; i >= 0 && out.length < 8; i--) {
    const utterance = utterances[i]
    if (utterance === undefined) continue
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    out.push({
      id: utterance.id,
      from: utterance.nodeKey,
      to: utterance.to ?? AGGREGATOR_KEY,
      ts: utterance.ts,
    })
  }
  return out
}

/** One-line compaction for the sidebar timeline. */
function compactText(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/** Recent contributions for the sidebar activity log (newest first). */
function recentUtterances(utterances: readonly MeetingUtterance[]): MeetingSnapshot['recent'] {
  const out: MeetingSnapshot['recent'] = []
  for (let i = utterances.length - 1; i >= 0 && out.length < 20; i--) {
    const utterance = utterances[i]
    if (utterance === undefined) continue
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    out.push({
      id: utterance.id,
      from: utterance.nodeKey,
      to: utterance.to ?? AGGREGATOR_KEY,
      text: compactText(utterance.summary ?? utterance.content, 90),
      ts: utterance.ts,
      round: utterance.round,
    })
  }
  return out
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
        // Keep every node the meeting ever admitted, so the topology still
        // shows models that were added then removed (e.g. an expert who left).
        // A removed node renders degraded (status 'removed') instead of
        // disappearing, which would hide which models actually participated.
        nodes: meeting.nodes.map((node) => {
          let activity = 'unspawned'
          if (node.status === 'removed') {
            activity = 'removed'
          } else if (node.id !== '' && ACTIVE_NODE_STATUSES.includes(node.status)) {
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
        edges: synthesizedEdges(meeting),
        pendingDecisions: meeting.decisions
          .filter((decision) => decision.status === 'pending')
          .map((decision) => ({ id: decision.id, question: decision.question, options: decision.options })),
        digest: aggregateUtterances(utterances),
        messages: recentDirectedMessages(utterances),
        recent: recentUtterances(utterances),
      })
    }
  }
  return snapshots
}
