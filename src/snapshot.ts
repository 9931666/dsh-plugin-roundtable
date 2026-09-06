/**
 * Web snapshot collection: reads the disk truth under every workspace's
 * state root and merges live node activity. The browser topology tab polls
 * `/plugins/dsh-plugin-roundtable/state` for this.
 * @module dsh-plugin-roundtable/snapshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { listMeetings, readMeeting, readReview, readTranscript, readUserActions } from './state.ts'
import { aggregateUtterances } from './aggregator.ts'
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import type { Meeting, MeetingNode, MeetingUtterance, UserAction } from './types.ts'

/** 按 key 去重节点列表：同名 key 多次加入（删了重建）时保留最新一条，
 *  且非 removed 优先。返回顺序 = meeting.nodes 首次出现顺序。 */
function dedupeNodesByKey(nodes: MeetingNode[]): MeetingNode[] {
  const byKey = new Map<string, MeetingNode>()
  for (const node of nodes) {
    const prev = byKey.get(node.key)
    if (prev === undefined) {
      byKey.set(node.key, node)
      continue
    }
    const prevActive = prev.status !== 'removed'
    const nodeActive = node.status !== 'removed'
    if (nodeActive !== prevActive) {
      if (nodeActive) byKey.set(node.key, node)
      continue
    }
    if ((node.joinedAt ?? 0) >= (prev.joinedAt ?? 0)) byKey.set(node.key, node)
  }
  return [...byKey.values()]
}

/** One meeting snapshot for the Web UI. */
export interface MeetingSnapshot {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  /** 主持（创建）该会议的会话 id —— 用于"来源对话"前缀与互通过滤。 */
  captainSessionId: string
  /** 知识库目录（阅览版）；空 = 未设置。 */
  kbPath: string
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
  /** Pending user actions recorded by the Web UI, awaiting the captain. */
  pendingActions: {
    id: string
    kind: string
    nodeKey: string
    role: string
    provider: string
    model: string
    text: string
  }[]
  /** 针锋相对评审（无则 null）。 */
  review: {
    status: string
    reviewPass: number
    maxReviewPass: number
    question: string
    plan: string
    viewpoints: {
      id: string
      nodeKey: string
      content: string
      endorsed: boolean
    }[]
  } | null
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
  // 已移除的专家从拓扑彻底消失：其真实连线也不再返回（前端拓扑不渲染 removed 节点）。
  const removedKeys = new Set(meeting.nodes.filter((node) => node.status === 'removed').map((node) => node.key))
  const real = meeting.edges
    .filter((edge) => !removedKeys.has(edge.from) && !removedKeys.has(edge.to))
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      direction: edge.direction,
    }))
  if (meeting.mode === 'egalitarian') return real
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
  const wireAction = (action: UserAction): MeetingSnapshot['pendingActions'][number] => ({
    id: action.id,
    kind: action.kind,
    nodeKey: action.nodeKey ?? '',
    role: action.role ?? '',
    provider: action.provider ?? '',
    model: action.model ?? '',
    text: action.text,
  })
  const snapshots: MeetingSnapshot[] = []
  for (const root of roots) {
    for (const meetingId of await listMeetings(root.stateRoot)) {
      const meeting = await readMeeting(root.stateRoot, meetingId)
      if (meeting === undefined) continue
      if (sessionFilter !== undefined && meeting.captainSessionId !== sessionFilter) continue
      const utterances = await readTranscript(root.stateRoot, meetingId)
      const userActions = await readUserActions(root.stateRoot, meetingId)
      const review = await readReview(root.stateRoot, meetingId)
      snapshots.push({
        id: meeting.id,
        name: meeting.name,
        goal: meeting.goal,
        mode: meeting.mode,
        status: meeting.status,
        round: meeting.round,
        workspace: root.workspace,
        captainSessionId: meeting.captainSessionId,
        kbPath: meeting.kbPath ?? '',
        budget: {
          maxRounds: meeting.budget.maxRounds,
          maxTokens: meeting.budget.maxTokens,
          usedRounds: meeting.budget.usedRounds,
          usedTokens: meeting.budget.usedTokens,
        },
        // 每个 key 只保留一条有效节点（删了重建 / 同名 key 多实例时取最新，
        // 非 removed 优先）。这样拓扑图与专家列表不会出现同一专家多条（避免
        // kimi+deepseek 同名残留）。removed 节点仍输出（status='removed'），
        // 由前端负责「拓扑图隐藏、专家列表置底」。
        nodes: dedupeNodesByKey(meeting.nodes).map((node) => {
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
        pendingActions: userActions.map(wireAction),
        review: review === undefined ? null : {
          status: review.status,
          reviewPass: review.reviewPass ?? 1,
          maxReviewPass: review.maxReviewPass ?? 3,
          question: review.question,
          plan: review.plan,
          viewpoints: review.viewpoints.map((viewpoint) => ({
            id: viewpoint.id,
            utteranceId: viewpoint.utteranceId,
            nodeKey: viewpoint.nodeKey,
            content: viewpoint.content,
            status: viewpoint.status,
            // 兼容派生：旧前端仍可读 endorsed。
            endorsed: viewpoint.status === 'endorsed',
            rejected: viewpoint.status === 'rejected',
            rejectReason: viewpoint.rejectReason,
            evidence: viewpoint.evidence,
            quote: viewpoint.quote,
            dimension: viewpoint.dimension,
            seq: viewpoint.seq,
          })),
        },
        digest: aggregateUtterances(utterances),
        messages: recentDirectedMessages(utterances),
        recent: recentUtterances(utterances),
      })
    }
  }
  return snapshots
}
