/**
 * 观点拆分（V0.2.2 批次 1）：collect_review 时把红队专家的一条发言用 LLM
 * 拆成 1~3 条独立观点，用户即可对单条观点「支持/驳回」。
 *
 * 三道防线（V0.2.2 方案定稿）：
 *  ① JSON schema 严格约束输出（tools 参数 + temperature 0）
 *  ② 任何解析失败 → 返回 null，调用方整条兜底（seq=0）
 *  ③ quote 必须是发言原文的子串（规范化后 indexOf），否则丢弃该 quote
 * @module dsh-plugin-roundtable/review-split
 */

import { randomUUID } from 'node:crypto'

/** 一条拆分结果。 */
export interface SplitLine {
  content: string
  quote?: string
  dimension: string
}

/** 拆分调用的模型路由配置（默认 deepseek-official/deepseek-v4-flash，实测可用）。 */
export interface ReviewSplitConfig {
  provider: string
  model: string
  /** 每条发言最多拆几条观点（默认 3）。 */
  maxOpinions: number
}

/** 最小化 LLM 服务形状（与 ctx.llm.stream 结构兼容）。 */
export interface SplitLlmLike {
  stream(options: {
    provider: string
    model: string
    messages: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: { kind: 'user' } }[]
    system?: string
    tools?: { name: string; description: string; parameters: Record<string, unknown> }[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** 拆分工具的 JSON schema（防线①）。 */
const SPLIT_TOOL = {
  name: 'split_redteam_viewpoint',
  description: '把一条红队专家发言拆成 1~3 条独立观点（每条观点只含一个缺陷）。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      viewpoints: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', description: '单条观点/缺陷的完整表述。' },
            quote: { type: 'string', description: '发言原文中与该观点对应的子串（可选，必须逐字来自发言原文）。' },
            dimension: { type: 'string', description: '维度标签，如 交互/数据/安全/性能/兼容/流程（不确定用"其他"）。' },
          },
          required: ['content', 'dimension'],
        },
      },
    },
    required: ['viewpoints'],
  },
} as const

const SPLIT_TIMEOUT_MS = 60_000

/** 调用 LLM 一次，收集工具调用参数（或文本 JSON）为字符串；失败返回 null。 */
async function callSplitLlm(
  llm: SplitLlmLike,
  config: ReviewSplitConfig,
  system: string,
  userText: string,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPLIT_TIMEOUT_MS)
  try {
    const chunks: string[] = []
    const stream = llm.stream({
      provider: config.provider,
      model: config.model,
      messages: [{
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      }],
      system,
      tools: [SPLIT_TOOL],
      temperature: 0,
      maxTokens: 1024,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const raw = chunk as {
        type?: string
        delta?: unknown
        text?: unknown
        argumentsDelta?: unknown
        block?: { type?: string; arguments?: unknown }
      }
      if (raw.type === 'tool-call-delta' && typeof raw.argumentsDelta === 'string') {
        chunks.push(raw.argumentsDelta)
      } else if (raw.type === 'block-end' && raw.block?.type === 'tool-call' && typeof raw.block.arguments === 'string') {
        chunks.push(raw.block.arguments)
      } else if (raw.type === 'text' && typeof raw.delta === 'string') {
        chunks.push(raw.delta)
      } else if (raw.type === 'text' && typeof raw.text === 'string') {
        chunks.push(raw.text)
      } else if (raw.type === 'text-delta' && typeof raw.text === 'string') {
        // dsh-llm 文本流式块：模型未走工具调用、直接输出 JSON 文本时的兜底收集。
        chunks.push(raw.text)
      }
    }
    const raw = chunks.join('')
    return raw.trim() === '' ? null : raw
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 本地启发式兜底拆分（零 token、确定性）：红队专家发言通常按
 * "**观点 N（指向 X，维度Y）**" 的固定结构分条，直接按该标记切段，
 * 并从段首括号里提取维度标签。找不到任何观点标记时返回 null，
 * 由调用方整条兜底（seq=0）。
 */
const VIEWPOINT_MARKER = /(?:\*{1,2})?\s*观点\s*(\d+)\s*[（(]([^）)]*)[）)]/g
const TAIL_SECTION = /\[(?:核心产出|下一步建议)[^\]]*\]/

export function splitByMarkers(content: string): SplitLine[] | null {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  const marks: { start: number; end: number; label: string; head: string }[] = []
  VIEWPOINT_MARKER.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = VIEWPOINT_MARKER.exec(trimmed)) !== null) {
    marks.push({ start: m.index, end: m.index + m[0].length, label: m[1] ?? '', head: m[2] ?? '' })
  }
  if (marks.length === 0) return null
  const lines: SplitLine[] = []
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    if (mark === undefined) continue
    const next = marks[i + 1]
    const rawEnd = next !== undefined ? next.start : trimmed.length
    let raw = trimmed.slice(mark.end, rawEnd)
    const tail = raw.search(TAIL_SECTION)
    if (tail !== -1) raw = raw.slice(0, tail)
    const text = raw.replace(/^[\s*:：]+/, '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const dims = (mark.head.match(/[①-④]/g) ?? []).join('+')
    lines.push({
      content: `观点 ${mark.label}（${mark.head}）：${text}`,
      dimension: dims !== '' ? `维度${dims}` : '其他',
      quote: undefined,
    })
  }
  return lines.length > 0 ? lines : null
}

/**
 * 拆分一条发言为若干独立观点；任何失败返回 null（调用方整条兜底）。
 * quote 与发言原文做规范化子串校验（防线③），不匹配即丢弃。
 */
export async function splitUtterance(
  llm: SplitLlmLike,
  config: ReviewSplitConfig,
  nodeKey: string,
  content: string,
): Promise<SplitLine[] | null> {
  const trimmed = content.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return null
  const system = '你是 RoundTable「针锋相对」评审的观点拆分器。把下面一条红队专家发言拆成 1~3 条独立观点，每条观点只包含一个缺陷，不得发明原文没有的内容。必须调用 split_redteam_viewpoint 工具返回结构化结果。'
  const raw = await callSplitLlm(llm, config, system, `专家 ${nodeKey} 的发言：\n${trimmed}`)
  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    const list = (parsed as { viewpoints?: unknown } | null | undefined)?.viewpoints
    if (Array.isArray(list) && list.length > 0) {
      const lines: SplitLine[] = []
      for (const item of list) {
        const obj = item as { content?: unknown; quote?: unknown; dimension?: unknown } | null | undefined
        const line = typeof obj?.content === 'string' ? obj.content.replace(/\s+/g, ' ').trim() : ''
        if (line === '') continue
        let quote: string | undefined
        if (typeof obj?.quote === 'string') {
          const candidate = obj.quote.replace(/\s+/g, ' ').trim()
          if (candidate !== '' && candidate.length <= 120 && trimmed.includes(candidate)) quote = candidate
        }
        const dimension = typeof obj?.dimension === 'string' && obj.dimension.trim() !== ''
          ? obj.dimension.trim().slice(0, 20)
          : '其他'
        lines.push({ content: line, quote, dimension })
        if (lines.length >= Math.max(1, config.maxOpinions)) break
      }
      if (lines.length > 0) return lines
    }
  }
  // LLM 拆分失败（调用异常/解析失败/输出为空）→ 本地启发式兜底（零 token）。
  return splitByMarkers(trimmed)
}
