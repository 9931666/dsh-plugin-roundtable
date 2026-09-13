/**
 * budget.ts 纯函数测试（R3/A6）：token 估算单调性与熔断边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetExceeded, ensureActive, estimateTokens, MeetingEndedError, MeetingMutedError } from '../src/budget.ts'

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

test('熔断边界：轮数恰好等于上限即算超限', () => {
  assert.equal(budgetExceeded(meeting({ round: 3 })), 'rounds')
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

test('ensureActive：未超限时不抛错、状态保持 active', () => {
  const fresh = meeting()
  ensureActive(fresh)
  assert.equal(fresh.status, 'active')
})

test('ensureActive：超限时置为 muted 并抛 MeetingMutedError', () => {
  const over = meeting({ round: 3 })
  assert.throws(() => ensureActive(over), MeetingMutedError)
  assert.equal(over.status, 'muted')
})

test('ensureActive：已 muted 且仍超限时继续抛（不会静默放行）', () => {
  const muted = meeting({ round: 4, status: 'muted' })
  assert.throws(() => ensureActive(muted), MeetingMutedError)
})

test('ensureActive：ended / archived 一律抛 MeetingEndedError', () => {
  for (const status of ['ended', 'archived']) {
    assert.throws(() => ensureActive(meeting({ status })), MeetingEndedError, `status=${status} 应被拒绝`)
  }
})
