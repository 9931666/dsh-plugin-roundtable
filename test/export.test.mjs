/**
 * 整场会议导出测试（R5/B6）。
 *
 * 导出物是用户真正会留下来、贴进 issue 的东西，所以断言集中在三件事：
 * 结构齐全、版本号真实、**绝不出现 undefined / [object Object]**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMeetingMarkdown } from '../src/tools.ts'
import { PLUGIN_VERSION } from '../src/version.ts'

function meeting(overrides = {}) {
  return {
    id: 'jiagou-pinggu',
    name: '架构评审',
    goal: '在 A/B 两个方案里选一个',
    mode: 'orchestrated',
    captainSessionId: 'captain-1',
    charter: '# 总纲',
    nodes: [
      { id: 'n1', key: 'researcher', role: '调研', provider: 'zai-coding-cn', model: 'glm-5.2', status: 'idle', joinedAt: 1 },
      { id: 'n2', key: 'reviewer', status: 'removed', joinedAt: 2 },
    ],
    edges: [{ id: 'e1', from: 'captain', to: 'researcher', direction: 'forward', createdAt: 3 }],
    decisions: [
      { id: 'd1', question: '选哪个方案？', options: ['A', 'B'], chosen: 'A', status: 'resolved', ts: 4 },
      { id: 'd2', question: '要不要加人？', options: [], status: 'pending', ts: 5 },
    ],
    budget: { maxRounds: 6, maxTokens: 120_000, usedRounds: 2, usedTokens: 3300 },
    round: 2,
    kbPath: '/workspace/kb',
    skills: ['pdf-fill'],
    skillDelivery: 'relay',
    status: 'ended',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    ...overrides,
  }
}

const UTTERANCES = [
  { id: 'u1', nodeKey: 'captain', kind: 'speech', content: '先做一轮调研。', round: 1, ts: 1_700_000_010_000 },
  { id: 'u2', nodeKey: 'researcher', kind: 'speech', content: '调研结论：A 方案更省。', to: 'captain', round: 1, ts: 1_700_000_020_000 },
  { id: 'u3', nodeKey: 'reviewer', kind: 'retrieval', content: '检索到的资料。', round: 2, ts: 1_700_000_030_000 },
]

const ACTIONS = [
  {
    id: 'a1',
    ts: 1_700_000_040_000,
    kind: 'add-node',
    nodeKey: 'reviewer',
    role: '审查',
    provider: '',
    model: '',
    text: '新增了专家 reviewer（角色：审查），使用主持人默认模型',
  },
]

test('整场会议导出：结构完整、版本真实、无 undefined / [object Object]', () => {
  const md = renderMeetingMarkdown(meeting(), UTTERANCES, ACTIONS, undefined)
  const needles = [
    '# 圆桌会议记录 · 架构评审',
    '## 议题 / 目标',
    '## 专家名单（2）',
    '## 决策记录（2）',
    '## 发言记录（3 条）',
    '### 第 1 轮',
    '### 第 2 轮',
    '## 用户调整记录（1）',
    `v${PLUGIN_VERSION}`,
    'zai-coding-cn/glm-5.2',
    '（继承主持人）/（继承主持人）',
    '在 A/B 两个方案里选一个',
    '/workspace/kb',
  ]
  for (const needle of needles) {
    assert.ok(md.includes(needle), `导出缺少：${needle}`)
  }
  assert.ok(!md.includes('undefined'), '导出里出现了 undefined')
  assert.ok(!md.includes('[object Object]'), '导出里出现了 [object Object]')
  assert.ok(!md.includes('v0.2.21'), '导出头部不得再出现硬编码的旧版本号 v0.2.21')
})

test('导出：发言标注"发言者 → 受众"，未定向的标为汇聚网关', () => {
  const md = renderMeetingMarkdown(meeting(), UTTERANCES, [], undefined)
  assert.ok(md.includes('**captain → 汇聚网关**'))
  assert.ok(md.includes('**researcher → captain**'))
  assert.ok(md.includes('**reviewer → 汇聚网关**'), '未定向发言应标为汇聚网关')
  assert.ok(md.includes('retrieval'), '非 speech 类型应标注 kind')
})

test('导出：决策记录保留问题 / 选项 / 用户选择 / 状态', () => {
  const md = renderMeetingMarkdown(meeting(), [], [], undefined)
  assert.ok(md.includes('**[已决]** 选哪个方案？'))
  assert.ok(md.includes('选项：A / B'))
  assert.ok(md.includes('用户选择：A'))
  assert.ok(md.includes('**[待决]** 要不要加人？'))
})

test('导出：进行中的会议在头部标注"进行中快照"', () => {
  const md = renderMeetingMarkdown(meeting({ status: 'active' }), [], [], undefined)
  assert.ok(md.includes('（进行中快照）'))
  assert.ok(md.includes('最后更新'))
})

test('导出：已结束的会议给"结束时间"且不标快照', () => {
  const md = renderMeetingMarkdown(meeting(), [], [], undefined)
  assert.ok(!md.includes('（进行中快照）'))
  assert.ok(md.includes('结束时间'))
})

test('导出：超长发言被截断并标注原长', () => {
  const long = 'x'.repeat(5000)
  const md = renderMeetingMarkdown(
    meeting(),
    [{ id: 'u', nodeKey: 'a', kind: 'speech', content: long, round: 1, ts: 1 }],
    [],
    undefined,
  )
  assert.ok(md.includes('已截断，原长 5000 字符'))
  assert.ok(!md.includes(long), '超长正文不应整段出现')
})

test('导出：有评审记录时追加 针锋相对 段落', () => {
  const review = {
    meetingId: 'jiagou-pinggu',
    question: '原来问的是什么？',
    plan: '待攻击的方案',
    status: 'done',
    reviewPass: 1,
    maxReviewPass: 3,
    history: [],
    schemaVersion: 2,
    viewpoints: [
      {
        id: 'u9#0',
        utteranceId: 'u9',
        nodeKey: 'redteam',
        content: '方案没有处理"清空与追加交错"的情况。',
        status: 'endorsed',
        dimension: '数据',
        ts: 10,
        seq: 0,
      },
      {
        id: 'u9#1',
        utteranceId: 'u9',
        nodeKey: 'redteam',
        content: '驳回示例：这条其实不成立。',
        status: 'rejected',
        rejectReason: '已有原子写覆盖',
        dimension: '其他',
        ts: 11,
        seq: 1,
      },
    ],
    startedAt: 1,
    updatedAt: 2,
  }
  const md = renderMeetingMarkdown(meeting(), [], [], review)
  assert.ok(md.includes('# 针锋相对评审记录'))
  assert.ok(md.includes('## 评审轮次 1/3'))
  assert.ok(md.includes('方案没有处理"清空与追加交错"的情况。'))
  assert.ok(md.includes('✅ 已认定'))
  assert.ok(md.includes('❌ 已驳回'))
  assert.ok(md.includes('**驳回理由**：已有原子写覆盖'))
})

test('导出：没有评审时不出现评审段落', () => {
  assert.ok(!renderMeetingMarkdown(meeting(), [], [], undefined).includes('针锋相对评审记录'))
})

test('导出：空会议也能导出，不崩且不留 undefined', () => {
  const empty = meeting({ nodes: [], decisions: [], goal: '', kbPath: undefined, skills: undefined })
  const md = renderMeetingMarkdown(empty, [], [], undefined)
  assert.ok(md.includes('# 圆桌会议记录 · 架构评审'))
  assert.ok(md.includes('（无）'))
  assert.ok(!md.includes('undefined'))
  assert.ok(!md.includes('[object Object]'))
})

test('导出：用户调整记录里注明"只含未清空的记录"', () => {
  const md = renderMeetingMarkdown(meeting(), [], [], undefined)
  assert.ok(md.includes('只包含尚未被主持人清空的记录'))
})
