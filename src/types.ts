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

/** Collaboration mode: captain orchestrates every exchange, experts talk
 *  peer-to-peer, or a 针锋相对 (red-team) review of a settled plan. */
export type MeetingMode = 'orchestrated' | 'egalitarian' | 'redteam'

/** skill 传递方式（D5）：主持人中转 / 专家直接调用。 */
export type SkillDelivery = 'relay' | 'direct'

/** Meeting lifecycle. `muted` = budget exceeded (闭麦); user may top up or close.
 *
 *  `archived` is a RESERVED state: no code path in this plugin ever writes it
 *  (meeting archiving / read-only mode is deliberately out of scope for this
 *  release). The guards that test for it are kept on purpose — they are
 *  defensive branches, not dead weight, so implementing archiving later cannot
 *  silently miss a call site. */
export type MeetingStatus = 'active' | 'muted' | 'ended' | 'archived'

/** One expert node's lifecycle status. */
export type NodeStatus = 'idle' | 'working' | 'ready' | 'removed'

/** Edge direction: forward (pipeline) or bidirectional (debate channel). */
export type EdgeDirection = 'forward' | 'bidirectional'

/** What one transcript line records. */
export type UtteranceKind = 'speech' | 'proxy-thinking' | 'retrieval' | 'decision' | 'auto-capture'

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
  /** Resolved reasoning effort captured when this node was created.
   *  An adapter-owned opaque id (e.g. `high` / `medium` / `low` — the exact
   *  vocabulary belongs to the model capability, not to this plugin). Read by
   *  `spawnNode` into `agentOptions.reasoningEffort` and surfaced by
   *  `roundtable_status`; absent = inherit the captain's route-owned effort. */
  reasoningEffort?: string
  status: NodeStatus
  joinedAt: number
  /** 最近一次失败的可读说明（第 1 批）。子代理以 error 结束、或 provider 请求
   *  失败时写入，下一次成功产出时清除 —— 让"这位专家到底跑起来了没有"在
   *  `roundtable_status` 里直接可见，而不是只留一个 removed 墓碑。 */
  lastError?: string
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
  /**
   * 最近一次测得的 **provider 上报**用量（第 3 批）。与 `usedTokens`（发言文本
   * 粗估）**并列而非替代** —— 熔断口径不变，仍走 `usedTokens`。缺省/0 表示
   * 此刻没有可测的 live 子会话。
   */
  usedTokensReal?: number
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

/** 用户自建的角色预设（B3）。
 *
 *  全局偏好（`settings.yaml` 的 `roundtable` 命名空间），不属于任何一场会议：
 *  新建/编辑/删除预设都不会影响已创建的会议。它只是"专家管理"表单的填充
 *  来源 —— 选中后把 role/provider/model 三个字段写进同一条 `add-node`
 *  user-action，链路与手填完全一致（不需要新链路）。 */
export interface RolePreset {
  /** 稳定 id（新建时生成；编辑与删除都按 id 定位）。 */
  id: string
  /** 预设名称，如"安全审查"。 */
  name: string
  /** 角色说明，最终写进专家节点的 role。 */
  role: string
  /** 可选 LLM provider 路由；必须与 model 同时给出才生效。空 = 继承主持人。 */
  provider?: string
  /** 可选模型名；空 = 继承主持人。 */
  model?: string
}

/** 知识库摘要缓存（C2）的一条条目。
 *
 *  失效键 = `path + size + mtimeMs`：任一变化即视为失效。宿主
 *  `listKbDirectory()` 本来就在 stat 每个条目，所以比对不产生额外 IO。
 *  本插件**不自己调 LLM 生成摘要** —— digest 由主持人读过文件后写下，
 *  缓存只负责"命中就不必再读第二遍"（你读 + 专家读 = 双倍 token）。 */
export interface KbDigestEntry {
  /** 知识库中被读取条目的绝对路径。 */
  path: string
  /** 失效键：写摘要时的文件大小（字节）。 */
  size: number
  /** 失效键：写摘要时的修改时间（ms）。 */
  mtimeMs: number
  /** 主持人写下的要点摘要（不是全文）。 */
  digest: string
  /** 摘要写入时间（ms），超限时按最旧淘汰。 */
  ts: number
}

/** `<meetingDir>/kb-digest.json` 的形状（独立文件，避开 meeting.json 竞态）。 */
export interface KbDigestFile {
  meetingId: string
  entries: KbDigestEntry[]
  updatedAt: number
}

/** The full durable meeting record (transcript lives in transcript.jsonl). */
export interface Meeting {
  /**
   * 数据格式版本（`meeting.json` 的形状版本）。
   *
   * 与 `ReviewRecord.schemaVersion` 同一套机制：**缺失视为 1**（v0.2.36 及
   * 之前写出的文件都没有这个字段）。读取时由 `normalizeMeeting()` 在内存里
   * 幂等升到当前版本，下次 `writeMeeting` 顺带落盘。
   *
   * 存在的理由：`meeting.json` 是本插件最核心的持久化文件，此前却是唯一
   * 「裸 `JSON.parse(...) as Meeting`」——形状一变，老文件要么读出 undefined
   * 字段、要么静默损坏，且没有任何版本号可供分支。维护模式下「以后的改动
   * 会不会读不出老会议」必须有一个明确答案，这个字段就是那个答案。
   */
  schemaVersion?: number
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
  /** 本次会议选中的 skill 名称清单（来自 `ctx.skills.list()`）；空/缺省 = 未选。 */
  skills?: string[]
  /** skill 传递方式（创建时固化）：relay=主持人中转；direct=专家自行调用。 */
  skillDelivery?: SkillDelivery
  status: MeetingStatus
  createdAt: number
  updatedAt: number
}

/** 观点证据分级（C1）：代码/bug 类缺陷须给可复现步骤；设计类缺陷给论证链。 */
export interface ReviewEvidence {
  /** 证据类型：repro=可复现步骤；argument=论证链（设计类缺陷适用）。 */
  kind: 'repro' | 'argument'
  /** 证据正文：复现步骤（1. 2. 3.）或论证链。≤600 字符。 */
  text: string
}

/** 针锋相对评审：一个观点（红队专家提的一条缺陷，可能是发言拆分而来）。 */
export interface ReviewViewpoint {
  /** 行 id：`${utteranceId}#${seq}`（拆分后 seq≥1；未拆分整条 seq=0）。 */
  id: string
  /** 来源发言 id（collect 幂等键：同一发言只收集一次）。 */
  utteranceId: string
  /** 提出该观点的专家节点 key。 */
  nodeKey: string
  /** 缺陷内容（单条观点文本）。 */
  content: string
  /** 三态：pending=未操作；endorsed=用户支持认定为真实缺陷；rejected=用户审阅后否定。可互切。 */
  status: 'pending' | 'endorsed' | 'rejected'
  /** 驳回理由（C2：驳回必填；支持后改回 pending/rejected 不清除，供追溯）。 */
  rejectReason?: string
  /** 证据分级（C1）：LLM 拆分时按发言内容提取；无则 undefined。 */
  evidence?: ReviewEvidence
  /** 观点对应的原文引用子串（≤120 字符，无则 undefined）。 */
  quote?: string
  /** 维度标签（自由字符串，默认"其他"）。 */
  dimension: string
  ts: number
  /** 发言内序号：0=整条未拆分；≥1=拆分出的第 N 条。 */
  seq: number
}

/** 一轮已完成的评审快照（闭环复审 history 项）。 */
export interface ReviewPassSnapshot {
  pass: number
  question: string
  plan: string
  viewpoints: ReviewViewpoint[]
  finishedAt: number
  /** 该轮修订说明（主持人 finish_review 时附，供下一轮核对旧缺陷是否修复）。 */
  revisedPlanSummary?: string
}

/** 一条轻量用户反馈（E1/E3，工作区级 feedback.jsonl，匿名）。
 *  只记录结构化使用事实 + 用户主动填写的一句说明；绝不记录对话内容。 */
export interface FeedbackEntry {
  id: string
  ts: number
  /** 会议 id（仅稳定 id，不存会议名/内容，便于去重）。 */
  meetingId: string
  /** 协作模式（orchestrated / egalitarian / redteam）。 */
  mode: string
  /** 专家 provider 去重列表（如 ["zai-coding-cn"]）。 */
  providers: string[]
  /** 专家 model 去重列表（如 ["glm-5.2"]）。 */
  models: string[]
  /** 会议结束时预算用量。 */
  usedRounds: number
  usedTokens: number
  /** 1 键有用度：good / meh / bad。 */
  rating: 'good' | 'meh' | 'bad'
  /** 可选一句"最卡的点"（用户主动填写）。 */
  note?: string
}

/** 针锋相对评审记录（`<meetingDir>/review.json`，独立文件防 meeting.json 竞态）。 */
export interface ReviewRecord {
  meetingId: string
  /** 用户最初提出的问题。 */
  question: string
  /** 主持人提供的方案与说明。 */
  plan: string
  /** reviewing=评审进行中；ready=观点已收集，弹窗可展示；done=用户完成评审。 */
  status: 'reviewing' | 'ready' | 'done'
  /** 闭环复审（C3）：当前第几轮评审（首轮 = 1；每轮定稿后再开下一轮 +1）。 */
  reviewPass: number
  /** 闭环复审（C3）：最大评审轮数（首轮 + 最多复审 2 次 = 3）；达到上限后再想继续须用户显式批准。 */
  maxReviewPass: number
  /** 之前各轮已定稿的评审快照（闭环核对"旧缺陷是否修复"的依据）。 */
  history: ReviewPassSnapshot[]
  /** schema 版本：1=旧（endorsed 布尔）；2=三态 + 观点拆分（当前）。缺失视为 1。 */
  schemaVersion: 1 | 2
  viewpoints: ReviewViewpoint[]
  startedAt: number
  updatedAt: number
  /** 完成评审的时间（status → done 时写）。 */
  finishedAt?: number
}
