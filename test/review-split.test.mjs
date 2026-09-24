/**
 * review-split.ts 本地兜底测试（R3/A6）。
 *
 * 这是三道防线里的本地兜底：LLM 拆分不可用时按「观点 N」标记切段，
 * 必须做到"切得开、不丢正文、尾部结论段不混进观点"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitByMarkers, splitUtterance } from '../src/review-split.ts'

/** 造一个只吐固定 chunk 序列的假 LLM（零网络、零余额）。 */
function stubLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const SPLIT_CONFIG = { provider: 'stub', model: 'stub', maxOpinions: 3 }

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

/* ------------------------------------------------------------------ *
 * P2 防回归：LLM 路径的流式 chunk 组装。
 *
 * 宿主适配器同时发 tool-call-delta 分片与 [DONE] 时的 block-end 完整 JSON。
 * 旧实现把两者累进同一个数组再 join，拼出「片1片2…{完整 JSON}」，
 * JSON.parse 必然失败并被 catch 吞掉 —— 于是每一次都静默退化为本地正则，
 * 观点维度与 C1 证据分级从未生效。下面三条锁死这个协议。
 * ------------------------------------------------------------------ */

test('P2 防回归：block-end 的完整 JSON 绝不与分片相加', async () => {
  const full = '{"viewpoints":[{"content":"驳回没反应","dimension":"交互","quote":"没反应"}]}'
  const llm = stubLlm([
    { type: 'tool-call-delta', argumentsDelta: '{"viewpoints":[{"content":"驳回没反应",' },
    { type: 'tool-call-delta', argumentsDelta: '"dimension":"交互","quote":"没反应"}]}' },
    { type: 'block-end', block: { type: 'tool-call', arguments: full } },
  ])
  const lines = await splitUtterance(llm, SPLIT_CONFIG, 'red', '用户点了驳回但界面没反应。')
  assert.ok(
    lines !== null,
    '分片与整块相加会让 JSON 非法 → 退化为本地兜底 → 原文本无「观点 N」标记时返回 null',
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0].dimension, '交互', '维度标签必须来自 LLM 输出')
  assert.equal(lines[0].quote, '没反应', 'quote 是原文子串，应被保留')
})

test('P2 防回归：只有 block-end、没有分片时同样能解析', async () => {
  const llm = stubLlm([
    { type: 'block-end', block: { type: 'tool-call', arguments: '{"viewpoints":[{"content":"越权读取","dimension":"安全"}]}' } },
  ])
  const lines = await splitUtterance(llm, SPLIT_CONFIG, 'red', '存在越权读取。')
  assert.ok(lines !== null)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].dimension, '安全')
})

test('P2 防回归：只有分片、没有 block-end 时退回拼接（协议变体）', async () => {
  const llm = stubLlm([
    { type: 'tool-call-delta', argumentsDelta: '{"viewpoints":[{"content":"查询很慢",' },
    { type: 'tool-call-delta', argumentsDelta: '"dimension":"性能"}]}' },
  ])
  const lines = await splitUtterance(llm, SPLIT_CONFIG, 'red', '查询很慢。')
  assert.ok(lines !== null)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].dimension, '性能')
})

test('P2：模型不走工具调用、直接输出 JSON 文本时仍可用', async () => {
  const llm = stubLlm([
    { type: 'text-delta', text: '{"viewpoints":[{"content":"兼容性缺口","dimension":"兼容"}]}' },
  ])
  const lines = await splitUtterance(llm, SPLIT_CONFIG, 'red', '兼容性有问题。')
  assert.ok(lines !== null)
  assert.equal(lines[0].dimension, '兼容')
})

test('P2：LLM 输出不可解析时才退化为本地兜底（且不丢正文）', async () => {
  const llm = stubLlm([{ type: 'text-delta', text: '这不是 JSON' }])
  const lines = await splitUtterance(llm, SPLIT_CONFIG, 'red', '观点 1（数据）：半行 JSON 会被静默跳过。')
  assert.ok(lines !== null, '应走本地「观点 N」兜底而不是整条失败')
  assert.equal(lines.length, 1)
  assert.ok(lines[0].content.includes('半行 JSON'))
})

test('P2：maxOpinions 上限生效（超出部分被截断）', async () => {
  const llm = stubLlm([
    {
      type: 'block-end',
      block: {
        type: 'tool-call',
        arguments: '{"viewpoints":[{"content":"一","dimension":"A"},{"content":"二","dimension":"B"},{"content":"三","dimension":"C"}]}',
      },
    },
  ])
  const lines = await splitUtterance(llm, { provider: 'stub', model: 'stub', maxOpinions: 2 }, 'red', '一 二 三')
  assert.ok(lines !== null)
  assert.equal(lines.length, 2, '应被 maxOpinions=2 截断')
})
