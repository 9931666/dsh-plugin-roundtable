/**
 * The《全局协作总纲》generated at meeting start and injected into every
 * expert node's persona. Four fixed sections per the V1 spec.
 *
 * 体积纪律：这份文本进入**每一位专家**的 persona，并跟着他的每一次请求
 * 付费。所以这里只写"所有专家共同的协议与红线"；"你这个节点具体怎么做"
 * 写在 {@link ./prompt.ts} 的 `nodePersona()`，同一条约束绝不两处各写一遍。
 * 体积极限由 `test/prompt-budget.test.mjs` 断言。
 * @module dsh-plugin-roundtable/charter
 */

import type { Meeting } from './types.ts'

/** Build the charter text for one meeting's current roster and edges. */
export function buildCharter(meeting: Meeting): string {
  // 名单与通道压成单行：它们是"边界信息"，不是阅读材料 —— 每个专家都带一份，
  // 逐行罗列在 N 位专家上会线性放大。
  const roster = meeting.nodes
    .filter((node) => node.status !== 'removed')
    .map((node) => `${node.key}${node.role !== undefined && node.role !== '' ? `（${node.role}）` : ''}`)
    .join('、')
  const edges = meeting.edges
    .map((edge) => `${edge.from} ${edge.direction === 'bidirectional' ? '⇄' : '→'} ${edge.to}`)
    .join('、')
  // 只保留**专家需要遵守**的红队约束；主持人的操作步骤（start/collect/finish_review
  // 怎么调、用户怎么点「支持」）属于 usage 与工具 description，不该进专家 persona。
  const redteamRules = meeting.mode === 'redteam'
    ? [
        '',
        '五、针锋相对评审协议（本会议为「针锋相对」模式）',
        '- 只找主持人已定稿方案的真实缺陷与认知盲区，严禁提出替代方案；指出问题要具体，不抬杠。',
        '- 每条观点只聚焦一个缺陷（1~3 条）；如无缺陷可明确说明"暂无"。',
        '- 证据分级：代码/bug 类缺陷附可复现步骤（"可复现：1. …"）；设计类缺陷附论证链（"论证：因为…所以…"），不得为设计类缺陷编造伪复现步骤。',
        '- 闭环复审只核对上一轮已认定的缺陷是否被修复，禁止引入全新打分项。',
      ]
    : []
  return [
    '《全局协作总纲》',
    '',
    '一、会议背景与核心目标',
    meeting.goal.trim() === '' ? '（未提供，以主持人现场说明为准）' : meeting.goal,
    '',
    '二、团队成员与角色边界',
    '主持人（DeepSeek）：全局编排与最终汇总，唯一对用户负责。',
    `专家节点：${roster === '' ? '（暂无）' : roster}`,
    `连线通道：${edges === '' ? '（暂无）' : edges}`,
    '权限隔离：节点只做本职，严禁越权代管其他节点的工作；只有主持人可以创建/移除节点、修改连线、发起人类决策、结束会议。',
    '',
    '三、标准化协作协议',
    '- 每次发言以 [当前状态] 开头、以 [核心产出] 与 [下一步建议] 结尾；严禁"好的""收到"这类无信息量内容。',
    '- 发言通过 roundtable_speak 写入会议记录（to 留空 = 交汇聚网关；定向回复填对方 key）。',
    '',
    '四、全局约束与安全红线',
    '- 遇到分歧或无法独自决定的事项，建议主持人触发 [需人类决策]，严禁自行替用户拍板。',
    '- 严禁编造不存在的 API、数据或事实；不确定时明确说明。',
    '- 超预算（轮数/Token）时会议自动闭麦。',
    ...redteamRules,
  ].join('\n')
}
