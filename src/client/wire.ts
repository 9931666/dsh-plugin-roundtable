/**
 * Wire types shared by the browser topology tab: the meeting snapshot served
 * by `/plugins/dsh-plugin-roundtable/state` and the RPC result envelope.
 * @module dsh-plugin-roundtable/client/wire
 */

/** One RPC response envelope (structurally compatible with the host's RpcResult). */
export type RpcEnvelope<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: { code: string; message: string; details?: unknown }; value?: never }

/** A tiny typed RPC caller over the plugin's own web route. */
export type RpcCaller = <T>(endpoint: string, payload: unknown) => Promise<RpcEnvelope<T>>

/**
 * POST one RPC call to the plugin's OWN web route.
 *
 * That route is mounted through the same `webServer` registration as the
 * snapshot route, so the browser reaches it even when the host's generic
 * connection channel is not mounted — which is what made the settings page
 * report 「读取设置失败」. An unreachable or malformed answer is reported as a
 * failure envelope instead of a rejected promise.
 */
export async function callRpc<T>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcEnvelope<T>> {
  try {
    const response = await fetch('/plugins/dsh-plugin-roundtable/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json() as unknown
    const envelope = body as RpcEnvelope<T> | null
    if (envelope === null || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      return { ok: false, error: { code: 'internal', message: `roundtable rpc route returned ${response.status}` } }
    }
    return envelope
  } catch (error: unknown) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
}

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
  /** 第 3 批：provider 上报的真实用量（0 = 此刻不可测）。 */
  usedTokensReal?: number
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

/** 观点证据分级（C1）：repro=可复现步骤；argument=论证链。 */
export interface WireReviewEvidence {
  kind: 'repro' | 'argument'
  text: string
}

/** 针锋相对评审：一个观点（V0.2.2 三态 + 拆分）。 */
export interface WireReviewViewpoint {
  id: string
  utteranceId: string
  nodeKey: string
  content: string
  /** 三态：pending/endorsed/rejected。 */
  status: 'pending' | 'endorsed' | 'rejected'
  /** 兼容派生（旧视图仍可读）：status === 'endorsed'。 */
  endorsed: boolean
  /** 派生：status === 'rejected'。 */
  rejected: boolean
  /** 驳回理由（C2：驳回必填；前端在 rejected 状态下展示）。 */
  rejectReason?: string
  /** 证据分级（C1）。 */
  evidence?: WireReviewEvidence
  /** 原文引用子串（拆分观点可能有）。 */
  quote?: string
  /** 维度标签（默认"其他"）。 */
  dimension: string
  /** 发言内序号：0=整条未拆分。 */
  seq: number
}

/** 针锋相对评审记录（快照携带，前端弹窗数据源）。 */
export interface WireReview {
  status: string
  reviewPass: number
  maxReviewPass: number
  question: string
  plan: string
  viewpoints: WireReviewViewpoint[]
}

/** 一条匿名反馈（E1/E3：设置页列表展示）。 */
export interface WireFeedbackEntry {
  id: string
  ts: number
  meetingId: string
  mode: string
  providers: string[]
  models: string[]
  usedRounds: number
  usedTokens: number
  rating: 'good' | 'meh' | 'bad'
  note?: string
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
  /** R2：本次会议选中的 skill 名称清单；空 = 未选。 */
  skills: string[]
  /** R2.2/D5：skill 传递方式（relay / direct）。 */
  skillDelivery: string
  budget: WireBudget
  nodes: WireNode[]
  edges: WireEdge[]
  pendingDecisions: WirePendingDecision[]
  pendingActions: WirePendingAction[]
  review: WireReview | null
  digest: string
  messages: WireMessage[]
  recent: WireUtterance[]
}

/** B3 用户自建角色预设（设置页维护；专家管理面板一键填充）。
 *  与 host `types.ts` 的 `RolePreset` 逐字对应。 */
export interface WireRolePreset {
  id: string
  name: string
  role: string
  /** 可选 provider 路由；必须与 model 同时存在才生效。 */
  provider?: string
  /** 可选模型名；空 = 继承主持人。 */
  model?: string
}

/** B3+ 阵容预设的一位成员（与 host `types.ts` 的 `RoleSquadMember` 对应）。
 *  阵容只回答"请哪几位专家"，不描述会议怎么开。 */
export interface WireRoleSquadMember {
  key: string
  role: string
  provider?: string
  model?: string
}

/** B3+ 阵容预设（一次套用多位专家）。 */
export interface WireRoleSquad {
  id: string
  name: string
  members: WireRoleSquadMember[]
}

export interface RoundTablePrefs {
  defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  maxRounds: number
  maxTokens: number
  /** 互通开关：true=显示所有圆桌会议；false=仅显示当前对话开启的会议。 */
  showAllMeetings: boolean
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  expertMaxTokens: number
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  expertMaxOpinions: number
  /** E1/E4 反馈：会议结束后是否询问轻量反馈；false = 永久关闭。 */
  feedbackEnabled: boolean
  /** R2.2/D5：skill 传递方式（relay=主持人中转；direct=专家自行调用）。 */
  skillDelivery: 'relay' | 'direct'
  /** R3：右栏隐藏的面板 id 清单；空 = 全部显示。 */
  hiddenPanels: string[]
  /** A1：画布图例已被用户关闭（true = 不显示）。默认 false。 */
  legendHidden: boolean
  /** B3：用户自建角色预设（全局；不预置内置角色）。 */
  rolePresets: WireRolePreset[]
  /** B3+：用户自建阵容预设（全局；不预置内置阵容）。 */
  squads: WireRoleSquad[]
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
