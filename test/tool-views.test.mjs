/**
 * tool-views-model.ts 测试（第 4 批）：`roundtable_status` 卡片的取数与判型。
 *
 * 这些函数决定"卡片是显示真实数据、回退纯文本、还是干脆不接管渲染"，
 * 因此必须能在零依赖、零 DOM、零 JSX 的前提下测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blockTextOf,
  fieldText,
  nodeLine,
  parseStatusPayload,
} from '../src/client/tool-views-model.ts'

test('blockTextOf：拼接 text 块、忽略非 text、无 content 时返回空串', () => {
  assert.equal(blockTextOf(undefined), '')
  assert.equal(blockTextOf({}), '')
  assert.equal(blockTextOf({ content: [] }), '')
  assert.equal(
    blockTextOf({ content: [{ type: 'text', text: '第一段' }, { type: 'image' }, { type: 'text', text: '第二段' }] }),
    '第一段\n第二段',
  )
})

test('parseStatusPayload：认领带 meeting_name 的 JSON', () => {
  const payload = parseStatusPayload(JSON.stringify({ meeting_name: '评审', nodes: [], budget: { used_tokens: 1 } }))
  assert.ok(payload !== null)
  assert.equal(payload.meeting_name, '评审')
})

test('parseStatusPayload：缺 meeting_name 时不接管渲染（回退通用行）', () => {
  assert.equal(parseStatusPayload(JSON.stringify({ hello: 'world' })), null)
  assert.equal(parseStatusPayload(JSON.stringify([1, 2, 3])), null)
  assert.equal(parseStatusPayload(JSON.stringify('a string')), null)
  assert.equal(parseStatusPayload('null'), null)
})

test('parseStatusPayload：非 JSON 或空串一律 null，绝不抛错', () => {
  assert.equal(parseStatusPayload(''), null)
  assert.equal(parseStatusPayload('这不是 JSON'), null)
  assert.equal(parseStatusPayload('{ 半行'), null)
})

test('fieldText：undefined / null 不产生 "undefined" 字样', () => {
  assert.equal(fieldText(undefined), '')
  assert.equal(fieldText(null), '')
  assert.equal(fieldText('x'), 'x')
  assert.equal(fieldText(0), '0', '0 是有效值，不能被当成空')
})

test('nodeLine：常规节点给出 key 与 状态/活动', () => {
  const line = nodeLine({ key: 'red', status: 'idle', activity: 'ready' })
  assert.match(line, /red/)
  assert.match(line, /idle\/ready/)
  assert.ok(!line.includes('undefined'))
})

test('nodeLine：missing 活动标注"宿主已不认识"', () => {
  const line = nodeLine({ key: 'red', status: 'idle', activity: 'missing' })
  assert.match(line, /宿主已不认识/)
})

test('nodeLine：last_error 印在行内（第 1 批的失败诊断）', () => {
  const line = nodeLine({
    key: 'red',
    status: 'idle',
    activity: 'ready',
    last_error: '请求失败（provider=zai HTTP 402）',
  })
  assert.match(line, /HTTP 402/)
})

test('nodeLine：字段缺失也不产生 undefined', () => {
  const line = nodeLine({})
  assert.ok(!line.includes('undefined'), line)
})
