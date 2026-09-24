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
import { nodePersona, nodeWelcome } from './prompt.ts'
import type { ExpertLimits, NodeSkillContext } from './prompt.ts'

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

// 提示词资产（usage 段 / 专家 persona / 交接信封）集中在 prompt.ts：它是纯文本
// 生成、零运行时依赖，因此可以被 test/ 直接 import 做体积护栏。这里只做转发
// 与类型再导出，保证既有调用点不受影响。
export { nodePersona, nodeWelcome }
export type { ExpertLimits, NodeSkillContext }

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

/**
 * Interrupt one node **without** needing a live captain Agent.
 *
 * `ctx.subagents.interrupt` needs an ancestor Agent as its authority, so it is
 * useless on paths that only hold session ids (the RPC surface, or a captain
 * whose Agent is offline). The host's remote face is explicitly documented as
 * "what keeps a live child interruptible while its parent Agent is offline".
 *
 * @returns true when the host accepted the request.
 */
export function interruptNodeByParent(ctx: Context, childId: string, parentSessionId: string): boolean {
  if (childId === '' || parentSessionId === '') return false
  const subagents = ctx.subagents as unknown as {
    interruptByParent?: (childId: SessionId, parentId: SessionId, mode: 'continuable') => unknown
  }
  if (typeof subagents.interruptByParent !== 'function') return false
  try {
    subagents.interruptByParent(childId as SessionId, parentSessionId as SessionId, 'continuable')
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`roundtable: interruptByParent of node ${childId} failed: ${String(error)}`)
    return false
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
