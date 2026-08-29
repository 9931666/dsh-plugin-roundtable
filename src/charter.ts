/**
 * The《全局协作总纲》generated at meeting start and injected into every
 * expert node's persona. Four fixed sections per the V1 spec.
 * @module dsh-plugin-roundtable/charter
 */

import type { Meeting } from './types.ts'

/** Build the charter text for one meeting's current roster and edges. */
export function buildCharter(meeting: Meeting): string {
  const roster = meeting.nodes
    .filter((node) => node.status !== 'removed')
    .map((node) => `  - ${node.key}${node.role !== undefined && node.role !== '' ? `（${node.role}）` : ''}`)
    .join('\n')
  const edges = meeting.edges
    .map((edge) => `  - ${edge.from} → ${edge.to}${edge.direction === 'bidirectional' ? '（双向）' : '（单向）'}`)
    .join('\n')
  const redteamRules = meeting.mode === 'redteam'
    ? [
        '',
        '五、针锋相对评审协议（本会议为「针锋相对」模式）',
        '- 目标：对主持人已定稿的方案挑毛病（红队审查），找出方案的真实缺陷与认知盲区。',
        '- 每位专家只负责找缺陷，严禁提出替代方案；指出问题要具体、可复现，不较真不抬杠。',
        '- 每条观点只聚焦一个缺陷，建议 1~3 条；如无缺陷可明确说明"暂无"。',
        '- 主持人用 roundtable_start_review(question, plan) 记录议题与方案，专家发言后主持人用 roundtable_collect_review 收集观点，用户逐条「支持/驳回」。',
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
    '专家节点：',
    roster === '' ? '（暂无）' : roster,
    '连线通道：',
    edges === '' ? '（暂无）' : edges,
    '权限隔离：节点只做本职，严禁越权代管其他节点的工作；只有主持人可以创建/移除节点、修改连线、发起人类决策、结束会议。',
    '',
    '三、标准化协作协议',
    '- 每次发言开头标注 [当前状态]，结尾给出 [核心产出] 与 [下一步建议]。',
    '- 严禁输出"好的""收到"等无信息量内容。',
    '- 节点发言通过 roundtable_speak 写入会议记录，供汇聚网关与主持人查阅；定向讨论使用 to 参数。',
    '',
    '四、全局约束与安全红线',
    '- 遇到分歧或无法独自决定的事项，立即建议主持人触发 [需人类决策]，严禁自行替用户拍板。',
    '- 严禁编造不存在的 API、数据或事实；不确定时明确说明。',
    '- 超预算（轮数/Token）时会议将自动闭麦暂停。',
    ...redteamRules,
  ].join('\n')
}
