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

export interface WireMeeting {
  id: string
  name: string
  goal: string
  mode: string
  status: string
  round: number
  workspace: string
  budget: WireBudget
  nodes: WireNode[]
  edges: WireEdge[]
  pendingDecisions: WirePendingDecision[]
  digest: string
}

export interface RoundTablePrefs {
  defaultMode: 'orchestrated' | 'egalitarian'
  maxRounds: number
  maxTokens: number
}

/** Poll the meeting snapshot for one captain session. */
export async function fetchMeetings(sessionId: string): Promise<WireMeeting[]> {
  const response = await fetch(`/plugins/dsh-plugin-roundtable/state?session=${encodeURIComponent(sessionId)}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`roundtable state route returned ${response.status}`)
  const body = await response.json() as { meetings?: WireMeeting[] }
  return Array.isArray(body.meetings) ? body.meetings : []
}
