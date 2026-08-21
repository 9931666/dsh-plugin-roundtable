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
import type { Meeting, MeetingDecision, MeetingEdge, MeetingNode, MeetingUtterance } from './types.ts'
import { ACTIVE_NODE_STATUSES, AGGREGATOR_KEY, CAPTAIN_KEY } from './types.ts'
import {
  appendUtterance,
  meetingDirOf,
  readMeeting,
  readTranscript,
  sanitizeKey,
  stateRootOf,
  withMeetingLock,
  writeMeeting,
} from './state.ts'
import { buildCharter } from './charter.ts'
import { aggregateUtterances } from './aggregator.ts'
import { proxyThinkingPrompt } from './proxy-thinking.ts'
import { beginRound, ensureActive, estimateTokens, MeetingMutedError } from './budget.ts'
import { deliverToNode, interruptNode, nodeActivity, spawnNode, steerCaptain, type MemberRuntimeConfig } from './members.ts'
import { appendMeetingEvent } from './events.ts'

/** Resolved plugin config consumed by the tools. */
export interface ToolsConfig {
  /** State directory name under the captain's workspace. */
  stateDir: string
  /** Node subagent provider name. */
  memberProvider: string
  /** Meeting size cap (nodes). */
  maxNodes: number
  /** Default collaboration mode. */
  defaultMode: 'orchestrated' | 'egalitarian'
  /** Node delegation depth cap. */
  memberMaxDepth?: number
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
        enum: ['orchestrated', 'egalitarian'],
        description: `Collaboration mode. Defaults to "${config.defaultMode}". "orchestrated" = captain relays everything; "egalitarian" = experts debate peer-to-peer under a budget (use max_rounds/max_tokens to bound it).`,
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
      const mode = (args.mode ?? config.defaultMode) as 'orchestrated' | 'egalitarian'
      if (mode !== 'orchestrated' && mode !== 'egalitarian') {
        throw new Error(`mode must be "orchestrated" or "egalitarian", got "${String(args.mode)}"`)
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
          await appendMeetingEvent(captain, 'roundtable/meeting-created', {
            meetingId: meeting.id,
            meetingName: meeting.name,
            mode: meeting.mode,
          })
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
      const created = await withMeetingLock(meetingLockKey(stateRoot, meetingId), async () => {
        const fresh = await readMeeting(stateRoot, meetingId)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${meetingId}" may add nodes`)
        }
        ensureActive(fresh)
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
        await spawnNode(ctx, {
          provider: config.memberProvider,
          maxDepth: config.memberMaxDepth,
        } as MemberRuntimeConfig, fresh, node, captain, config.stateDir, exec.signal)
        fresh.nodes.push(node)
        fresh.charter = buildCharter(fresh)
        try {
          await writeMeeting(stateRoot, fresh)
        } catch (error: unknown) {
          if (node.id !== '') interruptNode(ctx, captain, node.id)
          throw error
        }
        await appendMeetingEvent(captain, 'roundtable/node-added', {
          meetingId: fresh.id,
          nodeKey: node.key,
          nodeId: node.id,
        })
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
      const removed = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may remove nodes`)
        }
        ensureActive(fresh)
        const node = requireNode(fresh, String(args.name ?? ''))
        node.status = 'removed'
        const before = fresh.edges.length
        fresh.edges = fresh.edges.filter((edge) => edge.from !== node.key && edge.to !== node.key)
        fresh.charter = buildCharter(fresh)
        await writeMeeting(stateRoot, fresh)
        await appendMeetingEvent(captain, 'roundtable/node-removed', { meetingId: fresh.id, nodeKey: node.key })
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
      return withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may edit channels`)
        }
        ensureActive(fresh)
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
        await appendMeetingEvent(captain, 'roundtable/edge-set', { meetingId: fresh.id, from, to, direction })
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
      return withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may edit channels`)
        }
        ensureActive(fresh)
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
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      if (located === undefined) throw new Error('you do not belong to any active meeting yet')
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
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      if (located === undefined) throw new Error('you do not belong to any active meeting yet')
      const content = String(args.content ?? '').trim()
      if (content === '') throw new Error('content must not be empty')
      const to = String(args.to ?? '').trim()
      if (to === '') throw new Error('recipient must not be empty')
      const prepared = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const { meeting, identity } = await requireFreshParticipant(stateRoot, located.id, caller.id)
        ensureActive(meeting)
        const speaker = identity.kind === 'captain' ? CAPTAIN_KEY : identity.name
        if (meeting.mode === 'orchestrated' && identity.kind === 'node' && to !== CAPTAIN_KEY) {
          throw new Error('orchestrated mode: nodes report to the captain only — the captain relays between nodes')
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
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      if (located === undefined) throw new Error('you do not belong to any active meeting yet')
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
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
      await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may request decisions`)
        }
        fresh.decisions.push(decision)
        await writeMeeting(stateRoot, fresh)
      })
      await appendMeetingEvent(captain, 'roundtable/decision-requested', { meetingId: located.id, decisionId: decision.id })

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
      await appendMeetingEvent(captain, 'roundtable/decision-resolved', { meetingId: located.id, decisionId: decision.id })
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
      const workspace = workspaceOf(caller)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByParticipant(stateRoot, caller.id)
      if (located === undefined) throw new Error('you do not belong to any active meeting yet')
      const { meeting, identity } = await withMeetingLock(
        meetingLockKey(stateRoot, located.id),
        () => requireFreshParticipant(stateRoot, located.id, caller.id),
      )
      const activity = nodeActivity(ctx, meeting.nodes)
      const utterances = await readTranscript(stateRoot, meeting.id)
      return {
        meeting_id: meeting.id,
        meeting_name: meeting.name,
        mode: meeting.mode,
        status: meeting.status,
        viewer: identity.kind === 'captain' ? CAPTAIN_KEY : identity.name,
        round: meeting.round,
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
      return withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may change the budget`)
        }
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
      const workspace = workspaceOf(captain)
      const stateRoot = stateRootOf(workspace, config.stateDir)
      const located = await findMeetingByCaptain(stateRoot, captain.id)
      if (located === undefined) throw new Error('you are not leading any meeting — call roundtable_create first')
      const nodes = await withMeetingLock(meetingLockKey(stateRoot, located.id), async () => {
        const fresh = await readMeeting(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== captain.id) {
          throw new Error(`only the captain of meeting "${located.id}" may close it`)
        }
        const roster = fresh.nodes.map((node) => ({ ...node }))
        for (const node of fresh.nodes) {
          if (node.status !== 'removed') node.status = 'removed'
        }
        fresh.status = 'ended'
        await writeMeeting(stateRoot, fresh)
        await appendMeetingEvent(captain, 'roundtable/meeting-closed', { meetingId: fresh.id })
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
  const recent = Array.isArray(value.recent_utterances) ? value.recent_utterances as Record<string, unknown>[] : []
  const lines: string[] = [
    `Meeting "${String(value.meeting_name)}" (id ${String(value.meeting_id)}, mode ${String(value.mode)}, status ${String(value.status)}, round ${String(value.round)})`,
    `Budget: ${String(budget.used_rounds)}/${String(budget.max_rounds)} rounds, ${String(budget.used_tokens)}/${String(budget.max_tokens)} tokens`,
    `Nodes (${nodes.length}):`,
    ...nodes.map((node) => `  - ${String(node.key)} [${String(node.role ?? '')}] ${String(node.status)}/${String(node.activity ?? '')} · ${String(node.provider ?? '')}/${String(node.model ?? '')}`),
    `Edges (${edges.length}):`,
    ...edges.map((edge) => `  - ${String(edge.from)} → ${String(edge.to)} (${String(edge.direction)})`),
    `Pending decisions: ${pending.length === 0 ? 'none' : pending.map((decision) => `"${String(decision.question)}"`).join('; ')}`,
    `Recent transcript:`,
    ...recent.map((utterance) => `  [R${String(utterance.round)}] ${String(utterance.speaker)}${String(utterance.to ?? '') === '' ? '' : ` → ${String(utterance.to)}`}: ${String(utterance.content)}`),
  ]
  return lines.join('\n')
}
