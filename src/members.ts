/**
 * Expert-node subagent lifecycle: spawn one continuable child per node,
 * deliver messages into its next FIFO turn, interrupt it, and observe its
 * live activity. Mirrors the AgentTeams member pattern against the
 * 0.1.1-rc.2 subagent seam.
 *
 * Node personas are the《全局协作总纲》plus node-specific rules; the charter
 * is injected so every node carries the four-section protocol.
 * @module dsh-plugin-roundtable/members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { Meeting, MeetingNode } from './types.ts'
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
  'roundtable_add_node',
  'roundtable_remove_node',
  'roundtable_connect',
  'roundtable_disconnect',
  'roundtable_request_decision',
  'roundtable_set_budget',
  'roundtable_close',
]

/** The node's tool restriction (deny captain-only tools). */
export function nodeToolRestriction(): ToolRestriction {
  return { deny: [...NODE_DENIED_TOOLS] }
}

/** The node's system prompt (persona): the charter plus node working rules. */
export function nodePersona(meeting: Meeting, node: MeetingNode, stateDir: string): string {
  const modeRule = meeting.mode === 'egalitarian'
    ? `- 协作模式为"多模型平等"：你可以用 roundtable_send_message 直接与任何其他节点（或主持人）交换意见，无需主持人中转。`
    : `- 协作模式为"主持人统筹"：你只向主持人汇报；主持人会转达其他节点的观点给你。`
  return `${meeting.charter}

你现在是会议"${meeting.name}"中的专家节点 ${node.key}${node.role !== undefined && node.role !== '' ? `，角色：${node.role}` : ''}。

工作规则：
1. 收到主持人的消息或任务后，完整执行一整轮工作，然后用 roundtable_speak 把你的产出写入会议记录（to 留空表示交给汇聚网关；定向回复某人时填对方节点名）。
2. 发言遵循总纲第三节的格式：[当前状态] 开头、[核心产出] 与 [下一步建议] 结尾，严禁废话。
3. 会议状态文件位于 ${stateDir}/${meeting.id}/（meeting.json 与 transcript.jsonl）。你可以只读查看，但严禁直接修改；一切状态变更走 roundtable_* 工具。
4. 你是专家，不是主持人：不要创建/移除节点、不要修改连线、不要发起人类决策、不要结束会议。
5. 遇到无法独自决定的分歧，在发言中建议主持人触发 [需人类决策]，严禁替用户拍板。
${modeRule}`
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
  const started = await ctx.subagents.startContinuable({
    provider: config.provider,
    label,
    request: {
      prompt: [{ type: 'text', text: nodeWelcome(meeting, node) }] as ContentBlock[],
      parent: captain,
      persona: nodePersona(meeting, node, stateDir),
      toolFilter: nodeToolRestriction(),
      ...(node.provider !== undefined && node.model !== undefined
        ? { agentOptions: { provider: node.provider, model: node.model } }
        : {}),
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
    await ctx.subagents.followup(
      captain,
      childId as SessionId,
      [{ type: 'text', text }],
      {
        source: { kind: 'plugin', plugin: 'dsh-plugin-roundtable' },
        signal,
      },
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
