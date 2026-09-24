/**
 * 专家子代理的生命周期接入（第 1 批）。
 *
 * 背景（来自真实会议数据）：专家的产出**只在它主动调用 `roundtable_speak`
 * 的那一刻**才落盘。v0-2-36 那场评审里，一位红队专家完成了大量取证，却在
 * speak 之前进程中断 —— 观点全丢，`review.json` 永久停在 `reviewing`、
 * `viewpoints` 为空。同时 9 条被拉起的路由里 4 条 0 产出，而插件只留下一个
 * `removed` 墓碑，没有任何失败原因，只能靠主持人用自然语言反复催办。
 *
 * 宿主其实早就把两件事递到手上：
 * - `subagent/end` 带 `lastAssistantMessage`，且官方说明 **可续聊子代理的
 *   每一个 activation epoch 都会发这个事件** —— 于是产出能在 `speak` 之外被
 *   自动捕获，中途中断也不会全丢；
 * - 同一事件带 `stopReason`（`error` / `max-tokens` / `aborted` …），基础设施
 *   级失败时 `lastAssistantMessage` 为空；而 `agent/request-error` 进一步带
 *   `provider` 与 `failure: LlmFailure`（含 HTTP `status`），于是"为什么拉不
 *   起来"（额度、鉴权、模型名写错）可以被写成 `node.lastError`。
 *
 * 索引是**进程内**的：childId → (stateRoot, meetingId)。冷启动后的旧节点无法
 * 归属，这是刻意的 —— 宁可漏捕获，也不要把别的会话的文本写进会议记录。
 *
 * @module dsh-plugin-roundtable/node-events
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { estimateTokens } from './budget.ts'
import { appendUtterance, readMeeting, withMeetingLock, writeMeeting } from './state.ts'
import { ACTIVE_NODE_STATUSES } from './types.ts'
import type { MeetingNode, MeetingUtterance } from './types.ts'

/** Where one node's meeting lives on disk. */
export interface NodeLocation {
  stateRoot: string
  meetingId: string
}

/** childId → meeting location. Process-local on purpose (see module docs). */
const nodeIndex = new Map<string, NodeLocation>()

/** Remember which meeting a freshly spawned node belongs to. */
export function registerNodeChild(childId: string, location: NodeLocation): void {
  if (childId === '') return
  nodeIndex.set(childId, location)
}

/** Drop one node's index entry (node removed, or failed spawn rolled back). */
export function forgetNodeChild(childId: string): void {
  if (childId === '') return
  nodeIndex.delete(childId)
}

/** Look up a node's meeting by its child session id. */
export function locateNodeChild(childId: string): NodeLocation | undefined {
  return nodeIndex.get(childId)
}

/** Test-only: clear the process-local index. */
export function __resetNodeIndexForTests(): void {
  nodeIndex.clear()
}

/** Meeting-level lock key; mirrors `meetingLockKey` in tools.ts. */
function lockKey(location: NodeLocation): string {
  return `meeting:${location.stateRoot}:${location.meetingId}`
}

/** Flatten the text blocks of one assistant output (empty when there is none). */
export function blocksToText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/** What one settled child run means for its node. */
export interface NodeEndOutcome {
  /** Captured output; empty string means the child produced nothing usable. */
  text: string
  /** Readable reason, written to `node.lastError` when `text` is empty. */
  note: string
}

/**
 * Decide what a settled child run contributes to its meeting.
 *
 * A run that ends `completed` but carries no text is *not* a hard failure (the
 * expert may have only acknowledged), so it gets its own wording — the point is
 * to never leave the captain guessing between "still working" and "died".
 */
export function describeNodeEnd(info: {
  readonly stopReason?: string
  readonly lastAssistantMessage?: readonly ContentBlock[]
}): NodeEndOutcome {
  const text = blocksToText(info.lastAssistantMessage)
  if (text !== '') return { text, note: '' }
  const reason = info.stopReason ?? 'unknown'
  return {
    text: '',
    note: reason === 'completed'
      ? '本轮结束但没有产出内容（可能只回了确认，未见 roundtable_speak）'
      : `本轮未产出内容（stopReason=${reason}）`,
  }
}

/** One-line readable description of a provider request failure. */
export function describeRequestFailure(
  provider: string,
  failure: { message?: string; code?: string; status?: number } | undefined,
): string {
  const status = typeof failure?.status === 'number' ? ` HTTP ${failure.status}` : ''
  const code = typeof failure?.code === 'string' && failure.code !== '' ? ` ${failure.code}` : ''
  const message = typeof failure?.message === 'string' ? failure.message.trim().slice(0, 200) : ''
  return `请求失败（provider=${provider}${status}${code}）${message === '' ? '' : `：${message}`}`
}

/** Write one node-level note (cleared by passing `undefined`). */
async function writeNodeNote(location: NodeLocation, childId: string, note: string | undefined): Promise<void> {
  await withMeetingLock(lockKey(location), async () => {
    const meeting = await readMeeting(location.stateRoot, location.meetingId)
    if (meeting === undefined) return
    const node = meeting.nodes.find((candidate) => candidate.id === childId && candidate.status !== 'removed')
    if (node === undefined) return
    if (node.lastError === note) return
    node.lastError = note
    meeting.updatedAt = Date.now()
    await writeMeeting(location.stateRoot, meeting)
  })
}

/**
 * Capture one settled child run.
 *
 * With output: append it as an `auto-capture` utterance and clear `lastError`,
 * so a node that spoke via the event path still lands in the transcript even
 * though it never called `roundtable_speak`.
 * Without output: leave a readable `lastError` on the node.
 */
async function onNodeEnd(
  ctx: Context,
  info: { readonly id?: unknown; readonly stopReason?: string; readonly lastAssistantMessage?: readonly ContentBlock[] },
): Promise<void> {
  const childId = String(info.id ?? '')
  if (childId === '') return
  const location = locateNodeChild(childId)
  if (location === undefined) return
  const outcome = describeNodeEnd(info)
  try {
    if (outcome.text === '') {
      await writeNodeNote(location, childId, outcome.note)
      return
    }
    await withMeetingLock(lockKey(location), async () => {
      const meeting = await readMeeting(location.stateRoot, location.meetingId)
      if (meeting === undefined) return
      const node = meeting.nodes.find((candidate) => candidate.id === childId && candidate.status !== 'removed')
      if (node === undefined) return
      const utterance: MeetingUtterance = {
        id: randomUUID(),
        nodeKey: node.key,
        kind: 'auto-capture',
        content: outcome.text,
        round: meeting.round,
        ts: Date.now(),
      }
      await appendUtterance(location.stateRoot, meeting.id, utterance)
      meeting.budget.usedTokens += estimateTokens(outcome.text)
      node.lastError = undefined
      meeting.updatedAt = Date.now()
      await writeMeeting(location.stateRoot, meeting)
    })
  } catch (error: unknown) {
    ctx.logger.warn(`roundtable: capturing output of node ${childId} failed: ${String(error)}`)
  }
}

/** Remember the last provider failure per node (observability, not recovery). */
function onRequestError(
  ctx: Context,
  payload: { agent?: unknown; provider?: unknown; failure?: { message?: string; code?: string; status?: number } },
): void {
  const agentId = String((payload.agent as { id?: unknown } | undefined)?.id ?? '')
  if (agentId === '') return
  const location = locateNodeChild(agentId)
  if (location === undefined) return
  const note = describeRequestFailure(String(payload.provider ?? ''), payload.failure)
  void writeNodeNote(location, agentId, note).catch((error: unknown) => {
    ctx.logger.warn(`roundtable: recording request failure of node ${agentId} failed: ${String(error)}`)
  })
}

/**
 * Subscribe the two host events that make expert output and expert failure
 * visible.
 *
 * Deliberately non-invasive: `subagent/end` is a plain emit, and the
 * `agent/request-error` waterfall listener always delegates through `next()` so
 * the host's own retry/recovery policy is untouched — this plugin only observes.
 */
export function attachNodeEvents(ctx: Context): void {
  ctx.on('subagent/end', (info) => {
    void onNodeEnd(ctx, info as { id?: unknown; stopReason?: string; lastAssistantMessage?: readonly ContentBlock[] })
  })
  ctx.on('agent/request-error', (payload, next) => {
    try {
      onRequestError(ctx, payload as Parameters<typeof onRequestError>[1])
    } catch {
      // 观测失败绝不能影响宿主的错误处理链路。
    }
    return next()
  })
}

/** Node liveness, refined by asking the host's own subagent tree. */
export type NodeLiveness = 'running' | 'idle' | 'ready' | 'missing'

/** Host-known durable child ids; `undefined` when the catalog is unavailable. */
async function knownChildIds(ctx: Context, parentSessionId: string): Promise<Set<string> | undefined> {
  try {
    const children = await ctx.subagents.listChildren(parentSessionId as SessionId)
    return new Set(children.map((child) => String(child.id)))
  } catch (error: unknown) {
    // 目录不可用（老宿主 / 未挂载持久化）时不做判定，退回旧语义。
    ctx.logger.warn(`roundtable: listing child subagents failed: ${String(error)}`)
    return undefined
  }
}

/**
 * Reconcile node liveness against the host's real subagent tree.
 *
 * `ctx.agents.get(id)` only knows **live** drivers, so a node whose process is
 * gone looks exactly like one that is merely between turns — both report
 * `ready`, and the captain cannot tell "待唤醒" from "已经没了". Asking the
 * durable catalog separates them: an id the host still lists is a cold-but-real
 * child, an id it no longer knows is `missing` — which is precisely the old
 * "把消息投进死节点、静默丢一整轮" failure seen in the meeting records.
 *
 * Runs one listing per meeting (not per node) and degrades to the previous
 * semantics when the catalog is unavailable.
 */
export async function reconcileNodeLiveness(
  ctx: Context,
  captainSessionId: string,
  nodes: readonly MeetingNode[],
): Promise<Map<string, NodeLiveness>> {
  const result = new Map<string, NodeLiveness>()
  let catalog: Set<string> | undefined
  for (const node of nodes) {
    if (node.id === '' || !ACTIVE_NODE_STATUSES.includes(node.status)) continue
    const live = ctx.agents.get(node.id as SessionId)
    if (live !== undefined) {
      result.set(node.key, live.status === 'running' ? 'running' : 'idle')
      continue
    }
    if (catalog === undefined) catalog = await knownChildIds(ctx, captainSessionId)
    result.set(node.key, catalog === undefined || catalog.has(node.id) ? 'ready' : 'missing')
  }
  return result
}
