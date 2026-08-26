/**
 * RoundTable durable meeting state types.
 *
 * A meeting is one directory under the state root holding `meeting.json`
 * (nodes, edges, decisions, budget, charter) plus a `transcript.jsonl`
 * (utterances). Expert nodes are continuable subagents whose durable child
 * session ids are recorded in the meeting file, so a meeting survives
 * harness restarts.
 * @module dsh-plugin-roundtable/types
 */

/** Collaboration mode: captain orchestrates every exchange, or experts talk peer-to-peer. */
export type MeetingMode = 'orchestrated' | 'egalitarian'

/** Meeting lifecycle. `muted` = budget exceeded (闭麦); user may top up or close. */
export type MeetingStatus = 'active' | 'muted' | 'ended' | 'archived'

/** One expert node's lifecycle status. */
export type NodeStatus = 'idle' | 'working' | 'ready' | 'removed'

/** Edge direction: forward (pipeline) or bidirectional (debate channel). */
export type EdgeDirection = 'forward' | 'bidirectional'

/** What one transcript line records. */
export type UtteranceKind = 'speech' | 'proxy-thinking' | 'retrieval' | 'decision'

/** Node statuses that still count as participants. */
export const ACTIVE_NODE_STATUSES: readonly NodeStatus[] = ['idle', 'working', 'ready']

/** Reserved speaker key of the captain (the owning session). */
export const CAPTAIN_KEY = 'captain'

/** Reserved speaker key of the aggregation gateway. */
export const AGGREGATOR_KEY = 'aggregator'

/** One expert node: a continuable subagent plus its meeting-side record. */
export interface MeetingNode {
  /** Durable continuable subagent session id (empty until spawned). */
  id: string
  /** Unique display key inside the meeting (used by edges and mailboxes). */
  key: string
  /** Role description, e.g. `researcher`, `engineer`, `reviewer`. */
  role?: string
  /** Resolved LLM provider route captured when this node was created. */
  provider?: string
  /** Resolved model captured when this node was created. */
  model?: string
  /** Resolved reasoning effort captured when this node was created. */
  reasoningEffort?: string
  status: NodeStatus
  joinedAt: number
}

/** One directed channel between two participants. */
export interface MeetingEdge {
  id: string
  /** Node key, or `captain` / `aggregator`. */
  from: string
  /** Node key, or `captain` / `aggregator`. */
  to: string
  direction: EdgeDirection
  createdAt: number
}

/** One line of the meeting transcript. */
export interface MeetingUtterance {
  id: string
  /** Speaker: a node key or `captain`. */
  nodeKey: string
  kind: UtteranceKind
  content: string
  /** Gateway-produced structured summary (set by `roundtable_summarize`). */
  summary?: string
  /** Directed audience (absent = submitted to the gateway). */
  to?: string
  round: number
  ts: number
}

/** One human decision requested by the captain. */
export interface MeetingDecision {
  id: string
  question: string
  /** Option labels offered to the user (方案 A / B / ...). */
  options: string[]
  chosen?: string
  customAnswer?: string
  status: 'pending' | 'resolved'
  ts: number
}

/** Round/token budget; exceeding either mutes the meeting. */
export interface MeetingBudget {
  maxRounds: number
  maxTokens: number
  usedRounds: number
  usedTokens: number
}

/**
 * One pending user action recorded by the Web UI (`user-actions.jsonl`).
 *
 * The UI never mutates meeting state directly: an expert edit (add/remove)
 * is appended here as a pending action, the captain (主持人) drains the file
 * next round through `roundtable_*` tools, and only clears it after every
 * line was executed successfully. Empty file = no pending work.
 */
export interface UserAction {
  id: string
  ts: number
  /** What the captain must do: add an expert node / remove one / other. */
  kind: 'add-node' | 'remove-node' | 'kb-path' | 'other'
  /** Target node key when the action concerns one expert. */
  nodeKey?: string
  /** Role text captured for an add-node action. */
  role?: string
  /** Provider route captured for an add-node action (empty = inherit captain). */
  provider?: string
  /** Model captured for an add-node action (empty = inherit captain). */
  model?: string
  /** Human-readable sentence, e.g. "删除了专家 researcher". */
  text: string
}

/** The full durable meeting record (transcript lives in transcript.jsonl). */
export interface Meeting {
  /** Sanitized stable id; the meeting directory name. */
  id: string
  name: string
  /** Meeting background and goal (charter section one). */
  goal: string
  mode: MeetingMode
  /** Session id of the captain (DeepSeek) that owns this meeting. */
  captainSessionId: string
  /** The injected《全局协作总纲》. */
  charter: string
  nodes: MeetingNode[]
  edges: MeetingEdge[]
  decisions: MeetingDecision[]
  budget: MeetingBudget
  /** Current debate round. */
  round: number
  /** 知识库目录（阅览版）：主持人按需读取其中文件转交专家。空 = 未设置。 */
  kbPath?: string
  status: MeetingStatus
  createdAt: number
  updatedAt: number
}
