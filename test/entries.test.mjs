/**
 * 两个界面入口偏好的闸门（v1.0.0-rc.10）。
 *
 * 入口开关是**纯偏好**而不是宿主能力：设置页只写 preferences.json，真正的
 * 注册/注销在 client/index.ts（浏览器半体）里做。因此这里钉的是"读侧契约"：
 *   1. 默认都是 true —— 升级后界面不减能力，想收窄的自己去关；
 *   2. 旧 preferences.json 里没有这两个字段时不得变成 false（否则一次升级
 *      会把所有老用户的入口一起弄丢），沿用 base；
 *   3. 两个开关互相独立，可以全开/全关/任选；
 *   4. 非布尔值一律不采纳（坏数据不落库，与 hiddenPanels / legendHidden 同规）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultPreferences, normalizePreferences } from '../src/preferences.ts'

test('两个入口默认都为 true', () => {
  const base = defaultPreferences('orchestrated')
  assert.equal(base.sidebarEntryEnabled, true)
  assert.equal(base.conversationTabEnabled, true)
})

test('缺字段沿用基准：旧偏好文件不需要版本号迁移', () => {
  const base = defaultPreferences('orchestrated')
  const next = normalizePreferences({ maxRounds: 5 }, base)
  assert.equal(next.sidebarEntryEnabled, true, '缺 sidebarEntryEnabled 时被读成 false = 升级即丢入口')
  assert.equal(next.conversationTabEnabled, true, '缺 conversationTabEnabled 时被读成 false = 升级即丢入口')
  assert.equal(next.maxRounds, 5)
})

test('两个开关互相独立（全关 / 只开侧边栏）', () => {
  const base = defaultPreferences('orchestrated')
  const allOff = normalizePreferences({ sidebarEntryEnabled: false, conversationTabEnabled: false }, base)
  assert.equal(allOff.sidebarEntryEnabled, false)
  assert.equal(allOff.conversationTabEnabled, false)

  const onlySidebar = normalizePreferences({ sidebarEntryEnabled: true, conversationTabEnabled: false }, allOff)
  assert.equal(onlySidebar.sidebarEntryEnabled, true)
  assert.equal(onlySidebar.conversationTabEnabled, false)

  const onlyTab = normalizePreferences({ conversationTabEnabled: true }, onlySidebar)
  assert.equal(onlyTab.sidebarEntryEnabled, true)
  assert.equal(onlyTab.conversationTabEnabled, true)
})

test('非布尔值不采纳（"false" 字符串 / 0 / null 都不算关闭）', () => {
  const base = defaultPreferences('orchestrated')
  for (const value of ['false', '0', 0, 1, null, {}, []]) {
    const next = normalizePreferences({ sidebarEntryEnabled: value, conversationTabEnabled: value }, base)
    assert.equal(next.sidebarEntryEnabled, true, `input=${JSON.stringify(value)}`)
    assert.equal(next.conversationTabEnabled, true, `input=${JSON.stringify(value)}`)
  }
})
