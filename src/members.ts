/**
 * Expert-node subagent lifecycle: spawn one continuable child per node,
 * deliver messages into its next FIFO turn, interrupt it, and observe its
 * live activity. Mirrors the AgentTeams member pattern against the
 * 0.1.2-rc.1 subagent seam.
 *
 * Node personas are the《全局协作总纲》plus node-specific rules; the charter
 * is injected so every node carries the four-section protocol.
 * @module dsh-plugin-roundtable/members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { Meeting, MeetingNode, SkillDelivery } from './types.ts'
import { ACTIVE_NODE_STATUSES, CAPTAIN_KEY } from './types.ts'

/** Runtime knobs for node spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Node delegation depth cap (1 by default: experts may not spawn teams of their own). */
  maxDepth?: number
}

/** Node display label prefix persisted as the child's creation label. */
const NODE_LABEL_PREFIX = 'roundtable:'

/** Captain-only RoundTable tools hidden from expert nodes. */
const NODE_DENIED_TOOLS: readonly string[] = [
  'roundtable_create',
  'roundtable_plan_meeting',
  'roundtable_add_node',
  'roundtable_remove_node',
  'roundtable_connect',
  'roundtable_disconnect',
  'roundtable_request_decision',
  'roundtable_set_budget',
  'roundtable_close',
  'roundtable_collect_review',
  'roundtable_finish_review',
  'roundtable_export_review',
  'roundtable_export_meeting',
  'roundtable_kb_digest',
]

/**
 * 专家节点在 direct 模式下可以保留的工具白名单。
 *
 * `allow` 的语义是"只有列出的全局工具保持可见"，因此这里必须列全专家
 * 真正需要的工具（文件/搜索/shell/技能/协作/自身管理）；一旦宿主改名，
 * 专家会失去该能力但**不会**因此获得额外权限 —— 这是刻意选择的失败方向。
 * `deny` 仍然保留（两者是与关系）：它保证将来有人从本清单里删掉某项时，
 * 主持人专属工具不会顺带被放开。
 */
const NODE_ALLOWED_TOOLS: readonly string[] = [
  // 只读本地信息 + 写自己的产出
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'glob',
  'grep',
  'pwsh',
  'bash',
  'todo_write',
  'web_search',
  'web_fetch',
  // 会话自身管理（maxDepth=1 限制专家不得再开团队）
  'send_message',
  'interrupt_agent',
  'list_agents',
  'list_subagent_models',
  'job_list',
  'job_output',
  'job_kill',
  // 协作通道（与主持人共享）
  'roundtable_speak',
  'roundtable_send_message',
  'roundtable_summarize',
  'roundtable_status',
  'roundtable_actions_clear',
  'roundtable_start_review',
  'roundtable_proxy_think',
  // R2.3：direct 模式下专家自行加载 skill
  'skill',
]

/** The node's tool restriction: deny captain-only tools, and — in direct
 *  skill-delivery mode — narrow the surface to the explicit expert allowlist
 *  so the host's `skill` loader is reachable from a node. */
export function nodeToolRestriction(skillDelivery: SkillDelivery = 'relay'): ToolRestriction {
  if (skillDelivery === 'direct') {
    return { allow: [...NODE_ALLOWED_TOOLS], deny: [...NODE_DENIED_TOOLS] }
  }
  return { deny: [...NODE_DENIED_TOOLS] }
}

/** Per-expert answer limits resolved from settings at spawn time. */
export interface ExpertLimits {
  /** Per-request output token cap (model max_tokens); 0 = unlimited. */
  maxTokens?: number
  /** Max opinions per round (prompt-level constraint); 0 = unlimited. */
  maxOpinions?: number
}

/** 节点 persona 需要的 skill 上下文（R2：会议选中的 skill 与传递方式）。 */
export interface NodeSkillContext {
  /** 选择随 persona 注入的 skill 名称（缺省取 meeting.skills）。 */
  names?: readonly string[]
  /** 缺省取 meeting.skillDelivery。 */
  delivery?: SkillDelivery
  /** host 是否真的注册了 `skill` 工具（未注册时不得让专家去调它）。 */
  skillToolAvailable?: boolean
}

/**
 * skill 段落：把"选了哪些 skill / 用哪种方式"写进 persona。
 *
 * direct 模式下这是**必须**的：`skill` 工具本身不带白名单参数，专家只有
 * 在 persona 里被告知可用清单，才知道能调什么（R2.3）。
 */
function skillSection(meeting: Meeting, skill: NodeSkillContext): string {
  const names = (skill.names ?? meeting.skills ?? []).filter((name) => name !== '')
  const delivery = skill.delivery ?? meeting.skillDelivery ?? 'relay'
  if (names.length === 0 && delivery !== 'direct') return ''
  const list = names.length === 0 ? '（本次会议未选中任何 skill）' : names.map((name) => `\`${name}\``).join('、')
  if (delivery === 'direct') {
    const usable = names.length > 0 && skill.skillToolAvailable === true
    return [
      '',
      `6. 本次会议选中的 skill：${list}。传递方式为「专家直接调用」：${usable
        ? '需要 skill 的完整说明时，你自己调用 `skill` 工具（参数 name 传上方清单里的 skill 名）加载全文，然后严格按其约束工作；也可以加载清单之外的其他 skill。'
        : '当前会话的 `skill` 工具不可用或未选中 skill，请不要尝试调用它，改用你自己的通用能力完成任务。'}`,
    ].join('\n')
  }
  return [
    '',
    `6. 本次会议选中的 skill：${list}。传递方式为「主持人中转」：主持人会按需读取 skill 正文并把要点转交给你，你不需要也不应该自己调用 \`skill\` 工具；把这些 skill 的约束当作既定的工作前提。`,
  ].join('\n')
}

/** The node's system prompt (persona): the charter plus node working rules. */
export function nodePersona(
  meeting: Meeting,
  node: MeetingNode,
  stateDir: string,
  limits: ExpertLimits = {},
  skill: NodeSkillContext = {},
): string {
  const modeRule = meeting.mode === 'egalitarian'
    ? `- 协作模式为"多模型平等"：你可以用 roundtable_send_message 直接与任何其他节点（或主持人）交换意见，无需主持人中转。`
    : `- 协作模式为"主持人统筹"：你只向主持人汇报；主持人会转达其他节点的观点给你。`
  const opinionRule = limits.maxOpinions !== undefined && limits.maxOpinions > 0
    ? `\n- 每轮最多提出 ${limits.maxOpinions} 条意见：宁缺毋滥，只保留最有价值、直接服务于议题的要点。`
    : ''
  return `${meeting.charter}

你现在是会议"${meeting.name}"中的专家节点 ${node.key}${node.role !== undefined && node.role !== '' ? `，角色：${node.role}` : ''}。

工作规则：
1. 收到主持人的消息或任务后，完整执行一整轮工作，然后用 roundtable_speak 把你的产出写入会议记录（to 留空表示交给汇聚网关；定向回复某人时填对方节点名）。
2. 发言遵循总纲第三节的格式：[当前状态] 开头、[核心产出] 与 [下一步建议] 结尾，严禁废话。
3. 会议状态文件位于 ${stateDir}/${meeting.id}/（meeting.json 与 transcript.jsonl）。你可以只读查看，但严禁直接修改；一切状态变更走 roundtable_* 工具。
4. 你是专家，不是主持人：不要创建/移除节点、不要修改连线、不要发起人类决策、不要结束会议、不要为别人下发会议设置卡片。
5. 遇到无法独自决定的分歧，在发言中建议主持人触发 [需人类决策]，严禁替用户拍板。${skillSection(meeting, skill)}
${modeRule}

回答限制（省 token，务必遵守）：
- 只回答与议题直接相关的内容；无关问题一律不答，直接说明"与议题无关"。
- 不用假设代替事实；不确定就明确说"不确定"，严禁编造。
- 不举无关的例子；举例必须直接服务于论点。
- 语言简洁明了，不使用华丽修辞、空话、套话；能一句话说清的不用两句话。${opinionRule}`
}

/** The initial user message delivered when the node is created. */
export function nodeWelcome(meeting: Meeting, node: MeetingNode): string {
  return `你已加入圆桌会议"${meeting.name}"（会议 id ${meeting.id}）作为专家节点 ${node.key}。主持人会通过消息给你布置任务或转达其他节点的观点；收到后执行一整轮工作并用 roundtable_speak 汇报。现在等待主持人的指令。`
}

/**
 * Spawn one node as a durable continuable subagent of the captain and fill
 * `node.id` with its child session id. On failure nothing is persisted.
 */
export async function spawnNode(
  ctx: Context,
  config: MemberRuntimeConfig,
  meeting: Meeting,
  node: MeetingNode,
  captain: Agent,
  stateDir: string,
  signal: AbortSignal,
  limits: ExpertLimits = {},
  skill: NodeSkillContext = {},
): Promise<void> {
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `roundtable: no subagent provider "${config.provider}" is registered (available: ${ctx.subagents.list().join(', ') || 'none'}) — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`roundtable: provider "${config.provider}" does not support continuable nodes`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`roundtable: provider "${config.provider}" cannot apply a node persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`roundtable: provider "${config.provider}" cannot restrict captain-only tools for nodes`)
  }

  const label = `${NODE_LABEL_PREFIX}${meeting.id}:${node.key}`
  // Per-request output cap: model max_tokens applied to every conversation
  // request the node makes (0/unset = the provider's own default).
  const agentOptions: {
    provider?: string
    model?: string
    reasoningEffort?: ReasoningEffortId
    maxTokens?: number
  } = {}
  if (node.provider !== undefined && node.model !== undefined) {
    agentOptions.provider = node.provider
    agentOptions.model = node.model
  }
  // Reasoning effort is an adapter-owned OPAQUE id: this plugin stores and
  // forwards the string, and the selected model's capability decides whether
  // it means anything. Absent = the child inherits the captain's
  // route-owned effort (see @deepseek-ai/dsh-subagent resolveChildAgentOptions).
  const reasoningEffort = node.reasoningEffort?.trim() ?? ''
  if (reasoningEffort !== '') {
    agentOptions.reasoningEffort = ReasoningEffortId(reasoningEffort)
  }
  if (limits.maxTokens !== undefined && limits.maxTokens > 0) {
    agentOptions.maxTokens = limits.maxTokens
  }
  const delivery = skill.delivery ?? meeting.skillDelivery ?? 'relay'
  // The `skill` tool is only reachable when the host actually registered it in
  // this agent's surface — never tell a node to call a loader it cannot see.
  const skillToolAvailable = ctx.tools.get('skill', captain) !== undefined
  const started = await ctx.subagents.startContinuable({
    provider: config.provider,
    label,
    request: {
      prompt: [{ type: 'text', text: nodeWelcome(meeting, node) }] as ContentBlock[],
      parent: captain,
      persona: nodePersona(meeting, node, stateDir, limits, { ...skill, delivery, skillToolAvailable }),
      toolFilter: nodeToolRestriction(delivery),
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
    },
    signal,
  })
  node.id = String(started.childId)
}

/**
 * Deliver one message to a node as its next FIFO turn. Best effort: a failure
 * is logged and reported as `false` so the caller can decide.
 */
export async function deliverToNode(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await ctx.subagents.sendMessage(
      captain,
      childId as SessionId,
      [{ type: 'text', text }],
      { signal },
    )
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`roundtable: followup to node ${childId} failed: ${String(error)}`)
    return false
  }
}

/** Request cancellation of one live node's current turn (fire and return). */
export function interruptNode(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(childId as SessionId, { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`roundtable: interrupt of node ${childId} failed: ${String(error)}`)
  }
}

/** Steer a live message into the captain at its nearest model boundary (best effort). */
export function steerCaptain(captain: Agent, text: string): boolean {
  try {
    captain.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-roundtable' },
    }))
    return true
  } catch {
    return false
  }
}

/** Resolve the real driver activity for durable node ids. */
export function nodeActivity(
  ctx: Context,
  nodes: readonly MeetingNode[],
): Map<string, 'running' | 'idle' | 'ready'> {
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const node of nodes) {
    if (node.id === '' || !ACTIVE_NODE_STATUSES.includes(node.status)) continue
    const live = ctx.agents.get(node.id as SessionId)
    activity.set(node.key, live === undefined ? 'ready' : live.status)
  }
  return activity
}

export { CAPTAIN_KEY }
