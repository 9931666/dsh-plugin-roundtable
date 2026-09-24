/**
 * node-events.ts 测试（第 1 批）：宿主子代理生命周期的纯逻辑部分。
 *
 * 这些函数决定"一位专家的产出要不要落盘、失败要不要可见"，是整批修复的
 * 判定核心，因此必须在**零模型、零宿主**的前提下可测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetNodeIndexForTests,
  blocksToText,
  describeNodeEnd,
  describeRequestFailure,
  forgetNodeChild,
  locateNodeChild,
  registerNodeChild,
} from '../src/node-events.ts'

test('blocksToText：拼接文本块、忽略非文本块、空输入返回空串', () => {
  assert.equal(blocksToText(undefined), '')
  assert.equal(blocksToText([]), '')
  assert.equal(
    blocksToText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]),
    '第一段\n第二段',
  )
  assert.equal(blocksToText([{ type: 'reasoning', text: '思考过程' }]), '', 'reasoning 不是可见产出')
  assert.equal(blocksToText([{ type: 'text', text: '   \n  ' }]), '', '纯空白视为无产出')
})

test('describeNodeEnd：有产出时捕获文本，且不写错误说明', () => {
  const outcome = describeNodeEnd({
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '结论：A 方案更省。' }],
  })
  assert.equal(outcome.text, '结论：A 方案更省。')
  assert.equal(outcome.note, '', '有产出就不该留 lastError')
})

test('describeNodeEnd：无产出时给出带 stopReason 的说明（v0-2-36 整场报废的场景）', () => {
  const aborted = describeNodeEnd({ stopReason: 'aborted' })
  assert.equal(aborted.text, '')
  assert.match(aborted.note, /aborted/)

  const errored = describeNodeEnd({ stopReason: 'error' })
  assert.equal(errored.text, '')
  assert.match(errored.note, /error/)

  const maxTokens = describeNodeEnd({ stopReason: 'max-tokens' })
  assert.match(maxTokens.note, /max-tokens/)
})

test('describeNodeEnd：正常结束但没有内容，措辞不同于硬失败', () => {
  const silent = describeNodeEnd({ stopReason: 'completed' })
  assert.equal(silent.text, '')
  assert.match(silent.note, /没有产出内容/)
  assert.ok(!silent.note.includes('completed'), '正常结束不该把内部枚举丢给用户')
})

test('describeNodeEnd：stopReason 缺失时退化为 unknown 而不是抛错', () => {
  const outcome = describeNodeEnd({})
  assert.equal(outcome.text, '')
  assert.match(outcome.note, /unknown/)
})

test('describeRequestFailure：带上 provider、HTTP 状态与错误码（余额不足场景）', () => {
  const note = describeRequestFailure('zai-coding-cn', {
    message: 'insufficient balance',
    code: 'insufficient_quota',
    status: 402,
  })
  assert.match(note, /zai-coding-cn/)
  assert.match(note, /HTTP 402/)
  assert.match(note, /insufficient_quota/)
  assert.match(note, /insufficient balance/)
})

test('describeRequestFailure：没有 status / message 时不留 "undefined"', () => {
  const note = describeRequestFailure('kimi-coding', { code: 'unknown' })
  assert.ok(!note.includes('undefined'), `不得出现 undefined：${note}`)
  assert.match(note, /kimi-coding/)

  const bare = describeRequestFailure('p', undefined)
  assert.ok(!bare.includes('undefined'), `不得出现 undefined：${bare}`)
})

test('节点索引：登记、按 childId 查询、注销', () => {
  __resetNodeIndexForTests()
  const location = { stateRoot: '/tmp/ws/.roundtable', meetingId: 'm1' }
  registerNodeChild('child-1', location)
  assert.deepEqual(locateNodeChild('child-1'), location)
  assert.equal(locateNodeChild('child-unknown'), undefined, '未登记的 childId 不得被归属')
  forgetNodeChild('child-1')
  assert.equal(locateNodeChild('child-1'), undefined)
})

test('节点索引：空 childId 不入索引（spawn 失败的节点）', () => {
  __resetNodeIndexForTests()
  registerNodeChild('', { stateRoot: '/tmp', meetingId: 'm' })
  assert.equal(locateNodeChild(''), undefined, '空 id 绝不能命中任何会议')
})
