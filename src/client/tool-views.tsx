/**
 * `roundtable_status` 的专属渲染（第 4 批）。
 *
 * 注册在 `tool.call.toolview` 上，key 是本插件自己的工具名。宿主的 key 域是
 * 开放的（"any wire tool name, **including a tool your own package registered**"），
 * 且"registering is **additive** for your own tool" —— 未认领的 key 才回退到
 * 通用 tool 行。owner 传入的是**已冻结的运行中/已结算节点**，所以这个视图是
 * turn 已知内容的纯函数，无状态。
 *
 * 取数：settled 调用是 `ToolResultNode`（`content: ContentBlock[]`），running 时
 * 只有 `argsRaw`。解析失败**一律回退为纯文本**——绝不显示空白卡片，那会比通用
 * tool 行更糟。纯逻辑在 tool-views-model.ts（JSX 无法被零依赖测试直接加载）。
 *
 * @module @huanlin/dsh-plugin-roundtable/client/tool-views
 */

import type { CSSProperties } from 'react'
import {
  blockTextOf,
  fieldText,
  nodeLine,
  parseStatusPayload,
  type StatusPayload,
  type ToolBlockLike,
} from './tool-views-model.ts'

const CARD: CSSProperties = {
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: 8,
  padding: '8px 10px',
  font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre-wrap',
}

const HEAD: CSSProperties = { fontWeight: 600, marginBottom: 4 }
const MUTED: CSSProperties = { opacity: 0.75 }
const WARN: CSSProperties = { color: '#e0a030' }

/** Card body for a parsed status payload. */
export function StatusCard({ data }: { data: StatusPayload }): JSX.Element {
  const budget = data.budget ?? {}
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const pendingDecisions = Array.isArray(data.pending_decisions) ? data.pending_decisions.length : 0
  const pendingActions = Array.isArray(data.pending_actions) ? data.pending_actions.length : 0
  const pending = [
    pendingDecisions > 0 ? `待人类决策 ${pendingDecisions} 项` : '',
    pendingActions > 0 ? `待执行用户操作 ${pendingActions} 条` : '',
  ].filter((part) => part !== '').join(' · ')
  return (
    <div style={CARD}>
      <div style={HEAD}>
        圆桌会议 · {fieldText(data.meeting_name)}（{fieldText(data.mode)} · {fieldText(data.status)}）
      </div>
      <div style={MUTED}>
        第 {fieldText(data.round)} 轮 / 上限 {fieldText(budget.max_rounds)} 轮 · 发言量粗估{' '}
        {fieldText(budget.used_tokens)}/{fieldText(budget.max_tokens)} token
      </div>
      <div>
        专家（{nodes.length}）：{nodes.length === 0 ? ' 无' : ''}
        {nodes.map((node) => `\n${nodeLine(node)}`).join('')}
      </div>
      {pending === '' ? null : <div style={WARN}>{pending}</div>}
    </div>
  )
}

/**
 * Tool view for `roundtable_status`.
 *
 * Renders the card when the result parses, otherwise falls back to the raw
 * text (and to `null` when there is nothing at all — the host's own call row
 * still shows the running call).
 */
export function RoundTableStatusView(props: { block?: unknown; toolName?: string }): JSX.Element | null {
  const textBody = blockTextOf(props.block)
  const data = parseStatusPayload(textBody)
  if (data !== null) return <StatusCard data={data} />
  if (textBody === '') return null
  const failed = (props.block as ToolBlockLike | undefined)?.isError === true
  return (
    <div style={CARD}>
      {failed ? <div style={WARN}>roundtable_status 调用失败</div> : null}
      {textBody}
    </div>
  )
}
