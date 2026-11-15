/**
 * RPC 端点声明表的闸门（H9）。
 *
 * 守的是什么：`rpc-endpoints.ts` 里声明「这个端点要求会议进行中」，而 `rpc.ts`
 * 的实现**真的**传了 `{ requireActive: true }`。两者一旦漂移，端点的状态机闸门
 * 就静默失效 —— 这正是 `kb.list` 曾经漏掉闸门（H5）的形态：没有报错，只有人工
 * 比对才能发现。
 *
 * 这里用**读源码文本**的方式核对（不 import `rpc.ts`：它会拉进一堆宿主服务，
 * 在纯 node 测试环境里跑不起来）。断言的是"同一行里既有这个 case、又有
 * requireActive"或"同一 case 块内出现了 requireActive"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditEndpointDeclarations, checkEndpointGate, ENDPOINTS, ENDPOINT_INDEX } from '../src/rpc-endpoints.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const rpcSource = readFileSync(join(pluginDir, 'src', 'rpc.ts'), 'utf8')

/** 取出一个 case 块的源码文本（从 `case 'x': {` 到下一个 `case` 或 default）。 */
function caseBlock(endpoint) {
  const startAt = rpcSource.indexOf(`case '${endpoint}': {`)
  if (startAt < 0) return undefined
  const rest = rpcSource.slice(startAt + 1)
  const nextCase = rest.indexOf('case \'roundtable/')
  const nextDefault = rest.indexOf('default:')
  const candidates = [nextCase, nextDefault].filter((at) => at >= 0)
  const endAt = candidates.length === 0 ? rest.length : Math.min(...candidates)
  return rest.slice(0, endAt)
}

test('rpc-endpoints：声明表自检无问题（无重复 / 都有 purpose / global 不要求闸门）', () => {
  assert.deepEqual(auditEndpointDeclarations(), [])
})

test('rpc-endpoints：每个声明在 rpc.ts 里都有对应实现', () => {
  for (const spec of ENDPOINTS) {
    assert.ok(
      rpcSource.includes(`case '${spec.endpoint}': {`),
      `声明了 ${spec.endpoint} 但 rpc.ts 里没有对应的 case（声明与实现漂移）`,
    )
  }
})

test('rpc-endpoints：rpc.ts 里每个 case 都在声明表里登记（新增端点必须登记）', () => {
  const declared = rpcSource.match(/case '(roundtable\/[a-z.]+)': \{/g) ?? []
  for (const raw of declared) {
    const endpoint = raw.slice("case '".length, -"': {".length)
    assert.ok(
      ENDPOINT_INDEX.has(endpoint),
      `${endpoint} 在 rpc.ts 里实现但没有在 rpc-endpoints.ts 登记`,
    )
  }
})

test('rpc-endpoints：要求闸门的端点，实现里真的传了 requireActive', () => {
  for (const spec of ENDPOINTS) {
    if (spec.kind !== 'meeting-write' || !spec.requireActive) continue
    const block = caseBlock(spec.endpoint)
    assert.ok(block !== undefined, `${spec.endpoint} 的 case 块没找到`)
    assert.ok(
      block.includes('requireActive: true'),
      `${spec.endpoint} 声明为"要求会议进行中"，但实现里没有传 { requireActive: true }（H5 那类漏闸门）`,
    )
  }
})

test('rpc-endpoints：不要求闸门的会议端点，实现里不应误加 requireActive', () => {
  // 反方向同样值得守：给"已结束会议删除"误加闸门会让删除永远失败。
  for (const spec of ENDPOINTS) {
    if (spec.requireActive) continue
    if (spec.kind !== 'meeting-write' && spec.kind !== 'meeting-read') continue
    const block = caseBlock(spec.endpoint)
    if (block === undefined) continue
    assert.ok(
      !block.includes('requireActive: true'),
      `${spec.endpoint} 声明为"不要求闸门"，但实现里加了 requireActive（会让已结束会议的操作永远失败）`,
    )
  }
})

test('checkEndpointGate：未登记端点会被拒绝', () => {
  const problem = checkEndpointGate('roundtable/not-declared', false)
  assert.ok(typeof problem === 'string' && problem.includes('not declared'))
})

test('checkEndpointGate：声明要求闸门但没传时会报错', () => {
  const problem = checkEndpointGate('roundtable/edge.add', false)
  assert.ok(typeof problem === 'string' && problem.includes('did not pass'))
  assert.equal(checkEndpointGate('roundtable/edge.add', true), undefined)
})

test('checkEndpointGate：不要求闸门的端点放行（传不传都行）', () => {
  assert.equal(checkEndpointGate('roundtable/prefs.get', false), undefined)
})
