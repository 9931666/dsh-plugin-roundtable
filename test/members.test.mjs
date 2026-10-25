/**
 * 专家节点的子代理契约测试：两套宿主 API 都要被真正走到。
 *
 * 0.2.1 起宿主收敛了子代理契约：`startContinuable` 与 per-child `persona` /
 * `toolFilter` 一起被移除，改为 `startActivation` + persona 并入首条 prompt。
 * 旧宿主（0.2.0 及更早）仍然接收独立字段。两条路径都不能只是"类型上通过"，
 * 所以这里各拉一次节点，把真正下发给宿主的 spec 抓回来断言。
 *
 * 用最小假 ctx：`spawnNode` 只碰 `subagents`、`tools.get` 与 `logger`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnNode } from '../src/members.ts'

/** 最小会议：一位专家、无连线，足够构造 persona。 */
function meeting() {
  return {
    schemaVersion: 2,
    id: 'demo',
    name: '架构评审',
    goal: '在 A/B 两个方案里选一个',
    mode: 'orchestrated',
    captainSessionId: 'session-1',
    charter: '',
    nodes: [{ key: 'researcher', role: '调研', status: 'idle', joinedAt: 1 }],
    edges: [],
    decisions: [],
    budget: { maxRounds: 6, maxTokens: 120_000, usedRounds: 0, usedTokens: 0 },
    round: 1,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

function fakeCtx(subagents) {
  return {
    logger: { warn() {} },
    subagents,
    tools: { get: () => undefined },
  }
}

const CAPTAIN = {}
const CONFIG = { provider: 'spawn' }
const SIGNAL = new AbortController().signal

test('新宿主：走 startActivation，persona 并入首条 prompt，delivery=parent', async () => {
  const captured = {}
  const ctx = fakeCtx({
    getProvider: () => ({ prepareContinuable: () => {} }),
    list: () => ['spawn'],
    startActivation: async (spec) => {
      captured.spec = spec
      return { childId: 'child-1' }
    },
  })
  const m = meeting()
  const node = m.nodes[0]
  await spawnNode(ctx, CONFIG, m, node, CAPTAIN, '.roundtable', SIGNAL)

  assert.equal(node.id, 'child-1', 'childId 必须写回节点')
  assert.equal(captured.spec.delivery, 'parent', '结果要通知主持人（父代理）')
  assert.equal('persona' in captured.spec.request, false, '新宿主不再接收 persona 字段')
  assert.equal('toolFilter' in captured.spec.request, false, '新宿主不再接收 toolFilter 字段')

  const blocks = captured.spec.request.prompt
  assert.equal(blocks.length, 2, '首条 prompt = welcome + persona 两段')
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'text')
  assert.ok(blocks[1].text.length > 0, 'persona 段不能为空')
  assert.ok(blocks[1].text.includes('researcher'), 'persona 段要带上该节点的身份')
})

test('旧宿主：走 startContinuable，persona/toolFilter 作为独立字段下发', async () => {
  const captured = {}
  const ctx = fakeCtx({
    getProvider: () => ({ prepareContinuable: () => {} }),
    list: () => ['spawn'],
    startContinuable: async (spec) => {
      captured.spec = spec
      return { childId: 'child-2' }
    },
  })
  const m = meeting()
  const node = m.nodes[0]
  await spawnNode(ctx, CONFIG, m, node, CAPTAIN, '.roundtable', SIGNAL)

  assert.equal(node.id, 'child-2')
  assert.equal(typeof captured.spec.request.persona, 'string', '旧宿主仍用独立 persona 字段')
  assert.ok('toolFilter' in captured.spec.request, '旧宿主仍用 toolFilter 硬限制')
  assert.equal(captured.spec.request.prompt.length, 1, '旧宿主 prompt 仍是单段 welcome')
})

test('两个入口都不存在时给出可诊断的错误，而不是静默失败', async () => {
  const ctx = fakeCtx({
    getProvider: () => ({ prepareContinuable: () => {} }),
    list: () => ['spawn'],
  })
  const m = meeting()
  await assert.rejects(
    () => spawnNode(ctx, CONFIG, m, m.nodes[0], CAPTAIN, '.roundtable', SIGNAL),
    /neither startActivation .* nor startContinuable/,
  )
})
