/**
 * 版本号一致性测试（R2/A5 的防回归闸门）。
 *
 * 立这道闸门的原因是一个真实缺陷：`renderReviewMarkdown` 的导出头部曾
 * 长期硬编码 `v0.2.21`，而 package.json 已经走到 0.2.32 —— 导出物里的
 * 版本号说了谎，却没有任何测试会发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PLUGIN_ID, PLUGIN_VERSION } from '../src/version.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageJsonPath = join(here, '..', 'package.json')

test('src/version.ts 的 PLUGIN_VERSION 必须与 package.json 的 version 逐字一致', async () => {
  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  assert.equal(
    PLUGIN_VERSION,
    parsed.version,
    `src/version.ts 是 ${PLUGIN_VERSION}，package.json 是 ${parsed.version} —— 改版本时两处都要改`,
  )
})

test('PLUGIN_ID 由当前版本号拼装（不再出现硬编码旧版本）', () => {
  assert.equal(PLUGIN_ID, `@huanlin/dsh-plugin-roundtable v${PLUGIN_VERSION}`)
})

test('版本号是形如 x.y.z 的语义化版本', () => {
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
})
