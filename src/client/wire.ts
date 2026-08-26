/**
 * Wire types shared by the browser topology tab: the meeting snapshot served
 * by `/plugins/dsh-plugin-roundtable/state` and the RPC result envelope.
 * @module dsh-plugin-roundtable/client/wire
 */

import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'

/** A tiny typed RPC caller over the host `/api` channel. */
export type RpcCaller = <T>(endpoint: string, payload: unknown) => Promise<RpcResult<T>>

export interface WireNode {
  id: string
  key: string
  role: string
  provider: string
  model: string
  status: string
  activity: string
}

export interface WireEdge {
  id: string
  from: string
  to: string
  direction: string
}

export interface WireBudget {
  maxRounds: number
  maxTokens: number
  usedRounds: number
  usedTokens: number
}

export interface WirePendingDecision {
  id: string
  question: string
  options: string[]
}

/** One pending user action recorded by the Web UI, awaiting the captain. */
export interface WirePendingAction {
  id: string
  kind: string
  nodeKey: string
  role: string
  provider: string
  model: string
  text: string
}

/** Model entry for the expert-management dropdown (from host llm catalog). */
export interface WireModelOption {
  id: string
  name: string
}

/** Provider entry with its advertised models for the expert-management dropdown. */
export interface WireProviderOption {
  id: string
  name: string
  models: WireModelOption[]
}

export interface WireMessage {
  id: string
  from: string
  to: string
  ts: number
}

/** One knowledge-base directory entry (阅览版: name/kind/format/size only). */
export interface WireKbEntry {
  name: string
  kind: 'file' | 'dir'
  ext: string
  size: number
  mtimeMs: number
}

/** Knowledge-base listing returned by `roundtable/kb.list`. */
export interface WireKbListing {
  path: string
  configured: boolean
  error: string
  files: WireKbEntry[]
}

export interface WireUtterance {
  id: string
  from: string
  to: string
  text: string
  ts: number
  round: number
}

export interface WireMeeting {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  captainSessionId: string
  /** 知识库目录（阅览版）；空 = 未设置。 */
  kbPath: string
  budget: WireBudget
  nodes: WireNode[]
  edges: WireEdge[]
  pendingDecisions: WirePendingDecision[]
  pendingActions: WirePendingAction[]
  digest: string
  messages: WireMessage[]
  recent: WireUtterance[]
}

export interface RoundTablePrefs {
  defaultMode: 'orchestrated' | 'egalitarian'
  maxRounds: number
  maxTokens: number
  /** 互通开关：true=显示所有圆桌会议；false=仅显示当前对话开启的会议。 */
  showAllMeetings: boolean
}

/**
 * Poll the meeting snapshot. Without a session id the host lists every
 * meeting under every workspace (互通开); with one it filters by captain
 * session (互通关 — only meetings started by the current conversation).
 */
export async function fetchMeetings(sessionId?: string): Promise<WireMeeting[]> {
  const query = sessionId === undefined ? '' : `?session=${encodeURIComponent(sessionId)}`
  const response = await fetch(`/plugins/dsh-plugin-roundtable/state${query}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`roundtable state route returned ${response.status}`)
  const body = await response.json() as { meetings?: WireMeeting[] }
  return Array.isArray(body.meetings) ? body.meetings : []
}
