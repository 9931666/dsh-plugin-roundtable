/**
 * review-split.ts 本地兜底测试（R3/A6）。
 *
 * 这是三道防线里的本地兜底：LLM 拆分不可用时按「观点 N」标记切段，
 * 必须做到"切得开、不丢正文、尾部结论段不混进观点"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitByMarkers } from '../src/review-split.ts'

test('本地兜底：按「观点 N（维度）」切分且不丢正文', () => {
  const content = '观点 1（数据一致性）：先写后清不是原子操作，半行 JSON 会被静默跳过。 '
    + '观点 2（交互）：驳回点了没反应，用户不知道是否生效。 '
    + '[核心产出] 以上两条。 [下一步建议] 先修第一条。'
  const lines = splitByMarkers(content)
  assert.ok(lines !== null, '应识别出观点标记')
  assert.equal(lines.length, 2)
  assert.match(lines[0].content, /^观点 1（数据一致性）：/)
  assert.ok(lines[0].content.includes('半行 JSON'), '第一条正文不得丢失')
  assert.match(lines[1].content, /^观点 2（交互）：/)
  assert.ok(lines[1].content.includes('驳回点了没反应'), '第二条正文不得丢失')
})

test('本地兜底：尾部 [核心产出] / [下一步建议] 不进入任何观点', () => {
  const content = '观点 1（安全）：存在越权读取。 [核心产出] 一条缺陷。 [下一步建议] 加固 RPC。'
  const lines = splitByMarkers(content)
  assert.ok(lines !== null)
  for (const line of lines) {
    assert.ok(!line.content.includes('[核心产出]'), '核心产出段落混入了观点')
    assert.ok(!line.content.includes('[下一步建议]'), '下一步建议段落混入了观点')
  }
})

test('本地兜底：带 Markdown 粗体的标记同样可切', () => {
  const lines = splitByMarkers('**观点 1（安全）**：存在越权读取。 **观点 2（性能）**：状态轮询抖动。')
  assert.ok(lines !== null)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].content.includes('越权读取'))
  assert.ok(lines[1].content.includes('轮询抖动'))
})

test('本地兜底：没有观点标记时返回 null（交由调用方整条兜底 seq=0）', () => {
  assert.equal(splitByMarkers('这是一段没有任何标记的自由发言。'), null)
  assert.equal(splitByMarkers(''), null)
  assert.equal(splitByMarkers('   \n\t '), null)
})

test('本地兜底：多行输入先归一化空白，仍能切出全部观点', () => {
  const content = '观点 1（流程）\n第一条正文。\n\n观点 2（兼容）\n第二条正文。\n观点 3（其他）\n第三条正文。'
  const lines = splitByMarkers(content)
  assert.ok(lines !== null)
  assert.equal(lines.length, 3)
  assert.ok(lines[2].content.includes('第三条正文'))
})
