/**
 * plan.ts 纯函数测试（R3/A6）：卡片渲染与三态解析。
 *
 * 用 Node 内建 `node --test` + `node:assert/strict`，**零新依赖**；
 * Node 24 原生剥离类型，因此可以直接 import 源码里的 .ts 模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMeetingDraft, PLAN_APPROVE_LABEL, resolvePlanConfirmation } from '../src/plan.ts'

const DRAFT = {
  name: '架构评审',
  goal: '在 A/B 两个方案里选一个',
  mode: 'orchestrated',
  maxRounds: 6,
  maxTokens: 120_000,
  kbPath: '/workspace/kb',
  skills: ['pdf-fill', 'review-checklist'],
  skillDelivery: 'relay',
}

const EXPERTS = [
  { key: 'researcher', role: '调研', provider: 'zai-coding-cn', model: 'glm-5.2' },
  { key: 'reviewer', role: '审查' },
]

test('卡片渲染包含每一项必需参数', () => {
  const card = formatMeetingDraft(DRAFT, EXPERTS)
  const needles = [
    '架构评审',
    'orchestrated',
    '6 轮',
    '120000',
    '/workspace/kb',
    'pdf-fill',
    'review-checklist',
    'relay',
    '在 A/B 两个方案里选一个',
  ]
  for (const needle of needles) {
    assert.ok(card.includes(needle), `卡片缺少必需内容：${needle}`)
  }
})

test('卡片逐个列出专家（序号 + key + 角色 + 路由）', () => {
  const card = formatMeetingDraft(DRAFT, EXPERTS)
  assert.ok(card.includes('1. `researcher` — 调研 — zai-coding-cn/glm-5.2'))
  assert.ok(card.includes('2. `reviewer` — 审查 — 继承主持人当前 provider/model'))
})

// R-A：预设引用必须在卡片上**可分辨**。此前预设只被浏览器表单消费，
// 主持人拿不到 rolePresets，于是「以为用了预设」与「其实没用」在卡片上无法区分。
test('卡片标注专家来自哪条预设，便于确认草案与实际建节点同源', () => {
  const card = formatMeetingDraft(DRAFT, [
    { key: 'arch', role: '架构主审', provider: 'dshapi', model: 'deepseek-v4.1-flash', preset: 'arch' },
  ])
  assert.ok(card.includes('来自预设 `arch`'), '卡片应标出预设来源')
})

test('预设引用解析失败时卡片显式告警，不静默降级', () => {
  const card = formatMeetingDraft(DRAFT, [
    { key: 'arch', role: '架构主审', unresolved: 'no-such-preset' },
  ])
  assert.ok(card.includes('未找到'), '未解析的预设必须显式告警')
  assert.ok(card.includes('no-such-preset'), '告警里应带原始引用名')
  assert.ok(card.includes('roundtable_list_presets'), '应给出查 id 的入口')
})

test('未引用预设的专家不出现预设标记（避免误报来源）', () => {
  const card = formatMeetingDraft(DRAFT, EXPERTS)
  assert.ok(!card.includes('来自预设'))
  assert.ok(!card.includes('未找到'))
})

test('空专家名单给出可操作提示，而不是留白', () => {
  assert.ok(formatMeetingDraft(DRAFT, []).includes('建议至少 1 位'))
})

test('revised 卡片显式标注"已按意见更新"', () => {
  const card = formatMeetingDraft(DRAFT, EXPERTS, { revised: true })
  assert.ok(card.includes('已按你的意见更新草案'))
})

test('卡片列出当前可选 skill 清单，空清单给出放置路径指引', () => {
  const withSkills = formatMeetingDraft(DRAFT, EXPERTS, {
    availableSkills: [{ name: 'pdf-fill', description: '填表' }],
  })
  assert.ok(withSkills.includes('`pdf-fill` — 填表'))
  const without = formatMeetingDraft(DRAFT, EXPERTS, { availableSkills: [] })
  assert.ok(without.includes('本机当前没有可选 skill'))
})

test('resolvePlanConfirmation：approved / revise / unavailable 三态', () => {
  assert.deepEqual(resolvePlanConfirmation(undefined), { kind: 'unavailable', note: '' })
  assert.deepEqual(resolvePlanConfirmation({ selected: [PLAN_APPROVE_LABEL] }), { kind: 'approved' })
  assert.deepEqual(
    resolvePlanConfirmation({ selected: ['我要修改'], custom: '把预算降到 5 轮' }),
    { kind: 'revise', note: '把预算降到 5 轮' },
  )
})

test('resolvePlanConfirmation：只有 custom 文本也算 revise', () => {
  assert.deepEqual(
    resolvePlanConfirmation({ selected: [], custom: '  换成 glm-5.2  ' }),
    { kind: 'revise', note: '换成 glm-5.2' },
  )
})

test('resolvePlanConfirmation：纯空白 custom 不算 revise', () => {
  assert.deepEqual(resolvePlanConfirmation({ selected: [], custom: '   ' }), { kind: 'unavailable', note: '' })
  assert.deepEqual(resolvePlanConfirmation({ selected: [] }), { kind: 'unavailable', note: '' })
})

test('resolvePlanConfirmation：批准标签优先于 custom 文本', () => {
  assert.deepEqual(
    resolvePlanConfirmation({ selected: [PLAN_APPROVE_LABEL], custom: '随便改改' }),
    { kind: 'approved' },
  )
})

test('resolvePlanConfirmation：自定义批准标签同样生效', () => {
  assert.deepEqual(resolvePlanConfirmation({ selected: ['OK'] }, 'OK'), { kind: 'approved' })
})
