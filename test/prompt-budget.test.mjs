/**
 * 提示词体积与去重护栏（第 4 步）。
 *
 * 提示词是**唯一没有编译器保护**的那部分代码：改错一个词不会报错、不会失败，
 * 只会让每一次请求更贵、让专家更啰嗦。所以这里把三条纪律变成断言：
 *
 *   1. **体积上限** —— usage 每次请求都付；charter 与 persona 跟着每位专家
 *      的每一次请求付。涨过上限就红。
 *   2. **关键协议不得丢** —— 压缩时最容易顺手删掉的就是红线本身。
 *   3. **同一约束不写两遍** —— charter 与 persona 是两份都会长期驻留的文本，
 *      同一条红线出现两次就是付两遍钱。
 *
 * 用 Node 内建 `node --test` + `node:assert/strict`，零新依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCharter } from '../src/charter.ts'
import { nodePersona, REPORT_ENVELOPE, TASK_ENVELOPE, usageSectionText } from '../src/prompt.ts'

/** 3 位专家的 orchestrated 会议：本文件所有体积断言的基准场景。 */
const MEETING = {
  schemaVersion: 2,
  id: 'demo',
  name: '架构评审',
  goal: '在 A/B 两个方案里选一个',
  mode: 'orchestrated',
  captainSessionId: 'session-1',
  charter: '',
  nodes: [
    { id: 's1', key: 'researcher', role: '调研', status: 'idle', joinedAt: 1 },
    { id: 's2', key: 'engineer', role: '实现', status: 'idle', joinedAt: 2 },
    { id: 's3', key: 'reviewer', role: '审查', status: 'idle', joinedAt: 3 },
  ],
  edges: [
    { id: 'e1', from: 'captain', to: 'researcher', direction: 'bidirectional', createdAt: 1 },
    { id: 'e2', from: 'engineer', to: 'reviewer', direction: 'forward', createdAt: 2 },
  ],
  decisions: [],
  budget: { maxRounds: 6, maxTokens: 120_000, usedRounds: 0, usedTokens: 0 },
  round: 1,
  status: 'active',
  createdAt: 0,
  updatedAt: 0,
}

/** 会议的 charter 字段是会议级快照；persona 用它的实际内容拼接。 */
function withCharter(meeting) {
  return { ...meeting, charter: buildCharter(meeting) }
}

/** 统计子串出现次数（去重断言用）。 */
function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('usage 段体积上限：它每一次请求都付，包括不开会的日常对话', () => {
  const text = usageSectionText()
  // 上一版为 7,924 字符（还额外逐个列了 21 个工具名，纯冗余：工具 schema 本来就在请求里）。
  assert.ok(text.length <= 3200, `usage 段涨到 ${text.length} 字符（上限 3200）—— 它每次请求都要付费`)
})

test('工具 description 总量上限：工具 schema 同样随每次请求下发', () => {
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
  const re = /description:\s*(?:'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|`((?:\\[\s\S]|[^`])*)`)/g
  let total = 0
  let match
  while ((match = re.exec(source)) !== null) total += (match[1] ?? match[2] ?? match[3] ?? '').length
  // 实测基线 10,598 字符（79 条）。工具描述是模型决定"调不调、怎么调"的唯一依据，
  // 能压但不能瞎压 —— 所以这里只拦"悄悄涨回去"。
  assert.ok(total <= 11_200, `工具 description 总量涨到 ${total} 字符（上限 11200），见 scripts/prompt-budget.mjs`)
})

test('charter 体积上限：它进入每一位专家的 persona', () => {
  const text = buildCharter(MEETING)
  assert.ok(text.length <= 1200, `charter 涨到 ${text.length} 字符（上限 1200）`)
  const redteam = buildCharter({ ...MEETING, mode: 'redteam' })
  assert.ok(redteam.length <= 1700, `redteam charter 涨到 ${redteam.length} 字符（上限 1700）`)
})

test('专家 persona 体积上限：它跟着该专家的每一次请求', () => {
  const meeting = withCharter(MEETING)
  const persona = nodePersona(meeting, meeting.nodes[0], '.roundtable', { maxOpinions: 3 }, {
    names: ['review-checklist'],
    delivery: 'relay',
  })
  assert.ok(persona.length <= 2400, `persona 涨到 ${persona.length} 字符（上限 2400）`)
})

test('压缩不得删掉红线：主持人侧的关键协议仍在', () => {
  const text = usageSectionText()
  const needles = [
    'roundtable_plan_meeting', // 建会前必须过设置卡片
    'SETTINGS CARD',
    'roundtable_actions_clear', // 每轮先处理 UI 待办
    'pending_actions',
    'next_since', // 增量游标
    'ESTIMATE OF SPOKEN TEXT', // 预算诚实原则
    'roundtable_request_decision', // 人类决策
    'roundtable_proxy_think', // 黑盒模型代理思考
    'roundtable_start_review', // 针锋相对
    'roundtable_export_meeting', // 收尾导出
  ]
  for (const needle of needles) {
    assert.ok(text.includes(needle), `usage 丢了关键协议：${needle}`)
  }
})

test('压缩不得删掉红线：专家侧的总纲与信封仍在', () => {
  const charter = buildCharter(MEETING)
  for (const needle of ['一、会议背景与核心目标', '二、团队成员与角色边界', '三、标准化协作协议', '四、全局约束与安全红线']) {
    assert.ok(charter.includes(needle), `charter 丢了小节：${needle}`)
  }
  assert.ok(
    buildCharter({ ...MEETING, mode: 'redteam' }).includes('五、针锋相对评审协议'),
    'redteam 模式下 charter 少了第五节评审协议',
  )
  const meeting = withCharter(MEETING)
  const persona = nodePersona(meeting, meeting.nodes[0], '.roundtable')
  assert.ok(persona.includes(REPORT_ENVELOPE), 'persona 少了报告信封')
  assert.ok(usageSectionText().includes(TASK_ENVELOPE), 'usage 少了任务信封')
})

test('去重不变量：同一条红线在 charter + persona 里只出现一次', () => {
  const meeting = withCharter(MEETING)
  const persona = nodePersona(meeting, meeting.nodes[0], '.roundtable')
  // persona = charter + 该节点的工作规则，两份文本都会被长期携带；
  // 同一条约束写两遍就是付两遍钱。
  for (const rule of ['替用户拍板', '严禁编造']) {
    assert.equal(count(persona, rule), 1, `"${rule}" 在 persona 里出现了 ${count(persona, rule)} 次（应为 1）`)
  }
})

test('专家侧能自己拿到通道边界与引用规则（它看不到主持人的 usage）', () => {
  const meeting = withCharter(MEETING)
  const persona = nodePersona(meeting, meeting.nodes[0], '.roundtable')
  assert.ok(persona.includes('roundtable_speak'), 'persona 未说明默认汇报通道')
  assert.ok(persona.includes('立刻行动'), 'persona 未说明 send_message 的使用边界')
  assert.ok(persona.includes('transcript.jsonl'), 'persona 未说明如何按引用取回原文')
})
