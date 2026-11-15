/**
 * 两个界面入口的**注册闸门**（产物级，与 inject.test.mjs 同一套路）。
 *
 * 钉住的行为：
 *   1. apply 后默认四个界面入口都在（标签页 / 主面板 / 侧边栏行 / 设置页），
 *      且 `main` 一定排在 `sidebar.panellist` 之前 —— 宿主点行时会执行
 *      `layout.selectPanel(id)`，主面板条目缺失那一刻会抛错；
 *   2. 设置页保存后广播 `roundtable:prefs-changed`，插件据此**注销**两个入口
 *      （标签页 + 侧边栏行 + 主面板），再广播一次能**重新注册**回来 ——
 *      也就是"重注册前先 dispose"确实幂等，不会留下重复条目；
 *   3. 两个开关互相独立：只关标签页时侧边栏入口仍在。
 *
 * 这里读的是构建产物 `lib/client.js`：宿主真正加载的是它，源绿而产物说谎
 * 的坑在 inject.test.mjs 里已经踩过一次（见该文件头注释）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

/**
 * 按 DSH 客户端模块系统的方式执行 lib/client.js。
 *
 * 关键点：bundle 整体被 `new Function('window', 'globalThis', source)` 包起来，
 * 所以模块代码里的 `window` 解析成**传入的那个对象**（而不是 globalThis.window）。
 * 这里传入一个带 addEventListener/dispatchEvent 的假 window —— 这正是宿主里
 * 真实存在的形状，也让"保存设置 → 广播事件 → 重新注册"这条链可测。
 */
function loadClientBundle() {
  const requireFromPlugin = createRequire(join(pluginDir, 'package.json'))
  const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
  const table = new Map()
  for (const spec of ['react', 'react/jsx-runtime', 'react-dom']) {
    try { table.set(spec, requireFromPlugin(spec)) } catch { /* 非必需 */ }
  }

  const listeners = new Map()
  const window = {
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type) },
    dispatch(type) {
      const fn = listeners.get(type)
      assert.ok(typeof fn === 'function', `插件没有监听 ${type}`)
      fn({ type })
    },
  }

  let registration = null
  window.__ModuleLoader__ = { load(reg) { registration = reg } }
  new Function('window', 'globalThis', source)(window, globalThis)
  assert.ok(registration !== null, 'lib/client.js 没有调用 __ModuleLoader__.load')

  const exports = registration.factory((spec) => {
    if (table.has(spec)) return table.get(spec)
    throw new Error(`bundle 请求了模块表里没有的 "${spec}"（externals 漂移）`)
  })
  return { exports, window, listeners }
}

/**
 * 与宿主同形的最小 ctx：`inject` 保存回调并返回幂等 disposer（注销时跑回调
 * 里那份注册的清理），所以"注销是否真的发生"可以直接用 registry 断言。
 */
function fakeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      effect(fn) {
        const cleanup = fn()
        return typeof cleanup === 'function' ? cleanup : () => {}
      },
      /** cordis 的 ctx.get：服务缺失返回 undefined。 */
      get() { return undefined },
      locale: {
        register() { return () => {} },
        bind(ns) { return (key) => `${ns}:${key}` },
      },
      slots: {
        inject(_key, callback) {
          let active = callback()
          return () => {
            if (typeof active !== 'function') return
            const dispose = active
            active = undefined
            dispose()
          }
        },
        register(entry, component) {
          const row = { entry, component }
          registered.push(row)
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            const index = registered.indexOf(row)
            if (index >= 0) registered.splice(index, 1)
          }
        },
      },
    },
  }
}

/** 让 RPC 的 Promise 链跑完（fetch 桩是同步 resolve 的）。 */
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

/** 注册表里的 entry name 列表（注册顺序）。 */
function names(registered) {
  return registered.map((row) => row.entry.name)
}

/** fetch 桩：永远回答当前这份偏好。 */
function stubFetch(getPrefs) {
  const saved = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: getPrefs() }) })
  return () => { globalThis.fetch = saved }
}

test('默认四个入口都在，且 main 先于 sidebar.panellist 注册', async () => {
  const { exports } = loadClientBundle()
  const { registered, ctx } = fakeCtx()
  const restoreFetch = stubFetch(() => ({ sidebarEntryEnabled: true, conversationTabEnabled: true }))
  try {
    exports.apply(ctx)
    await settle()
  } finally {
    restoreFetch()
  }

  const list = names(registered)
  for (const key of ['conversation.view', 'main', 'sidebar.panellist', 'settings.section']) {
    assert.ok(list.includes(key), `没有注册 ${key}（当前：${list.join(', ')}）`)
  }
  assert.ok(list.indexOf('main') < list.indexOf('sidebar.panellist'),
    'main 必须早于 sidebar.panellist 注册：宿主点行时 selectPanel 找不到面板会抛错')

  const row = registered.find((item) => item.entry.name === 'sidebar.panellist')
  assert.equal(row.entry.id, 'roundtable')
  assert.equal(row.entry.order, 40)
  assert.equal(row.entry.label(), 'roundtable:sidebarEntry')
  assert.deepEqual(row.entry.inject, undefined, '图标行不需要 inject face（宿主只传 size/active）')

  const panel = registered.find((item) => item.entry.name === 'main')
  assert.equal(panel.entry.key, 'roundtable', 'main 的 key 必须与侧边栏 id 相同')
  const face = panel.entry.inject()
  assert.equal(typeof face.rpc, 'function')
  assert.equal(typeof face.t, 'function')
})

test('广播 prefs-changed：两个入口注销后能再注册回来（幂等）', async () => {
  const { exports, window } = loadClientBundle()
  const { registered, ctx } = fakeCtx()
  let prefs = { sidebarEntryEnabled: true, conversationTabEnabled: true }
  const restoreFetch = stubFetch(() => prefs)
  try {
    exports.apply(ctx)
    await settle()
    assert.ok(names(registered).includes('conversation.view'))

    // 全关：标签页 + 侧边栏行 + 主面板一起消失，设置页不受影响。
    prefs = { sidebarEntryEnabled: false, conversationTabEnabled: false }
    window.dispatch('roundtable:prefs-changed')
    await settle()
    assert.deepEqual(names(registered).sort(), ['settings.section', 'tool.call.toolview'])

    // 全开：能重新注册回来，且没有重复条目。
    prefs = { sidebarEntryEnabled: true, conversationTabEnabled: true }
    window.dispatch('roundtable:prefs-changed')
    await settle()
    assert.deepEqual(
      names(registered).sort(),
      ['conversation.view', 'main', 'settings.section', 'sidebar.panellist', 'tool.call.toolview'],
    )
  } finally {
    restoreFetch()
  }
})

test('两个开关互相独立：只关标签页时侧边栏入口仍在', async () => {
  const { exports, window } = loadClientBundle()
  const { registered, ctx } = fakeCtx()
  let prefs = { sidebarEntryEnabled: true, conversationTabEnabled: true }
  const restoreFetch = stubFetch(() => prefs)
  try {
    exports.apply(ctx)
    await settle()

    prefs = { sidebarEntryEnabled: true, conversationTabEnabled: false }
    window.dispatch('roundtable:prefs-changed')
    await settle()
    const list = names(registered)
    assert.ok(!list.includes('conversation.view'), '关掉 conversationTabEnabled 后标签页仍在注册')
    assert.ok(list.includes('sidebar.panellist'))
    assert.ok(list.includes('main'))

    prefs = { sidebarEntryEnabled: false, conversationTabEnabled: true }
    window.dispatch('roundtable:prefs-changed')
    await settle()
    const next = names(registered)
    assert.ok(next.includes('conversation.view'), '关掉 sidebarEntryEnabled 不该影响标签页')
    assert.ok(!next.includes('sidebar.panellist'))
    assert.ok(!next.includes('main'), '主面板必须跟着侧边栏入口一起注销')
  } finally {
    restoreFetch()
  }
})
