/**
 * 宿主支持矩阵与兼容边界的一致性测试。
 *
 * 这些断言防的是同一类事故：**"本机好好的、用户装完就坏"**。
 * 它们在 CI / 发布门禁里必须全绿 —— `scripts/compatibility.mjs` 是可执行的
 * 门禁，本文件是同一组不变量的单元级版本（不依赖文件系统以外的环境）。
 *
 * 起因（真实）：`compatibility.json` 把基线定到 rc.3，而 package.json 的
 * devDependencies 还停在 rc.2；`HARNESS_RANGE` 也硬编码着 rc.2。三处各说各话，
 * 消费者的 `npm install` 会拿到与运行宿主不匹配的类型，而编译期毫无察觉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPABILITY_SPECS,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  asDisposer,
  effectWithOptionalDisposer,
  noteCapability,
  resetCapabilityAudit,
  capabilityAudit,
} from '../src/harness-compat.ts'
import { HARNESS_RANGE, PLUGIN_VERSION } from '../src/version.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('能力清单：代码、矩阵两处逐字一致', () => {
  assert.deepEqual([...REQUIRED_CAPABILITIES], compatibility.capabilities.required)
  assert.deepEqual([...OPTIONAL_CAPABILITIES], compatibility.capabilities.optional)
})

test('每个被声明的能力都在 CAPABILITY_SPECS 里有探测点', () => {
  const declared = [...compatibility.capabilities.required, ...compatibility.capabilities.optional]
  const documented = CAPABILITY_SPECS.map((spec) => spec.id)
  for (const id of declared) {
    assert.ok(documented.includes(id), `能力 "${id}" 已声明但没有探测点登记`)
  }
  for (const id of documented) {
    assert.ok(declared.includes(id), `探测点 "${id}" 没有在 compatibility.json 里声明`)
  }
})

test('CAPABILITY_SPECS 的 kind 与矩阵分类一致', () => {
  for (const spec of CAPABILITY_SPECS) {
    const expected = compatibility.capabilities.required.includes(spec.id) ? 'required' : 'optional'
    assert.equal(spec.kind, expected, `${spec.id} 的 kind 应为 ${expected}`)
  }
})

test('支持矩阵：recommendedHost 必须是受支持条目之一', () => {
  const versions = compatibility.supportedHosts.map((host) => host.version)
  assert.ok(
    versions.includes(compatibility.recommendedHost),
    `recommendedHost=${compatibility.recommendedHost} 不在 supportedHosts=${JSON.stringify(versions)} 中`,
  )
})

test('类型基线：package.json 与矩阵一致，且 devDependencies 精确指向基线', () => {
  assert.equal(pkg.roundtable.hostBaseline, compatibility.recommendedHost)
  for (const name of compatibility.baseline.packages) {
    assert.equal(
      pkg.devDependencies[name],
      compatibility.recommendedHost,
      `${name} 的 devDependency 必须精确等于基线（否则消费者拿到的类型与运行宿主不一致）`,
    )
  }
})

test('peerDependencies 覆盖 recommendedHost', () => {
  const wanted = compatibility.recommendedHost
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    // 区间形如 ^0.1.5-rc.1；只要 major.minor.patch 与基线一致即可覆盖其 prerelease
    const bare = range.replace(/^\^/, '')
    const base = bare.split('-')[0]
    assert.equal(
      base,
      wanted.split('-')[0],
      `${name} 的 peer 区间 ${range} 不覆盖基线 ${wanted}`,
    )
  }
})

test('导出的宿主区间与矩阵一致（不再各说各话）', () => {
  assert.ok(
    HARNESS_RANGE.includes(compatibility.recommendedHost),
    `HARNESS_RANGE="${HARNESS_RANGE}" 未包含基线 ${compatibility.recommendedHost}`,
  )
})

test('插件版本号在 package.json 与源码两侧一致', () => {
  assert.equal(PLUGIN_VERSION, pkg.version)
})

/* ---------------- 兼容边界的运行时行为 ---------------- */

test('asDisposer：只接受函数形状，其余一律 undefined', () => {
  const fn = () => {}
  assert.equal(asDisposer(fn), fn)
  for (const notADisposer of [undefined, null, 0, '', {}, [], Promise.resolve()]) {
    assert.equal(asDisposer(notADisposer), undefined)
  }
})

test('effectWithOptionalDisposer：形状合法才注册清理器', () => {
  const registered = []
  const ctx = {
    effect(callback, label) {
      registered.push({ cleanup: callback(), label })
      return { dispose() {} }
    },
  }
  let released = 0
  assert.equal(effectWithOptionalDisposer(ctx, () => { released += 1 }, 'x'), true)
  assert.equal(registered.length, 1)
  registered[0].cleanup()
  assert.equal(released, 1)

  // 返回值不是函数时不得注册 —— 否则会留下一个永远不执行的 effect
  assert.equal(effectWithOptionalDisposer(ctx, undefined, 'y'), false)
  assert.equal(effectWithOptionalDisposer(ctx, { dispose() {} }, 'z'), false)
  assert.equal(registered.length, 1, '非法形状不应产生 effect')
})

test('noteCapability：每个能力只记第一条探测（避免轮询刷爆）', () => {
  resetCapabilityAudit()
  noteCapability('llm', 'available', '第一次')
  noteCapability('llm', 'missing', '第二次不该覆盖')
  const entry = capabilityAudit().get('llm')
  assert.equal(entry.state, 'available')
  assert.equal(entry.note, '第一次')
  resetCapabilityAudit()
  assert.equal(capabilityAudit().size, 0)
})
