/**
 * token-usage.ts 测试（第 3 批）：真实用量读取的归一化与降级。
 *
 * 这些函数决定"主持人看到的真实花费是不是可信的"，且必须在宿主服务缺失、
 * 会话已冷、字段被换成垃圾时都**只返回 undefined、绝不抛错** —— 观测能力
 * 不该能把 `roundtable_status` 弄崩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  liveSessionPressure,
  liveSessionUsage,
  meetingRealUsage,
  normalizePressure,
  normalizeUsage,
} from '../src/token-usage.ts'

/** 造一个只有本模块用到的两个面的假 ctx。 */
function stubCtx({ sessions = {}, usage = {}, pressure = {}, withProjections = true } = {}) {
  return {
    agents: {
      get: (id) => (Object.prototype.hasOwnProperty.call(sessions, id) ? { session: sessions[id] } : undefined),
    },
    get: (name) => {
      if (name !== 'sessionProjections' || !withProjections) return undefined
      return {
        snapshot: (session) => ({
          values: { tokenUsage: usage[session], contextPressure: pressure[session] },
        }),
      }
    },
  }
}

test('normalizeUsage：四个不重叠的桶相加', () => {
  const usage = normalizeUsage({
    uncachedInputTokens: 100,
    outputTokens: 250,
    cacheReadTokens: 1000,
    cacheWriteTokens: 30,
  })
  assert.equal(usage.total, 1380)
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.outputTokens, 250)
})

test('normalizeUsage：全 0 / 非对象一律返回 undefined（而不是编一个 0 出来）', () => {
  assert.equal(normalizeUsage({ uncachedInputTokens: 0, outputTokens: 0 }), undefined)
  assert.equal(normalizeUsage(undefined), undefined)
  assert.equal(normalizeUsage(null), undefined)
  assert.equal(normalizeUsage('nonsense'), undefined)
})

test('normalizeUsage：负数与 NaN 被夹到 0，不让脏值污染合计', () => {
  const usage = normalizeUsage({ uncachedInputTokens: -50, outputTokens: Number.NaN, cacheReadTokens: 7 })
  assert.equal(usage.total, 7)
})

test('normalizePressure：压力 / 投影 / 上下文窗口', () => {
  const pressure = normalizePressure({ pressureTokens: 12000, projectedTokens: 13000, contextWindow: 128000 })
  assert.equal(pressure.pressureTokens, 12000)
  assert.equal(pressure.contextWindow, 128000)
  assert.equal(normalizePressure({}), undefined, '三个桶全空时没有可展示的信息')
})

test('liveSessionUsage：从 live 会话的投影读出 provider 上报值', () => {
  const ctx = stubCtx({
    sessions: { child: 'session-obj' },
    usage: { 'session-obj': { uncachedInputTokens: 10, outputTokens: 40 } },
  })
  assert.equal(liveSessionUsage(ctx, 'child').total, 50)
})

test('liveSessionUsage：会话不在 live 注册表里时返回 undefined（冷节点不猜）', () => {
  const ctx = stubCtx({ sessions: {}, usage: {} })
  assert.equal(liveSessionUsage(ctx, 'gone'), undefined)
})

test('liveSessionUsage：宿主未挂载投影服务时返回 undefined，且不抛错', () => {
  const ctx = stubCtx({ sessions: { child: 'session-obj' }, withProjections: false })
  assert.equal(liveSessionUsage(ctx, 'child'), undefined)
  assert.equal(liveSessionPressure(ctx, 'child'), undefined)
})

test('liveSessionUsage：空 sessionId 直接跳过', () => {
  assert.equal(liveSessionUsage(stubCtx(), ''), undefined)
})

test('liveSessionUsage：投影抛错被吞掉，退回 undefined', () => {
  const ctx = {
    agents: { get: () => ({ session: 'x' }) },
    get: () => ({
      snapshot: () => {
        throw new Error('projection exploded')
      },
    }),
  }
  assert.equal(liveSessionUsage(ctx, 'child'), undefined)
})

test('meetingRealUsage：分别统计可测与不可测的会话', () => {
  const ctx = stubCtx({
    sessions: { a: 'sa', b: 'sb' },
    usage: { sa: { uncachedInputTokens: 100, outputTokens: 200 } },
  })
  const usage = meetingRealUsage(ctx, ['a', 'b'])
  assert.equal(usage.measuredTotal, 300)
  assert.equal(usage.measuredSessions, 1)
  assert.equal(usage.unmeasuredSessions, 1, '不可测的会话必须如实计数，而不是悄悄少算')
})

test('meetingRealUsage：同一 childId 只算一次，空 id 被忽略', () => {
  const ctx = stubCtx({
    sessions: { a: 'sa' },
    usage: { sa: { outputTokens: 5 } },
  })
  const usage = meetingRealUsage(ctx, ['a', 'a', '', 'a'])
  assert.equal(usage.measuredTotal, 5)
  assert.equal(usage.measuredSessions, 1)
  assert.equal(usage.unmeasuredSessions, 0)
})

test('meetingRealUsage：一个都测不出来时如实返回 0，而不是假装有数', () => {
  const usage = meetingRealUsage(stubCtx(), ['x', 'y'])
  assert.equal(usage.measuredTotal, 0)
  assert.equal(usage.measuredSessions, 0)
  assert.equal(usage.unmeasuredSessions, 2)
})
