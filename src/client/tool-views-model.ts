/**
 * `roundtable_status` tool view 的纯逻辑（第 4 批）。
 *
 * 与渲染分离的原因很实际：Node 的类型剥离**不支持 JSX**，所以放在 `.tsx` 里的
 * 解析函数无法被零依赖单测直接 import。这里只留可测的判定，组件（tool-views.tsx）
 * 只负责画。
 *
 * @module @huanlin/dsh-plugin-roundtable/client/tool-views-model
 */

/** Structural view of the owner block this view needs (no host type import). */
export interface ToolBlockLike {
  kind?: string
  isError?: boolean
  call?: { name?: string; argsRaw?: string } | null
  content?: readonly { type?: string; text?: string }[]
}

/** Parsed subset of one `roundtable_status` payload. */
export interface StatusPayload {
  meeting_name?: unknown
  mode?: unknown
  status?: unknown
  round?: unknown
  budget?: { used_tokens?: unknown; max_tokens?: unknown; max_rounds?: unknown } | null
  nodes?: readonly { key?: unknown; status?: unknown; activity?: unknown; last_error?: unknown }[] | null
  pending_decisions?: readonly unknown[] | null
  pending_actions?: readonly unknown[] | null
}

/** Flatten the text blocks of a settled tool result. */
export function blockTextOf(block: unknown): string {
  const node = block as ToolBlockLike | undefined
  const content = node?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const piece of content) {
    if (piece?.type === 'text' && typeof piece.text === 'string') parts.push(piece.text)
  }
  return parts.join('\n').trim()
}

/**
 * Parse a `roundtable_status` result; `null` when it is anything else.
 *
 * Deliberately claims only this tool's own shape: a payload without a string
 * `meeting_name` falls back to the generic rendering rather than being forced
 * into a card that would show blanks.
 */
export function parseStatusPayload(text: string): StatusPayload | null {
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const candidate = parsed as StatusPayload
  if (typeof candidate.meeting_name !== 'string') return null
  return candidate
}

/** Display a payload field without ever printing `undefined`. */
export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * One expert node line: `key status/activity`, plus the failure note the node
 * left behind (`last_error` is what makes "这位专家到底跑起来了没有" answerable,
 * and `missing` means the host no longer knows that subagent at all).
 */
export function nodeLine(node: {
  key?: unknown
  status?: unknown
  activity?: unknown
  last_error?: unknown
}): string {
  const activity = fieldText(node.activity)
  const parts = [`  · ${fieldText(node.key)}`, `${fieldText(node.status)}/${activity}`]
  if (activity === 'missing') parts.push('⚠ 宿主已不认识该子代理')
  const error = fieldText(node.last_error)
  if (error !== '') parts.push(`⚠ ${error}`)
  return parts.join(' ')
}
