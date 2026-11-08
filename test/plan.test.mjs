/**
 * plan.ts 纯函数测试（R1 v1）：两张 Markdown 表、变更回显与三态解析。
 *
 * 用 Node 内建 `node --test` + `node:assert/strict`，**零新依赖**；
 * Node 24 原生剥离类型，因此可以直接 import 源码里的 .ts 模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatMeetingDraft,
  PLAN_APPROVE_LABEL,
  PLAN_REVISE_LABEL,
  resolvePlanConfirmation,
} from '../src/plan.ts'

const DRAFT = {
  name: '架构评审',
  goal: '在 A/B 两个方案里选一个',
  mode: 'orchestrated',
  maxRounds: 6,
  maxTokens: 120_000,
  kbPath: '/workspace/kb',
  skills: ['pdf-fill', 'review-checklist'],
  skillDelivery: 'relay',
  experts: [
    { key: 'researcher', role: '调研', provider: 'zai-coding-cn', model: 'glm-5.2', prompt: '只负责检索与事实核对，不要给实现建议' },
    { key: 'reviewer', role: '审查' },
  ],
}

/** 从卡片里取出某一行的原文（表格断言用：必须按行判断，而不是整段 includes）。 */
function lineWith(card, needle) {
  return card.split('\n').find((line) => line.includes(needle)) ?? ''
}

test('卡片包含会议设置表必需的每一项参数', () => {
  const card = formatMeetingDraft(DRAFT)
  const needles = [
    '## 会议设置',
    '架构评审',
    'orchestrated',
    '6 轮',
    '120000',
    '/workspace/kb',
    'pdf-fill',
    'review-checklist',
    'relay',
    '2 位',
  ]
  for (const needle of needles) {
    assert.ok(card.includes(needle), `卡片缺少必需内容：${needle}`)
  }
})

test('会议设置是一张带表头与分隔行的 Markdown 表', () => {
  const card = formatMeetingDraft(DRAFT)
  assert.ok(card.includes('| 项 | 值 |'), '会议设置表缺少表头')
  assert.ok(card.includes('| --- | --- |'), '会议设置表缺少分隔行')
  assert.ok(lineWith(card, '| 会议名称 |').includes('| 架构评审 |'))
  assert.ok(lineWith(card, '| Token 预算 |').includes('120000 tokens'))
  assert.ok(lineWith(card, '| 专家数量 |').includes('2 位'))
})

test('专家名单是一张 5 列表：序号 / key / 角色 / 模型 / 提示词', () => {
  const card = formatMeetingDraft(DRAFT)
  assert.ok(card.includes('| # | 专家 key | 角色 | 模型 | 提示词 |'), '专家表缺少表头')
  assert.equal(
    lineWith(card, '`researcher`'),
    '| 1 | `researcher` | 调研 | zai-coding-cn/glm-5.2 | 只负责检索与事实核对，不要给实现建议 |',
  )
  // 没给 provider/model → 如实写「继承主持人」；没给 prompt → 说明它是自动推导的。
  assert.equal(
    lineWith(card, '`reviewer`'),
    '| 2 | `reviewer` | 审查 | 继承主持人 | 自动（总纲 + 角色） |',
  )
})

test('提示词列：超过 40 字截断并补省略号，短提示词不假装被截断', () => {
  const long = '盯'.repeat(60)
  const card = formatMeetingDraft({
    ...DRAFT,
    experts: [
      { key: 'long', prompt: long },
      { key: 'short', prompt: '短提示词' },
    ],
  })
  const longCell = lineWith(card, '`long`').split('|')[5].trim()
  assert.equal(longCell, `${'盯'.repeat(40)}…`, '长提示词应截到 40 字并补省略号')
  const shortCell = lineWith(card, '`short`').split('|')[5].trim()
  assert.equal(shortCell, '短提示词', '没被截断就不该出现省略号（否则用户会以为卡片藏了内容）')
})

test('空专家名单给出可操作提示，而不是留白', () => {
  const card = formatMeetingDraft({ ...DRAFT, experts: [] })
  assert.ok(card.includes('建议至少 1 位'))
  assert.ok(lineWith(card, '| 专家数量 |').includes('0 位'))
})

test('表格单元格里的裸 | 与换行被转义/压平（不破坏分列）', () => {
  const card = formatMeetingDraft({
    ...DRAFT,
    name: 'A | B',
    experts: [{ key: 'weird', role: '安全 | 审查\n（密钥）' }],
  })
  assert.ok(lineWith(card, '| 会议名称 |').includes('A \\| B'), '会议名称里的 | 必须转义')
  const row = lineWith(card, '`weird`')
  assert.ok(!row.includes('\n'), '单元格不能带换行')
  assert.ok(row.includes('安全 \\| 审查 （密钥）'), '角色里的 | 必须转义、换行必须压平')
  const columns = row.replaceAll('\\|', '').split('|').length - 2
  assert.equal(columns, 5, `这一行应仍是 5 列，实际：${row}`)
})

test('完整目标放在表格下方', () => {
  const card = formatMeetingDraft(DRAFT)
  assert.ok(card.includes('在 A/B 两个方案里选一个'))
  assert.ok(card.indexOf('## 议题 / 目标') > card.indexOf('## 专家名单'))
})

test('revised 卡片：标题标注已更新，并在表格之前逐条回显变更', () => {
  const card = formatMeetingDraft(DRAFT, {
    revised: true,
    changes: ['专家 reviewer 的模型：zai/glm-5.2 → deepseek/deepseek-chat', 'Token 预算：200000 → 100000'],
  })
  assert.ok(card.includes('已按你的意见更新'))
  assert.ok(card.includes('> 本次变更：'))
  assert.ok(card.includes('- 专家 reviewer 的模型：zai/glm-5.2 → deepseek/deepseek-chat'))
  assert.ok(card.indexOf('本次变更') < card.indexOf('## 会议设置'), '变更点必须在表格上方')
})

test('revised 但没有 changes 时如实写「本次未标注具体变更」', () => {
  const card = formatMeetingDraft(DRAFT, { revised: true, changes: [] })
  assert.ok(card.includes('（本次未标注具体变更）'))
  assert.ok(!card.includes('> - 专家'), '空 changes 不得凭空渲染出变更条目')
})

test('非 revised 卡片不出现「本次变更」块', () => {
  assert.ok(!formatMeetingDraft(DRAFT).includes('本次变更'))
})

test('卡片保留可选 skill 清单，空清单给出放置路径指引', () => {
  const withSkills = formatMeetingDraft(DRAFT, {
    availableSkills: [{ name: 'pdf-fill', description: '填表' }],
  })
  assert.ok(withSkills.includes('`pdf-fill` — 填表'))
  const without = formatMeetingDraft(DRAFT, { availableSkills: [] })
  assert.ok(without.includes('本机当前没有可选 skill'))
})

test('按钮常量与针锋一致：确定开始 / 仍需修改', () => {
  assert.equal(PLAN_APPROVE_LABEL, '确定开始')
  assert.equal(PLAN_REVISE_LABEL, '仍需修改')
})

test('resolvePlanConfirmation：approved / revise / unavailable 三态', () => {
  assert.deepEqual(resolvePlanConfirmation(undefined), { kind: 'unavailable', note: '' })
  assert.deepEqual(resolvePlanConfirmation({ selected: [PLAN_APPROVE_LABEL] }), { kind: 'approved' })
  assert.deepEqual(
    resolvePlanConfirmation({ selected: [PLAN_REVISE_LABEL], custom: '把预算降到 5 轮' }),
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

test('传给主持人实际路由时，「继承主持人」补成可读的 provider/model', () => {
  const card = formatMeetingDraft(DRAFT, {
    inheritedRoute: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  assert.ok(
    lineWith(card, '`reviewer`').includes('继承主持人（deepseek/deepseek-chat）'),
    '没写路由的专家应显示继承自谁，而不是只说「继承主持人」',
  )
  // 显式路由的专家不受影响（仍显示自己的路由）。
  assert.ok(lineWith(card, '`researcher`').includes('zai-coding-cn/glm-5.2'))
})
