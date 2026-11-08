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

/** 拉一个节点，返回真正下发给宿主的 persona 文本（新宿主路径）。 */
async function personaOf(nodePatch) {
  const captured = {}
  const ctx = fakeCtx({
    getProvider: () => ({ prepareContinuable: () => {} }),
    list: () => ['spawn'],
    startActivation: async (spec) => {
      captured.spec = spec
      return { childId: 'child-x' }
    },
  })
  const m = meeting()
  Object.assign(m.nodes[0], nodePatch)
  await spawnNode(ctx, CONFIG, m, m.nodes[0], CAPTAIN, '.roundtable', SIGNAL)
  return captured.spec.request.prompt[1].text
}

test('expertPrompt 进入 persona：形成「专家补充定位」段并带不可覆盖声明', async () => {
  const persona = await personaOf({ expertPrompt: '只盯密钥轮换与权限边界，不要泛泛谈架构' })
  assert.ok(persona.includes('专家补充定位'), 'persona 缺少补充定位段')
  assert.ok(persona.includes('只盯密钥轮换与权限边界，不要泛泛谈架构'), '补充定位正文没有进入 persona')
  assert.ok(
    persona.includes('只放宽专长，不放宽总纲红线/拍板边界，冲突以硬约束为准'),
    '补充定位段必须声明硬边界（否则提示词就成了绕过红线的后门）',
  )
})

test('expertPrompt 为空（缺省 / 空串 / 纯空白）时 persona 逐字不变，不多空行', async () => {
  const baseline = await personaOf({})
  const emptyString = await personaOf({ expertPrompt: '' })
  const whitespace = await personaOf({ expertPrompt: '   \n  ' })
  assert.equal(emptyString, baseline, '空串必须与缺省逐字一致')
  assert.equal(whitespace, baseline, '纯空白必须与缺省逐字一致')
  assert.ok(!baseline.includes('专家补充定位'), '没填提示词就不该出现该段')
})
