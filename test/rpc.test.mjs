/**
 * rpc.ts 输入净化测试（R3/A6 + B3）。
 *
 * 这两个 sanitize* 是"坏数据不落库"的唯一闸门：schemastery 在 resolve
 * 阶段不校验缺失的 required 字段，所以条目级校验只能靠它们。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ROLE_PRESET_MAX, ROUNDTABLE_PANELS, sanitizeHiddenPanels, sanitizeRolePresets } from '../src/rpc.ts'

test('sanitizeHiddenPanels：非数组输入一律返回空数组', () => {
  for (const value of [undefined, null, 42, 'agents', { 0: 'agents' }, true]) {
    assert.deepEqual(sanitizeHiddenPanels(value), [], `input=${JSON.stringify(value)}`)
  }
})

test('sanitizeHiddenPanels：未知 id 丢弃、重复去重、保持首次出现顺序', () => {
  assert.deepEqual(
    sanitizeHiddenPanels(['agents', 'nope', 'kb', 'agents', '  kb  ', '', 'agents']),
    ['agents', 'kb'],
  )
})

test('sanitizeHiddenPanels：接受全部已知面板且不重排', () => {
  assert.deepEqual(sanitizeHiddenPanels([...ROUNDTABLE_PANELS]), [...ROUNDTABLE_PANELS])
})

test('sanitizeRolePresets：非数组输入返回空数组', () => {
  for (const value of [undefined, null, 'x', 3, {}]) {
    assert.deepEqual(sanitizeRolePresets(value), [], `input=${JSON.stringify(value)}`)
  }
})

test('sanitizeRolePresets：缺 name 或 role 的条目被丢弃（schemastery 不会拦）', () => {
  const out = sanitizeRolePresets([
    { id: 'a', name: '', role: '有角色没名字' },
    { id: 'b', name: '有名字没角色' },
    { id: 'c', role: '只有角色' },
    { name: '   ', role: '   ' },
    null,
    7,
    'not-an-object',
  ])
  assert.deepEqual(out, [])
})

test('sanitizeRolePresets：provider/model 必须成对，半对视为继承主持人', () => {
  const [routed] = sanitizeRolePresets([{ id: 'a', name: '安全审查', role: '挑毛病', provider: 'zai-coding-cn', model: 'glm-5.2' }])
  assert.deepEqual(routed, { id: 'a', name: '安全审查', role: '挑毛病', provider: 'zai-coding-cn', model: 'glm-5.2' })

  const [half] = sanitizeRolePresets([{ id: 'b', name: '安全审查', role: '挑毛病', provider: 'zai-coding-cn', model: '' }])
  assert.deepEqual(half, { id: 'b', name: '安全审查', role: '挑毛病' })
  assert.equal('provider' in half, false)
  assert.equal('model' in half, false)
})

test('sanitizeRolePresets：id 缺失或重复时重新分配，保证唯一', () => {
  const out = sanitizeRolePresets([
    { name: 'n1', role: 'r' },
    { id: 'same', name: 'n2', role: 'r' },
    { id: 'same', name: 'n3', role: 'r' },
  ])
  assert.equal(out.length, 3, '重复 id 不应导致条目被丢弃')
  assert.equal(new Set(out.map((entry) => entry.id)).size, 3)
  assert.notEqual(out[1].id, out[2].id)
  assert.equal(out[1].id, 'same', '首个占用该 id 的条目应保留原 id')
})

test('sanitizeRolePresets：超长字段截断、超量条目截断', () => {
  const many = sanitizeRolePresets(
    Array.from({ length: ROLE_PRESET_MAX + 5 }, (_, index) => ({ id: `p${index}`, name: `n${index}`, role: 'r' })),
  )
  assert.equal(many.length, ROLE_PRESET_MAX)

  const [long] = sanitizeRolePresets([{ name: 'x'.repeat(100), role: 'y'.repeat(1000) }])
  assert.equal(long.name.length, 40)
  assert.equal(long.role.length, 400)
})

test('sanitizeRolePresets：空白输入被视为空值', () => {
  assert.deepEqual(sanitizeRolePresets([{ name: '  ', role: 'r' }]), [])
  const [trimmed] = sanitizeRolePresets([{ id: '  a  ', name: '  名称  ', role: '  角色  ' }])
  assert.deepEqual(trimmed, { id: 'a', name: '名称', role: '角色' })
})
