/**
 * 阵容预设的净化测试（B3+）。
 *
 * 与 `sanitizeRolePresets` 同一套路：schemastery 在 resolve 阶段**不校验**
 * 缺失的 required 字段，所以"坏数据不落库"只能靠这道手写闸门。
 *
 * 另外钉住兼容性契约：`squads` 是**可选新增字段**（zod 带 `.default([])`），
 * 旧偏好对象里没有它 → 读侧归一化成 `[]`、只有用户真的保存时才写回。
 * 这就是"结构变更必须自带迁移"的最小落地方式：不需要版本号迁移，
 * 也不可能损坏已有数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SQUAD_MAX, SQUAD_MEMBER_MAX, sanitizeSquads } from '../src/rpc.ts'

test('sanitizeSquads：非数组输入一律返回空数组（旧偏好对象 = 兼容契约）', () => {
  for (const value of [undefined, null, 42, 'squad', { 0: 'x' }, true]) {
    assert.deepEqual(sanitizeSquads(value), [], `input=${JSON.stringify(value)}`)
  }
})

test('sanitizeSquads：缺 name 的阵容被丢弃', () => {
  const out = sanitizeSquads([
    { id: 'a', name: '', members: [{ key: 'architect' }] },
    { id: 'b', name: '   ', members: [{ key: 'architect' }] },
    { id: 'c', members: [{ key: 'architect' }] },
    null,
    7,
    'nope',
  ])
  assert.deepEqual(out, [])
})

test('sanitizeSquads：没有任何成员的阵容被丢弃（否则会出现点了没反应的条目）', () => {
  const out = sanitizeSquads([
    { id: 'empty', name: '空阵容', members: [] },
    { id: 'bad', name: '坏成员', members: [{ key: '   ' }, null, 3] },
    { id: 'ok', name: '正常', members: [{ key: 'architect', role: '架构' }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'ok')
})

test('sanitizeSquads：成员 key 归一化（小写、非法字符折成 -、保留中日韩）', () => {
  const [squad] = sanitizeSquads([
    { id: 's', name: '三人组', members: [{ key: '  Architect  ' }, { key: '架构 师!' }, { key: 'QA_Lead' }] },
  ])
  assert.deepEqual(squad.members.map((member) => member.key), ['architect', '架构-师', 'qa-lead'])
})

test('sanitizeSquads：同一阵容内重复 key 只保留第一位', () => {
  const [squad] = sanitizeSquads([
    { id: 's', name: '三人组', members: [{ key: 'architect', role: '第一个' }, { key: 'ARCHITECT', role: '重复' }] },
  ])
  assert.equal(squad.members.length, 1)
  assert.equal(squad.members[0].role, '第一个')
})

test('sanitizeSquads：provider/model 必须成对，半对视为继承主持人', () => {
  const [routed] = sanitizeSquads([
    { id: 'a', name: 'n', members: [{ key: 'k', role: 'r', provider: 'huadou', model: 'claude-opus-5-kiro' }] },
  ])
  assert.deepEqual(routed.members[0], { key: 'k', role: 'r', provider: 'huadou', model: 'claude-opus-5-kiro' })

  const [half] = sanitizeSquads([
    { id: 'b', name: 'n', members: [{ key: 'k', role: 'r', provider: 'huadou', model: '' }] },
  ])
  assert.deepEqual(half.members[0], { key: 'k', role: 'r' })
  assert.equal('provider' in half.members[0], false)
  assert.equal('model' in half.members[0], false)
})

test('sanitizeSquads：id 缺失或重复时重新分配，保证唯一', () => {
  const out = sanitizeSquads([
    { name: 's1', members: [{ key: 'a' }] },
    { id: 'same', name: 's2', members: [{ key: 'b' }] },
    { id: 'same', name: 's3', members: [{ key: 'c' }] },
  ])
  assert.equal(out.length, 3, '重复 id 不应导致条目被丢弃')
  assert.equal(new Set(out.map((squad) => squad.id)).size, 3)
  assert.equal(out[1].id, 'same', '首个占用该 id 的条目保留原 id')
  assert.notEqual(out[1].id, out[2].id)
})

test('sanitizeSquads：超量阵容截断、单阵容成员截断、超长字段截断', () => {
  const manySquads = sanitizeSquads(
    Array.from({ length: SQUAD_MAX + 5 }, (_, index) => ({
      id: `s${index}`,
      name: `阵容${index}`,
      members: [{ key: 'architect' }],
    })),
  )
  assert.equal(manySquads.length, SQUAD_MAX)

  const [big] = sanitizeSquads([
    {
      id: 'big',
      name: 'x'.repeat(100),
      members: Array.from({ length: SQUAD_MEMBER_MAX + 4 }, (_, index) => ({ key: `expert-${index}` })),
    },
  ])
  assert.equal(big.members.length, SQUAD_MEMBER_MAX)
  assert.equal(big.name.length, 40)
})

test('sanitizeSquads：角色说明可空（等于让主持人自己判断）', () => {
  const [squad] = sanitizeSquads([{ id: 's', name: 'n', members: [{ key: 'architect' }] }])
  assert.deepEqual(squad.members[0], { key: 'architect', role: '' })
})
