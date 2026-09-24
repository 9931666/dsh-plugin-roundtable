/**
 * budget.ts 纯函数测试（R3/A6）：token 估算单调性与熔断边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertUsable, beginRound, budgetExceeded, estimateTokens, markMuted, MeetingEndedError, MeetingMutedError } from '../src/budget.ts'

/** 最小可用 Meeting 工厂（只填被测逻辑需要的字段）。 */
function meeting(overrides = {}) {
  return {
    id: 'm1',
    name: '测试会议',
    goal: '',
    mode: 'orchestrated',
    captainSessionId: 'captain-1',
    charter: '',
    nodes: [],
    edges: [],
    decisions: [],
    budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 0, usedTokens: 0 },
    round: 0,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

test('estimateTokens：空串为 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens：随文本增长单调不减', () => {
  const samples = ['', 'a', 'ab', 'abc', 'abcd', 'abcd e', '你好', '你好世界', 'hello 世界']
  let previous = -1
  for (const sample of samples) {
    const value = estimateTokens(sample)
    assert.ok(value >= previous, `estimateTokens(${JSON.stringify(sample)}) = ${value} 小于前一个样本 ${previous}`)
    previous = value
  }
})

test('estimateTokens：空白字符不计入', () => {
  assert.equal(estimateTokens('   \n\t  '), 0)
})

test('estimateTokens：CJK 比等价长度的拉丁更贵', () => {
  assert.ok(estimateTokens('汉字') > estimateTokens('ab'))
})

test('熔断边界：设 N 轮就能开 N 轮，只有想开第 N+1 轮才触顶', () => {
  assert.equal(budgetExceeded(meeting({ round: 3 })), undefined, '恰好用满 3 轮仍未超限')
  assert.equal(budgetExceeded(meeting({ round: 4 })), 'rounds', '第 4 轮才超限')
  assert.equal(budgetExceeded(meeting({ round: 2 })), undefined)
})

test('熔断边界：token 恰好等于上限即算超限', () => {
  assert.equal(budgetExceeded(meeting({ budget: { maxRounds: 9, maxTokens: 100, usedRounds: 0, usedTokens: 100 } })), 'tokens')
  assert.equal(budgetExceeded(meeting({ budget: { maxRounds: 9, maxTokens: 100, usedRounds: 0, usedTokens: 99 } })), undefined)
})

test('熔断：两条轴同时超限时优先报轮数', () => {
  const both = meeting({ round: 5, budget: { maxRounds: 3, maxTokens: 10, usedRounds: 5, usedTokens: 99 } })
  assert.equal(budgetExceeded(both), 'rounds')
})

test('assertUsable：未超限时不抛错、且绝不改动状态', () => {
  const fresh = meeting()
  assertUsable(fresh)
  assert.equal(fresh.status, 'active')
})

test('assertUsable：超限时抛 MeetingMutedError，但绝不偷偷改状态', () => {
  const over = meeting({ round: 4 })
  assert.throws(() => assertUsable(over), MeetingMutedError)
  // 旧实现会在这里把 status 改成 muted 再抛，导致"状态改了却没落盘"。
  assert.equal(over.status, 'active')
})

test('assertUsable：已 muted 且仍超限时继续抛（不会静默放行）', () => {
  const muted = meeting({ round: 4, status: 'muted' })
  assert.throws(() => assertUsable(muted), MeetingMutedError)
})

test('assertUsable：ended / archived 一律抛 MeetingEndedError', () => {
  for (const status of ['ended', 'archived']) {
    assert.throws(() => assertUsable(meeting({ status })), MeetingEndedError, `status=${status} 应被拒绝`)
  }
})

test('P1 回归：闭麦后解围路径仍可通过（allowMuted）', () => {
  const stuck = meeting({ round: 4, status: 'active' })
  // 常规写操作：被拦。
  assert.throws(() => assertUsable(stuck), MeetingMutedError)
  // 解围路径（set_budget / close / export / actions_clear）：放行。
  assert.doesNotThrow(() => assertUsable(stuck, { allowMuted: true }))
})

test('P1 回归：allowMuted 不是万能钥匙，已结束的会议一律拒绝', () => {
  for (const status of ['ended', 'archived']) {
    assert.throws(
      () => assertUsable(meeting({ status }), { allowMuted: true }),
      MeetingEndedError,
      `status=${status} 即便走解围路径也必须拒绝`,
    )
  }
})

test('markMuted：只在 active 且超限时置位，并报告需要写盘', () => {
  const over = meeting({ round: 4 })
  assert.equal(markMuted(over), true, '首次闭麦应返回 true（调用方须写盘）')
  assert.equal(over.status, 'muted')
  assert.equal(markMuted(over), false, '已是 muted，无需重复写盘')
})

test('markMuted：未超限 / 已结束的会议都不置位', () => {
  const healthy = meeting()
  assert.equal(markMuted(healthy), false)
  assert.equal(healthy.status, 'active')
  assert.equal(markMuted(meeting({ status: 'ended' })), false)
  assert.equal(markMuted(meeting({ round: 9, status: 'ended', budget: { maxRounds: 3, maxTokens: 10, usedRounds: 9, usedTokens: 99 } })), false)
})

test('P4 回归：主持人发言推进轮次，达到上限即熔断', () => {
  const live = meeting({ budget: { maxRounds: 3, maxTokens: 1000, usedRounds: 0, usedTokens: 0 } })
  // 设 3 轮就能开满 3 轮。
  for (const expected of [1, 2, 3]) {
    beginRound(live)
    assertUsable(live)
    assert.equal(live.round, expected)
    assert.equal(live.budget.usedRounds, expected, 'usedRounds 必须跟随 round')
  }
  // 想开第 4 轮时才触顶。
  beginRound(live)
  assert.throws(() => assertUsable(live), MeetingMutedError)
  assert.equal(budgetExceeded(live), 'rounds')
})
