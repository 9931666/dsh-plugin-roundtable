/**
 * The `roundtable_*` model-facing tools.
 *
 * The captain (the session that created the meeting) orchestrates: expert
 * nodes are continuable subagents it spawns and wakes. Nodes share the same
 * tools, speak through `roundtable_speak`, and — in egalitarian mode — message
 * each other directly. The aggregation gateway is a deterministic merge the
 * captain pulls with `roundtable_summarize`; human decisions pause the turn
 * through the `userQuestions` seam.
 * @module dsh-plugin-roundtable/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import type { Meeting, MeetingDecision, MeetingEdge, MeetingNode, MeetingUtterance, ReviewRecord } from './types.ts'
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import {
  appendUtterance,
  clearUserActions,
  meetingDirOf,
  readMeeting,
  readReview,
  readTranscript,
  readUserActions,
  sanitizeKey,
  stateRootOf,
  withMeetingLock,
  writeMeeting,
  writeReview,
} from './state.ts'
import { buildCharter } from './charter.ts'
import { aggregateUtterances } from './aggregator.ts'
import { proxyThinkingPrompt } from './proxy-thinking.ts'
import { beginRound, ensureActive, estimateTokens, MeetingMutedError } from './budget.ts'
import { deliverToNode, interruptNode, nodeActivity, spawnNode, steerCaptain, type MemberRuntimeConfig } from './members.ts'
import { splitByMarkers, splitUtterance, type SplitLlmLike } from './review-split.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Node subagent provider name. */
  memberProvider: string
  /** Meeting size cap (nodes). */
  maxNodes: number
  /** Default collaboration mode. */
  defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  /** Node delegation depth cap. */
  memberMaxDepth?: number
  /** Live expert answer limits from settings (read at every spawn). */
  getExpertLimits?: () => { maxTokens: number; maxOpinions: number }
  /** 观点拆分 LLM 路由（V0.2.2）：collect_review 时把发言拆成独立观点。 */
  reviewSplit?: { provider: string; model: string; maxOpinions: number }
}

const DEFAULT_MAX_ROUNDS = 10
const DEFAULT_MAX_TOKENS = 200_000

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: { agent?: Agent }): Agent {
  if (exec.agent === undefined) {
    throw new Error('roundtable tools require a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

/** The captain's workspace directory (meeting state root parent). */
function workspaceOf(agent: Agent): string {
  const header = (agent.session as unknown as { header?: { cwd?: string } }).header
  return header?.cwd ?? process.cwd()
}

/** Process-local lock key enforcing one active meeting per captain session. */
function captainLockKey(stateRoot: string, captainId: string): string {
  return `captain:${stateRoot}:${captainId}`
}

/** Process-local lock key for one meeting directory. */
function meetingLockKey(stateRoot: string, meetingId: string): string {
  return `meeting:${stateRoot}:${meetingId}`
}

/** Find the active meeting this captain leads (or undefined). */
async function findMeetingByCaptain(stateRoot: string, captainId: string): Promise<Meeting | undefined> {
  const { listMeetings } = await import('./state.ts')
  for (const id of await listMeetings(stateRoot)) {
    const meeting = await readMeeting(stateRoot, id)
    if (meeting !== undefined
      && meeting.captainSessionId === captainId
      && meeting.status !== 'ended'
      && meeting.status !== 'archived') {
      return meeting
    }
  }
  return undefined
}

/** Find the active meeting this agent participates in (captain or node). */
async function findMeetingByParticipant(stateRoot: string, agentId: string): Promise<Meeting | undefined> {
  const { listMeetings } = await import('./state.ts')
  for (const id of await listMeetings(stateRoot)) {
    const meeting = await readMeeting(stateRoot, id)
    if (meeting === undefined || meeting.status === 'ended' || meeting.status === 'archived') continue
    if (meeting.captainSessionId === agentId) return meeting
    if (meeting.nodes.some((node) => node.id === agentId && ACTIVE_NODE_STATUSES.includes(node.status))) {
      return meeting
    }
  }
  return undefined
}

/** Locate the meeting the captain leads, or fail loudly (captain-tool boilerplate). */
async function locateCaptainMeeting(stateRoot: string, captainId: string): Promise<Meeting> {
  const located = await findMeetingByCaptain(stateRoot, captainId)
  if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
  return located
}

/** Locate the meeting the caller participates in, or fail loudly. */
async function locateParticipantMeeting(stateRoot: string, agentId: string): Promise<Meeting> {
  const located = await findMeetingByParticipant(stateRoot, agentId)
  if (located === undefined) throw new Error('you do not belong to any active meeting yet')
  return located
}

/** Lock + captain-permission gate + active check: the inner captain-tool boilerplate. */
async function withCaptainLock<T>(
  stateRoot: string,
  meetingId: string,
  captainId: string,
  action: string,
  operation: (fresh: Meeting) => Promise<T>,
): Promise<T> {
  return withMeetingLock(meetingLockKey(stateRoot, meetingId), async () => {
    const fresh = await readMeeting(stateRoot, meetingId)
    if (fresh === undefined || fresh.captainSessionId !== captainId) {
      throw new Error(`only the captain of meeting "${meetingId}" may ${action}`)
    }
    ensureActive(fresh)
    return operation(fresh)
  })
}

type ParticipantIdentity =
  | { kind: 'captain' }
  | { kind: 'node'; name: string }

/** Derive the caller's role from fresh state. */
function participantIdentityOf(meeting: Meeting, agentId: string): ParticipantIdentity | undefined {
  if (meeting.captainSessionId === agentId) return { kind: 'captain' }
  const node = meeting.nodes.find((candidate) => candidate.id === agentId && candidate.status !== 'removed')
  return node === undefined ? undefined : { kind: 'node', name: node.key }
}

/** Fresh meeting plus caller identity, rechecked inside the lock. */
async function requireFreshParticipant(
  stateRoot: string,
  meetingId: string,
  callerId: string,
): Promise<{ meeting: Meeting; identity: ParticipantIdentity }> {
  const fresh = await readMeeting(stateRoot, meetingId)
  if (fresh === undefined) throw new Error(`meeting "${meetingId}" no longer exists`)
  const identity = participantIdentityOf(fresh, callerId)
  if (identity === undefined) throw new Error(`you are no longer a participant in meeting "${fresh.name}"`)
  return { meeting: fresh, identity }
}

/** Look up one live node by key. */
function requireNode(meeting: Meeting, key: string): MeetingNode {
  const node = meeting.nodes.find((candidate) => candidate.key === key && candidate.status !== 'removed')
  if (node === undefined) throw new Error(`no active node named "${key}" in meeting "${meeting.name}"`)
  return node
}

/** Resolve a node for the given key (captain/aggregator are not nodes). */
function isNodeKey(meeting: Meeting, key: string): boolean {
  return meeting.nodes.some((candidate) => candidate.key === key && candidate.status !== 'removed')
}

/** Valid edge endpoints: captain, aggregator, or a live node. */
function validEndpoint(meeting: Meeting, key: string): boolean {
  return key === CAPTAIN_KEY || key === AGGREGATOR_KEY || isNodeKey(meeting, key)
}

/** Record one utterance and its token cost; throws when the meeting is muted. */
async function recordUtterance(
  stateRoot: string,
  meeting: Meeting,
  utterance: Omit<MeetingUtterance, 'id' | 'ts' | 'round'>,
): Promise<MeetingUtterance> {
  ensureActive(meeting)
  const full: MeetingUtterance = {
    ...utterance,
    id: randomUUID(),
    round: meeting.round,
    ts: Date.now(),
  }
  meeting.budget.usedTokens += estimateTokens(full.content)
  meeting.updatedAt = Date.now()
  await appendUtterance(stateRoot, meeting.id, full)
  await writeMeeting(stateRoot, meeting)
  return full
}

/** Register every `roundtable_*` tool into the shared tools registry. */
export function registerRoundTableTools(ctx: Context, config: ToolsConfig): void {
  ctx.tools.register(defineTool({
    name: 'roundtable_create',
    description: 'Create a new RoundTable meeting: you (the calling agent) become the captain (主持人). A captain leads one active meeting at a time. Choose the collaboration mode: "orchestrated" means you decide who speaks and relay everything; "egalitarian" means experts message each other directly (a budget of max rounds/tokens then mutes the meeting — 闭麦).',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new meeting (used as its stable id).' },
      goal: { type: 'string', required: true, description: 'Meeting background and core goal (charter section one) — the ultimate deliverable.' },
      mode: {
        type: 'string',
        enum: ['orchestrated', 'egalitarian', 'redteam'],
        description: `Collaboration mode. Defaults to "${config.defaultMode}". "orchestrated" = captain relays everything; "egalitarian" = experts debate peer-to-peer under a budget (use max_rounds/max_tokens to bound it); "redteam" = 针锋相对评审 of a settled plan (experts attack the plan).`,
      },
      max_rounds: { type: 'integer', description: `Debate round cap (default ${DEFAULT_MAX_ROUNDS}); exceeding it mutes the meeting.` },
      max_tokens: { type: 'integer', description: `Total token budget for the meeting transcript (default ${DEFAULT_MAX_TOKENS}); exceeding it mutes the meeting.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          meeting_id: { type: 'string', required: true },
          meeting_name: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `RoundTable meeting "${value.meeting_name}" created (id ${value.meeting_id}, mode ${value.mode}, budget ${value.max_rounds} rounds / ${value.max_tokens} tokens). You are the captain. Add expert nodes with roundtable_add_node.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const meetingName = String(args.name ?? '').trim()
      if (meetingName === '') throw new Error('meeting name must not be empty')
      const meetingId = sanitizeKey(meetingName)
      const mode = (args.mode ?? config.defaultMode) as 'orchestrated' | 'egalitarian' | 'redteam'
      if (mode !== 'orchestrated' && mode !== 'egalitarian' && mode !== 'redteam') {
        throw new Error(`mode must be "orchestrated" | "egalitarian" | "redteam", got "${String(args.mode)}"`)
      }
      return withMeetingLock(captainLockKey(stateRoot, captain.id), async () => {
        const current = await findMeetingByCaptain(stateRoot, captain.id)
        if (current !== undefined) {
          throw new Error(`you already lead meeting "${current.name}" — close it before creating another`)
        }
        return withMeetingLock(meetingLockKey(stateRoot, meetingId), async () => {
          const existing = await readMeeting(stateRoot, meetingId)
          if (existing !== undefined && existing.status !== 'ended' && existing.status !== 'archived') {
            throw new Error(`meeting id "${meetingId}" is taken — pick a different meeting name`)
          }
          const now = Date.now()
          const meeting: Meeting = {
            id: meetingId,
            name: meetingName,
            goal: String(args.goal ?? ''),
            mode,
            captainSessionId: captain.id,
            charter: '',
            nodes: [],
            edges: [],
            decisions: [],
            budget: {
              maxRounds: typeof args.max_rounds === 'number' ? Math.floor(args.max_rounds) : DEFAULT_MAX_ROUNDS,
              maxTokens: typeof args.max_tokens === 'number' ? Math.floor(args.max_tokens) : DEFAULT_MAX_TOKENS,
              usedRounds: 0,
              usedTokens: 0,
            },
            round: 0,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          }
          meeting.charter = buildCharter(meeting)
          await writeMeeting(stateRoot, meeting)
          return {
            meeting_id: meeting.id,
            meeting_name: meeting.name,
            mode: meeting.mode,
            max_rounds: meeting.budget.maxRounds,
            max_tokens: meeting.budget.maxTokens,
          }
        })
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_add_node',
    description: 'Add an expert node to your meeting: spawns a durable continuable subagent with the meeting charter as its persona. By default the node inherits your current provider/model. Supply provider/model only when the user explicitly wants a different route for this expert.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique node key inside the meeting (e.g. researcher, engineer, reviewer).' },
      role: { type: 'string', description: 'Role description for this expert (e.g. "security reviewer").' },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit to inherit your current model.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_name: { type: 'string', required: true },
          node_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Node "${value.node_name}" joined (subagent id ${value.node_id}, ${value.provider}/${value.model}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) {
        throw new Error('you are not leading any meeting — call roundtable_create first')
      }
      const meetingId = located.id
      const created = await withCaptainLock(stateRoot, meetingId, captain.id, 'add nodes', async (fresh) => {
        const nodeKey = sanitizeKey(String(args.name ?? '').trim())
        if (nodeKey === '') throw new Error('node name must not be empty')
        if (nodeKey === CAPTAIN_KEY || nodeKey === AGGREGATOR_KEY) {
          throw new Error(`node name "${nodeKey}" is reserved`)
        }
        if (fresh.nodes.some((candidate) => candidate.key === nodeKey && candidate.status !== 'removed')) {
          throw new Error(`node "${nodeKey}" already exists in meeting "${fresh.name}"`)
        }
        if (fresh.nodes.filter((candidate) => candidate.status !== 'removed').length >= config.maxNodes) {
          throw new Error(`meeting "${fresh.name}" is at its node cap (${config.maxNodes})`)
        }
        const node: MeetingNode = {
          id: '',
          key: nodeKey,
          role: args.role !== undefined ? String(args.role) : undefined,
          provider: args.provider !== undefined ? String(args.provider) : captain.options.provider,
          model: args.model !== undefined ? String(args.model) : captain.options.model,
          status: 'idle',
          joinedAt: Date.now(),
        }
        const limits = config.getExpertLimits?.() ?? { maxTokens: 0, maxOpinions: 0 }
        await spawnNode(ctx, {
          provider: config.memberProvider,
          maxDepth: config.memberMaxDepth,
        } as MemberRuntimeConfig, fresh, node, captain, config.stateDir, exec.signal, limits)
        fresh.nodes.push(node)
        fresh.charter = buildCharter(fresh)
        try {
          await writeMeeting(stateRoot, fresh)
        } catch (error: unknown) {
          if (node.id !== '') interruptNode(ctx, captain, node.id)
          throw error
        }
        return {
          node_name: node.key,
          node_id: node.id,
          provider: node.provider ?? '',
          model: node.model ?? '',
          status: node.status,
        }
      })
      return created
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_remove_node',
    description: 'Remove an expert node from your meeting: interrupts its live turn, marks it removed, and drops every edge touching it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key of the node to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node_name: { type: 'string', required: true },
          removed_edges: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Node "${value.node_name}" removed; ${value.removed_edges} edge(s) dropped.`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const removed = await withCaptainLock(stateRoot, located.id, captain.id, 'remove nodes', async (fresh) => {
        const node = requireNode(fresh, String(args.name ?? ''))
        node.status = 'removed'
        const before = fresh.edges.length
        fresh.edges = fresh.edges.filter((edge) => edge.from !== node.key && edge.to !== node.key)
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { node, removedEdges: before - fresh.edges.length }
      })
      if (removed.node.id !== '') interruptNode(ctx, captain, removed.node.id)
      return { node_name: removed.node.key, removed_edges: removed.removedEdges }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_connect',
    description: 'Create a directed channel between two participants (a node key, "captain", or "aggregator"). Direction "forward" = pipeline hand-off; "bidirectional" = debate channel (both sides may address each other).',
    parameters: {
      from: { type: 'string', required: true, description: 'Source endpoint: a node key, "captain", or "aggregator".' },
      to: { type: 'string', required: true, description: 'Target endpoint: a node key, "captain", or "aggregator".' },
      direction: { type: 'string', enum: ['forward', 'bidirectional'], description: 'Channel direction (default forward).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          edge_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          direction: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Channel ${value.edge_id}: ${value.from} → ${value.to} (${value.direction}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'edit channels', async (fresh) => {
        const from = String(args.from ?? '').trim()
        const to = String(args.to ?? '').trim()
        if (!validEndpoint(fresh, from)) throw new Error(`unknown endpoint "${from}"`)
        if (!validEndpoint(fresh, to)) throw new Error(`unknown endpoint "${to}"`)
        if (from === to) throw new Error('an edge cannot connect a participant to itself')
        if (fresh.edges.some((edge) => edge.from === from && edge.to === to)) {
          throw new Error(`channel ${from} → ${to} already exists`)
        }
        const direction = (args.direction ?? 'forward') as 'forward' | 'bidirectional'
        const edge: MeetingEdge = { id: randomUUID(), from, to, direction, createdAt: Date.now() }
        fresh.edges.push(edge)
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { edge_id: edge.id, from, to, direction }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_disconnect',
    description: 'Remove a channel by edge id, or by its from/to endpoints.',
    parameters: {
      edge_id: { type: 'string', description: 'Id of the edge to remove (from roundtable_status or connect).' },
      from: { type: 'string', description: 'Source endpoint (alternative to edge_id).' },
      to: { type: 'string', description: 'Target endpoint (alternative to edge_id).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.removed ? 'Channel removed.' : 'No matching channel found.' }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'edit channels', async (fresh) => {
        const before = fresh.edges.length
        if (args.edge_id !== undefined) {
          fresh.edges = fresh.edges.filter((edge) => edge.id !== String(args.edge_id))
        } else if (args.from !== undefined && args.to !== undefined) {
          fresh.edges = fresh.edges.filter((edge) => edge.from !== String(args.from) || edge.to !== String(args.to))
        } else {
          throw new Error('provide edge_id, or both from and to')
        }
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        return { removed: before !== fresh.edges.length }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_speak',
    description: 'Write your contribution into the meeting transcript (the aggregation gateway input). Follow the charter format: start with [当前状态], end with [核心产出] and [下一步建议]; never output filler. Leave `to` empty to submit to the gateway; set it to a participant key for a directed remark.',
    parameters: {
      content: { type: 'string', required: true, description: 'The full contribution text.' },
      to: { type: 'string', description: 'Directed audience: a node key or "captain". Empty submits to the aggregation gateway.' },
      kind: { type: 'string', enum: ['speech', 'proxy-thinking', 'retrieval'], description: 'Contribution kind (default speech). Use "proxy-thinking" when you speak for a black-box worker model, "retrieval" when reporting knowledge-base retrieval.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          utterance_id: { type: 'string', required: true },
          round: { type: 'integer', required: true },
          tokens_used: { type: 'integer', required: true },
          budget_remaining_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Contribution recorded (id ${value.utterance_id}, round ${value.round}); meeting token budget remaining ${value.budget_remaining_tokens}.`,
      }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const recorded = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        const content = String(args.content ?? '').trim()
        if (content === '') throw new Error('content must not be empty')
        const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
        const to = args.to !== undefined ? String(args.to).trim() : undefined
        if (to !== undefined && to !== '' && !validEndpoint(meeting, to)) {
          throw new Error(`unknown directed audience "${to}"`)
        }
        const kind = (args.kind ?? 'speech') as 'speech' | 'proxy-thinking' | 'retrieval'
        const utterance = await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind, content, to: to === '' ? undefined : to })
        return {
          utterance_id: utterance.id,
          round: utterance.round,
          tokens_used: estimateTokens(content),
          budget_remaining_tokens: Math.max(0, meeting.budget.maxTokens - meeting.budget.usedTokens),
        }
      })
      return recorded
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_send_message',
    description: 'Send a direct message to another participant: wakes the recipient as its next turn. In "orchestrated" mode only the captain may message nodes (nodes report to the captain); in "egalitarian" mode any participant may message any other — this is how experts debate peer-to-peer.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a node key.' },
      content: { type: 'string', required: true, description: 'The message text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'string', required: true, description: 'wake (recipient node woken), live (captain steered), or dropped (best effort failed).' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Message delivered via ${value.delivered}.` }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const content = String(args.content ?? '').trim()
      if (content === '') throw new Error('content must not be empty')
      const to = String(args.to ?? '').trim()
      if (to === '') throw new Error('recipient must not be empty')
      const prepared = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        ensureActive(meeting)
        const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
        if (meeting.mode !== 'egalitarian' && identity.kind === 'node' && to !== CAPTAIN_KEY) {
          throw new Error('orchestrated/redteam mode: nodes report to the captain only — the captain relays between nodes')
        }
        if (to === CAPTAIN_KEY) {
          // Captain-bound messages are persisted in the transcript; live steering happens after the lock.
          await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind: 'speech', content, to: CAPTAIN_KEY })
          return { kind: 'captain' as const, meeting, speaker }
        }
        const recipient = requireNode(meeting, to)
        if (recipient.id === '') throw new Error(`node "${to}" has no live subagent yet`)
        await recordUtterance(stateRoot, meeting, { nodeKey: speaker, kind: 'speech', content, to })
        return { kind: 'node' as const, meeting, speaker, recipient }
      })
      const captainLive = ctx.agents.get(prepared.meeting.captainSessionId as import('@deepseek-ai/dsh-session').SessionId)
      if (prepared.kind === 'captain') {
        if (captainLive !== undefined && prepared.speaker !== CAPTAIN_KEY) {
          const delivered = steerCaptain(captainLive, `RoundTable message from ${prepared.speaker}:\n\n${content}`)
          return { delivered: delivered ? 'live' : 'dropped' }
        }
        return { delivered: 'dropped' }
      }
      if (captainLive !== undefined) {
        const accepted = await deliverToNode(ctx, captainLive, prepared.recipient.id, content, exec.signal)
        return { delivered: accepted ? 'wake' : 'dropped' }
      }
      return { delivered: 'dropped' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_summarize',
    description: 'Pull the aggregation gateway digest: a deterministic structured merge of the transcript (per-speaker recent lines). Use it to stay aligned without reading every raw line; you may then condense it further in your own reply.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          digest: { type: 'string', required: true },
          speech_count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `[Gateway digest]\n${value.digest}` }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const utterances = await readTranscript(stateRoot, located.id)
      return {
        digest: aggregateUtterances(utterances),
        speech_count: utterances.filter((utterance) => utterance.kind === 'speech' || utterance.kind === 'proxy-thinking').length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_request_decision',
    description: 'Pause the meeting and ask the human for a decision (Human-in-the-loop). The user picks one option or types their own. The meeting turn blocks until the user answers; the answer is then returned to you. Use for real forks or disagreements the experts cannot settle.',
    parameters: {
      question: { type: 'string', required: true, description: 'The decision to put to the user (e.g. "架构方案 A 还是 B？").' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Option labels (e.g. ["方案 A：模块化", "方案 B：一体化"]). The user may also type a custom answer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision_id: { type: 'string', required: true },
          chosen: { type: 'string', required: true },
          custom_answer: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Human decision ${value.decision_id}: ${value.chosen}${value.custom_answer !== undefined && value.custom_answer !== '' ? ` (custom: ${value.custom_answer})` : ''}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const question = String(args.question ?? '').trim()
      if (question === '') throw new Error('question must not be empty')
      const optionLabels = Array.isArray(args.options)
        ? (args.options as unknown[]).map((option) => String(option).trim()).filter((option) => option !== '')
        : []
      const decision: MeetingDecision = {
        id: randomUUID(),
        question,
        options: optionLabels,
        status: 'pending',
        ts: Date.now(),
      }
      await withCaptainLock(stateRoot, located.id, captain.id, 'request decisions', async (fresh) => {
        fresh.decisions.push(decision)
        await writeMeeting(stateRoot, fresh)
      })

      const userQuestions = ctx.get('userQuestions') as
        | { ask(request: { questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[] }[]; agent?: Agent; signal?: AbortSignal }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }
        | undefined
      if (userQuestions === undefined) {
        decision.status = 'resolved'
        decision.chosen = '(unavailable)'
        await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
          const fresh = await readMeeting(stateRoot, located.id)
          if (fresh !== undefined) await writeMeeting(stateRoot, fresh)
        })
        throw new Error('roundtable: human decision unavailable — the userQuestions service is not mounted in this composition')
      }
      const answer = await userQuestions.ask({
        questions: [{
          id: decision.id,
          question,
          header: '圆桌会议 · 需人类决策',
          ...(optionLabels.length > 0 ? { options: optionLabels.map((label) => ({ label })) } : {}),
        }],
        agent: captain,
        signal: exec.signal,
      })
      const item = answer.answers.find((candidate) => candidate.id === decision.id)
      const chosen = item?.selected[0]
      const customAnswer = item?.custom !== undefined && item.custom !== '' ? item.custom : undefined
      await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined) return
        const target = fresh.decisions.find((candidate) => candidate.id === decision.id)
        if (target !== undefined) {
          target.status = 'resolved'
          target.chosen = chosen
          if (customAnswer !== undefined) target.customAnswer = customAnswer
        }
        await writeMeeting(stateRoot, fresh)
      })
      return {
        decision_id: decision.id,
        chosen: chosen ?? '(no selection)',
        ...(customAnswer !== undefined ? { custom_answer: customAnswer } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_status',
    description: 'Meeting snapshot: nodes with live activity, edges, budget, pending decisions, and the recent transcript tail. Poll this to watch progress.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value as Record<string, unknown>) }],
    },
    async execute(_args, exec) {
      const caller = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(caller), config.stateDir)
      const located = await locateParticipantMeeting(stateRoot, caller.id)
      const { meeting, identity } = await withMeetingLock(
        meetingLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = nodeActivity(ctx, meeting.nodes)
      const utterances = await readTranscript(stateRoot, meeting.id)
      const userActions = await readUserActions(stateRoot, meeting.id)
      return {
        meeting_id: meeting.id,
        meeting_name: meeting.name,
        mode: meeting.mode,
        status: meeting.status,
        viewer: identity.kind === 'captain' ? CAPTAIN_KEY : identity.name,
        round: meeting.round,
        kb_path: meeting.kbPath ?? '',
        budget: {
          max_rounds: meeting.budget.maxRounds,
          max_tokens: meeting.budget.maxTokens,
          used_rounds: meeting.budget.usedRounds,
          used_tokens: meeting.budget.usedTokens,
        },
        nodes: meeting.nodes
          .filter((node) => node.status !== 'removed')
          .map((node) => ({
            key: node.key,
            role: node.role ?? '',
            provider: node.provider ?? '',
            model: node.model ?? '',
            status: node.status,
            activity: activity.get(node.key) ?? 'unspawned',
          })),
        edges: meeting.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          direction: edge.direction,
        })),
        pending_decisions: meeting.decisions
          .filter((decision) => decision.status === 'pending')
          .map((decision) => ({ id: decision.id, question: decision.question, options: decision.options })),
        pending_actions: userActions.map((action) => ({
          id: action.id,
          kind: action.kind,
          node_key: action.nodeKey ?? '',
          role: action.role ?? '',
          provider: action.provider ?? '',
          model: action.model ?? '',
          text: action.text,
        })),
        recent_utterances: utterances.slice(-10).map((utterance) => ({
          speaker: utterance.nodeKey,
          kind: utterance.kind,
          content: utterance.content.slice(0, 400),
          to: utterance.to ?? '',
          round: utterance.round,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_actions_clear',
    description: 'Clear the meeting\'s pending user-actions file (user-actions.jsonl) after you executed every recorded action with the roundtable_* tools. Only call this after each action was applied successfully; on a failure keep the record and explain why. Returns how many actions were cleared.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cleared: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Cleared ${value.cleared} pending user action(s).`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const cleared = await withCaptainLock(stateRoot, located.id, captain.id, 'clear user actions', async (fresh) => {
        return clearUserActions(stateRoot, fresh.id)
      })
      return { cleared }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_start_review',
    description: 'Start a 针锋相对 (adversarial) review pass of a settled plan: records the user\'s original question and the captain\'s plan into review.json, so the Web review window can show them. First pass = reviewPass 1. After a previous pass was finished (status done), calling this again starts the next review pass (reviewPass + 1, closed loop 闭环复审) and preserves the previous pass in history; the captain may open at most 2 re-review passes beyond the first (maxReviewPass 3). To go beyond the cap, the user must have explicitly approved: pass user_approved_extra_pass=true. Requires the captain.',
    parameters: {
      question: { type: 'string', required: true, description: 'The user\'s original question / topic.' },
      plan: { type: 'string', required: true, description: 'The settled plan and its explanation (the object under review).' },
      user_approved_extra_pass: { type: 'boolean', description: 'Set true ONLY when the user explicitly approved exceeding the re-review cap (maxReviewPass). Never set on your own.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          review_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          review_pass: { type: 'integer', required: true },
          max_review_pass: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review started (id ${value.review_id}, status ${value.status}, review pass ${value.review_pass}/${value.max_review_pass}). Tell the experts to attack ONLY the plan (red-team).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const question = String(args.question ?? '').trim()
      const plan = String(args.plan ?? '').trim()
      if (question === '' || plan === '') throw new Error('question and plan must not be empty')
      return withCaptainLock(stateRoot, located.id, captain.id, 'start a review', async (fresh) => {
        // S1 覆盖保护：进行中的评审（含已支持/驳回记录）不允许被静默覆盖。
        const existing = await readReview(stateRoot, fresh.id)
        if (existing !== undefined && existing.status !== 'done') {
          throw new Error(`a review is already in progress (status ${existing.status}) — finish it before starting a new pass`)
        }
        // 复审轮次（C3）：上一轮已 done → reviewPass+1；超上限须用户显式批准。
        const previousPass = existing?.status === 'done' && typeof existing.reviewPass === 'number' ? existing.reviewPass : 0
        const reviewPass = previousPass + 1
        const maxReviewPass = existing?.maxReviewPass ?? 3
        if (reviewPass > maxReviewPass && args.user_approved_extra_pass !== true) {
          throw new Error(`re-review cap reached (pass ${reviewPass} > max ${maxReviewPass}) — ask the user to approve continuing, then retry with user_approved_extra_pass=true, or export and finish the review`)
        }
        const now = Date.now()
        const review: ReviewRecord = {
          meetingId: fresh.id,
          question,
          plan,
          status: 'reviewing',
          reviewPass,
          maxReviewPass,
          schemaVersion: 2,
          viewpoints: [],
          startedAt: now,
          updatedAt: now,
          // 保留上一轮快照（闭环核对"旧缺陷是否修复"的依据）。
          history: existing?.status === 'done' ? [...(existing.history ?? []), {
            pass: existing.reviewPass,
            question: existing.question,
            plan: existing.plan,
            viewpoints: existing.viewpoints,
            finishedAt: existing.finishedAt ?? now,
          }] : [],
        }
        await writeReview(stateRoot, fresh.id, review)
        return { review_id: fresh.id, status: review.status, review_pass: review.reviewPass, max_review_pass: review.maxReviewPass }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_collect_review',
    description: 'Collect the red-team experts\' objections from the transcript into review.json (viewpoints), then the Web review window becomes ready. Call this after the experts have spoken (roundtable_speak). Idempotent: already-collected utterances are skipped. Requires the captain.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collected: { type: 'integer', required: true },
          split_attempts: { type: 'integer', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review collected: ${value.collected} viewpoint(s) (${value.split_attempts} split attempt(s)), status ${value.status}.`,
      }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'collect review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review in progress — call roundtable_start_review first')
        // 幂等键 = utteranceId 集合（观点拆分后 viewpoint.id 已变，不能用作去重）。
        const collectedUtteranceIds = new Set(review.viewpoints.map((viewpoint) => viewpoint.utteranceId))
        const utterances = await readTranscript(stateRoot, fresh.id)
        const llm = ctx.get('llm') as SplitLlmLike | undefined
        const splitConfig = config.reviewSplit
        let collected = 0
        let splitAttempts = 0
        for (const utterance of utterances) {
          if (utterance.nodeKey === CAPTAIN_KEY) continue
          if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
          if (utterance.ts < review.startedAt) continue
          if (collectedUtteranceIds.has(utterance.id)) continue
          const content = utterance.content.replace(/\s+/g, ' ').trim()
          if (content === '') continue // 空发言跳过
          // 观点拆分（三道防线）：LLM 优先，任何失败 → 本地启发式兜底（零 token）→ 仍失败则整条兜底（seq=0）。
          let lines: Awaited<ReturnType<typeof splitUtterance>> | null = null
          if (llm !== undefined && splitConfig !== undefined) {
            try {
              lines = await splitUtterance(llm, splitConfig, utterance.nodeKey, content)
              splitAttempts += 1
            } catch {
              lines = null
            }
          }
          if (lines === null) {
            // 无 LLM 或 LLM 拆分失败：按「观点 N（…）」段落结构本地切分，保证观点逐条可认定。
            try {
              lines = splitByMarkers(content)
            } catch {
              lines = null
            }
          }
          if (lines !== null && lines.length > 0) {
            lines.forEach((line, index) => {
              review.viewpoints.push({
                id: `${utterance.id}#${index + 1}`,
                utteranceId: utterance.id,
                nodeKey: utterance.nodeKey,
                content: line.content,
                status: 'pending',
                quote: line.quote,
                dimension: line.dimension,
                evidence: line.evidence,
                ts: utterance.ts,
                seq: index + 1,
              })
              collected += 1
            })
          } else {
            review.viewpoints.push({
              id: `${utterance.id}#0`,
              utteranceId: utterance.id,
              nodeKey: utterance.nodeKey,
              content,
              status: 'pending',
              dimension: '其他',
              ts: utterance.ts,
              seq: 0,
            })
            collected += 1
          }
        }
        if (collected > 0) review.status = 'ready'
        await writeReview(stateRoot, fresh.id, review)
        return { collected, split_attempts: splitAttempts, status: review.status }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_finish_review',
    description: 'Finish the current 针锋相对 review pass: marks it done (closed loop 闭环 can then start the next pass with roundtable_start_review). Records remaining endorsed (已认定) defects as the known-flaws checklist. Call this after the user finished endorsing/rejecting viewpoints and you have revised the plan (or decided to stop). Requires the captain.',
    parameters: {
      revised_plan_summary: { type: 'string', description: 'Optional one-line summary of how the endorsed defects were addressed in the revised plan (写入历史，供下一轮核对).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          review_pass: { type: 'integer', required: true },
          endorsed_count: { type: 'integer', required: true },
          can_review_again: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Review pass ${value.review_pass} finished (status ${value.status}, ${value.endorsed_count} endorsed defect(s)). ${value.can_review_again ? 'You may start the next re-review pass with roundtable_start_review.' : 'Re-review cap reached — export the record and present the consolidated result.'}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'finish the review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review in progress — call roundtable_start_review first')
        if (review.status === 'done') {
          return { status: review.status, review_pass: review.reviewPass, endorsed_count: countEndorsed(review), can_review_again: review.reviewPass < review.maxReviewPass }
        }
        if (review.status === 'reviewing') {
          throw new Error('review is still collecting viewpoints — call roundtable_collect_review before finishing')
        }
        review.status = 'done'
        review.finishedAt = Date.now()
        const summary = String(args.revised_plan_summary ?? '').trim()
        if (summary !== '') {
          // 本轮修订说明并入最后一条历史（无历史则新建），供下一轮"旧缺陷是否修复"核对。
          const last = review.history.length > 0 ? review.history[review.history.length - 1] : undefined
          if (last !== undefined && last.pass === review.reviewPass) {
            last.revisedPlanSummary = summary
          } else {
            review.history.push({
              pass: review.reviewPass,
              question: review.question,
              plan: review.plan,
              viewpoints: review.viewpoints,
              finishedAt: Date.now(),
              revisedPlanSummary: summary,
            })
          }
        }
        await writeReview(stateRoot, fresh.id, review)
        return {
          status: review.status,
          review_pass: review.reviewPass,
          endorsed_count: countEndorsed(review),
          can_review_again: review.reviewPass < review.maxReviewPass,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_export_review',
    description: 'Export the full 针锋相对 review record (all passes, viewpoints, endorsements, reject reasons, revision summaries) as a Markdown deliverable for the user to keep or paste into an issue. Requires the captain.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          markdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.markdown }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'export the review', async (fresh) => {
        const review = await readReview(stateRoot, fresh.id)
        if (review === undefined) throw new Error('no review record yet — call roundtable_start_review first')
        return { markdown: renderReviewMarkdown(review) }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_set_budget',
    description: 'Adjust the meeting budget. Top up max_rounds/max_tokens to unmute (闭麦后恢复) a muted meeting, or tighten them. Requires the captain.',
    parameters: {
      max_rounds: { type: 'integer', description: 'New round cap.' },
      max_tokens: { type: 'integer', description: 'New total token budget.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          max_rounds: { type: 'integer', required: true },
          max_tokens: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Budget updated: ${value.max_rounds} rounds / ${value.max_tokens} tokens (meeting status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      return withCaptainLock(stateRoot, located.id, captain.id, 'change the budget', async (fresh) => {
        if (typeof args.max_rounds === 'number') fresh.budget.maxRounds = Math.floor(args.max_rounds)
        if (typeof args.max_tokens === 'number') fresh.budget.maxTokens = Math.floor(args.max_tokens)
        if (fresh.status === 'muted') {
          if (fresh.round < fresh.budget.maxRounds && fresh.budget.usedTokens < fresh.budget.maxTokens) {
            fresh.status = 'active'
          }
        }
        await writeMeeting(stateRoot, fresh)
        return { status: fresh.status, max_rounds: fresh.budget.maxRounds, max_tokens: fresh.budget.maxTokens }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_close',
    description: 'End your meeting: interrupts all nodes (best effort) and marks the meeting ended. The record stays on disk for review.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          meeting_name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Meeting "${value.meeting_name}" closed.` }],
    },
    async execute(_args, exec) {
      const captain = requireCaptain(exec)
      const stateRoot = stateRootOf(workspaceOf(captain), config.stateDir)
      const located = await locateCaptainMeeting(stateRoot, captain.id)
      const nodes = await withCaptainLock(stateRoot, located.id, captain.id, 'close it', async (fresh) => {
        const roster = fresh.nodes.map((node) => ({ ...node }))
        for (const node of fresh.nodes) {
          if (node.status !== 'removed') node.status = 'removed'
        }
        fresh.status = 'ended'
        await writeMeeting(stateRoot, fresh)
        return roster
      })
      for (const node of nodes) {
        if (node.id !== '') interruptNode(ctx, captain, node.id)
      }
      return { closed: true, meeting_name: located.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'roundtable_proxy_think',
    description: 'Proxy Thinking (代理思考): prepare to hand a task to a black-box worker model (no visible reasoning). Returns the director-side template you must fill in: write [DeepSeek 代理思考] reasoning, translate the task into exact worker parameters, and state expectations/fallbacks. Then deliver the translated parameters to the worker model.',
    parameters: {
      worker_model: { type: 'string', required: true, description: 'The black-box worker model (e.g. seedance, an image model).' },
      task: { type: 'string', required: true, description: 'The goal to translate for the worker model.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.template }],
    },
    async execute(args, exec) {
      const caller = requireCaptain(exec)
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      const workerModel = String(args.worker_model ?? '').trim()
      const task = String(args.task ?? '').trim()
      if (workerModel === '' || task === '') throw new Error('worker_model and task must not be empty')
      if (located !== undefined) {
        await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
          const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
          const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
          await recordUtterance(stateRoot, meeting, {
            nodeKey: speaker,
            kind: 'proxy-thinking',
            content: `[代理思考 → ${workerModel}] ${task}`,
          })
        })
      }
      return { template: proxyThinkingPrompt(workerModel, task) }
    },
  }))
}

/** Render the status snapshot as compact text for the model. */
function renderStatus(value: Record<string, unknown>): string {
  const nodes = Array.isArray(value.nodes) ? value.nodes as Record<string, unknown>[] : []
  const edges = Array.isArray(value.edges) ? value.edges as Record<string, unknown>[] : []
  const budget = (value.budget ?? {}) as Record<string, unknown>
  const pending = Array.isArray(value.pending_decisions) ? value.pending_decisions as Record<string, unknown>[] : []
  const pendingActions = Array.isArray(value.pending_actions) ? value.pending_actions as Record<string, unknown>[] : []
  const recent = Array.isArray(value.recent_utterances) ? value.recent_utterances as Record<string, unknown>[] : []
  const lines: string[] = [
    `Meeting "${String(value.meeting_name)}" (id ${String(value.meeting_id)}, mode ${String(value.mode)}, status ${String(value.status)}, round ${String(value.round)})`,
    `Knowledge base path: ${String(value.kb_path ?? '') === '' ? '(none)' : String(value.kb_path)}`,
    `Budget: ${String(budget.used_rounds)}/${String(budget.max_rounds)} rounds, ${String(budget.used_tokens)}/${String(budget.max_tokens)} tokens`,
    `Nodes (${nodes.length}):`,
    ...nodes.map((node) => `  - ${String(node.key)} [${String(node.role ?? '')}] ${String(node.status)}/${String(node.activity ?? '')} · ${String(node.provider ?? '')}/${String(node.model ?? '')}`),
    `Edges (${edges.length}):`,
    ...edges.map((edge) => `  - ${String(edge.from)} → ${String(edge.to)} (${String(edge.direction)})`),
    `Pending decisions: ${pending.length === 0 ? 'none' : pending.map((decision) => `"${String(decision.question)}"`).join('; ')}`,
    `Pending user actions (${pendingActions.length}): ${pendingActions.length === 0 ? 'none' : pendingActions.map((action) => `"${String(action.text)}"`).join('; ')}`,
    `Recent transcript:`,
    ...recent.map((utterance) => `  [R${String(utterance.round)}] ${String(utterance.speaker)}${String(utterance.to ?? '') === '' ? '' : ` → ${String(utterance.to)}`}: ${String(utterance.content)}`),
  ]
  return lines.join('\n')
}

/** Count endorsed (已认定) viewpoints in the current pass. */
function countEndorsed(review: ReviewRecord): number {
  return review.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed').length
}

/** One-line viewpoint marker inside the exported markdown. */
function viewpointStatusLabel(status: string): string {
  if (status === 'endorsed') return '✅ 已认定'
  if (status === 'rejected') return '❌ 已驳回'
  return '⬜ 未表态'
}

/** Evidence line inside the exported markdown. */
function evidenceLine(evidence: { kind: string; text: string } | undefined): string {
  if (evidence === undefined) return ''
  const label = evidence.kind === 'repro' ? '证据（可复现步骤）' : '证据（论证链）'
  return `\n  - **${label}**：${evidence.text}`
}

/** Render the full review record as a Markdown deliverable (C5). */
function renderReviewMarkdown(review: ReviewRecord): string {
  const out: string[] = []
  out.push('# 针锋相对评审记录', '')
  out.push(`- 评审轮次：${review.reviewPass} / ${review.maxReviewPass}`)
  out.push(`- 状态：${review.status === 'done' ? '已完成' : review.status === 'ready' ? '待表态' : '收集中'}`)
  out.push('', '## 原始问题', '', review.question, '', '## 本轮方案（待攻击对象）', '', review.plan, '')
  const endorsed = review.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed')
  const rejected = review.viewpoints.filter((viewpoint) => viewpoint.status === 'rejected')
  const pending = review.viewpoints.filter((viewpoint) => viewpoint.status === 'pending')
  out.push(`## 本轮观点（${review.viewpoints.length} 条：已认定 ${endorsed.length} / 已驳回 ${rejected.length} / 未表态 ${pending.length}）`, '')
  if (review.viewpoints.length === 0) {
    out.push('（暂无观点）')
  }
  for (const viewpoint of review.viewpoints) {
    out.push(
      `- **[${viewpointStatusLabel(viewpoint.status)}]** 观点 ${viewpoint.seq}（${viewpoint.dimension}，来自 ${viewpoint.nodeKey}）`,
      '',
      `  ${viewpoint.content}`,
      evidenceLine(viewpoint.evidence),
    )
    if (viewpoint.quote !== undefined) out.push(`\n  > 原文引用：${viewpoint.quote}`)
    if (viewpoint.status === 'rejected' && viewpoint.rejectReason !== undefined) {
      out.push(`\n  - **驳回理由**：${viewpoint.rejectReason}`)
    }
    out.push('')
  }
  if (review.history !== undefined && review.history.length > 0) {
    out.push('---', '', '## 历史轮次（闭环复审对照）', '')
    for (const pass of review.history) {
      out.push(`### 第 ${pass.pass} 轮`, '', `- 问题：${pass.question}`, `- 方案：${pass.plan}`)
      if (pass.revisedPlanSummary !== undefined) out.push(`- 修订说明：${pass.revisedPlanSummary}`)
      const endorsedInPass = pass.viewpoints.filter((viewpoint) => viewpoint.status === 'endorsed')
      if (endorsedInPass.length > 0) {
        out.push('- 该轮已认定缺陷：')
        for (const viewpoint of endorsedInPass) out.push(`  - ${viewpoint.content}`)
      }
      out.push('')
    }
  }
  return out.join('\n')
}
