/**
 * 界面装配的产物级断言（v0.2.36，防"整个插件静默消失"）。
 *
 * 立这道闸门的原因是一条实测缺陷链：cordis 的 `inject` **没有可选形式**
 * （`Inject = string[] | 拦截配置对象`），所以列在 `inject` 里的服务缺失时，
 * 整个插件 fiber 停在 PENDING——`roundtable_*` 工具、`/plugins/...` 路由、
 * Web GUI 页签与设置页**一起**不出现，且没有任何报错。用户看到的就是
 * 「无法调用界面」。
 *
 * 因此这里断言的是**构建产物**而不是源码，理由与 version.test.mjs 相同：
 * lib/ 才是 profile（`link:` 挂载）真正加载的东西，源绿而产物说谎的坑已经
 * 踩过一次。
 *
 * 1. 宿主 `lib/index.js` 的 `inject` 只列必需服务：`skills` / `userQuestions`
 *    都是运行时用 `ctx.get(...)` 可选读取的能力（skills.ts 的硬约束 #1 明确
 *    要求"没有 skill 服务也必须能加载"）。
 * 2. 浏览器 `lib/client.js` 的 `inject` 不含 `connection`（它只是 RPC 兜底
 *    传输），并且**在没有 connection 服务的 ctx 上**调用 `apply()` 时，仍必须
 *    注册 `conversation.view` 与 `settings.section` 两个入口。
 * 3. 两个入口都必须包在渲染错误边界里：DSH 会静默摘掉渲染抛错的条目，包了
 *    边界才会留下可读的报错（slot-boundary.tsx）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')

/** 运行时可选读取的宿主能力：一旦列进 inject 就会拖死整个插件。 */
const OPTIONAL_HOST_SERVICES = ['userQuestions', 'skills']
/** 插件离开它们无法工作（注册工具 / 拉专家 / 写总纲）。 */
const REQUIRED_HOST_SERVICES = ['tools', 'subagents', 'agents', 'systemPrompt']

test('宿主产物 inject 只列必需服务，可选能力不得拖死整个插件', async () => {
  const mod = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)
  assert.ok(Array.isArray(mod.inject), 'lib/index.js 必须导出 inject 数组')
  for (const optional of OPTIONAL_HOST_SERVICES) {
    assert.ok(
      !mod.inject.includes(optional),
      `inject 里出现了可选服务 "${optional}"：它缺失时插件会整体不加载。请改用 ctx.get("${optional}") 读取`,
    )
  }
  for (const required of REQUIRED_HOST_SERVICES) {
    assert.ok(mod.inject.includes(required), `inject 缺少必需服务 "${required}"`)
  }
})

/**
 * 按 DSH 客户端模块系统的方式执行 lib/client.js：
 * `window.__ModuleLoader__.load({ id, factory })` + 只回答声明过 externals 的 require。
 */
function loadClientBundle() {
  const requireFromPlugin = createRequire(join(pluginDir, 'package.json'))
  const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
  const table = new Map()
  for (const spec of ['react', 'react/jsx-runtime', 'react-dom']) {
    try { table.set(spec, requireFromPlugin(spec)) } catch { /* 非必需 */ }
  }

  let registration = null
  const savedWindow = globalThis.window
  const savedLoader = globalThis.__ModuleLoader__
  globalThis.window = globalThis
  globalThis.__ModuleLoader__ = { load(reg) { registration = reg } }
  try {
    new Function('window', 'globalThis', source)(globalThis, globalThis)
  } finally {
    if (savedWindow === undefined) delete globalThis.window
    else globalThis.window = savedWindow
    if (savedLoader === undefined) delete globalThis.__ModuleLoader__
    else globalThis.__ModuleLoader__ = savedLoader
  }

  assert.ok(registration !== null, 'lib/client.js 没有调用 __ModuleLoader__.load')
  const exports = registration.factory((spec) => {
    if (table.has(spec)) return table.get(spec)
    throw new Error(`bundle 请求了模块表里没有的 "${spec}"（externals 漂移）`)
  })
  return { id: registration.id, exports }
}

/** 一个"没有 connection 服务"的宿主形状 ctx（正是本次修的故障场景）。 */
function hostShapedCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      effect(fn) { return fn() },
      /** 可选读取：cordis 的 ctx.get 在服务缺失时返回 undefined。 */
      get() { return undefined },
      locale: {
        register() { return () => {} },
        bind(ns) { return (key) => `${ns}:${key}` },
      },
      slots: {
        inject(_key, callback) { return callback() },
        register(entry, component) { registered.push({ entry, component }); return () => {} },
      },
    },
  }
}

test('浏览器产物 inject 不含可选传输 connection，且必须注册两个界面入口', () => {
  const { id, exports } = loadClientBundle()
  assert.equal(id, '@huanlin/dsh-plugin-roundtable', 'bundle 注册的 id 必须与包名一致')
  assert.ok(!exports.inject.includes('connection'),
    'inject 里出现了 "connection"：它只是 RPC 兜底传输，缺失时会让页签与设置页整体不注册')

  const { registered, ctx } = hostShapedCtx()
  exports.apply(ctx)

  const view = registered.find((row) => row.entry.name === 'conversation.view' && row.entry.id === 'roundtable')
  const settings = registered.find((row) => row.entry.name === 'settings.section' && row.entry.id === 'roundtable')
  assert.ok(view !== undefined, '没有注册 conversation.view / roundtable —— 圆桌会议页签不会出现')
  assert.ok(settings !== undefined, '没有注册 settings.section / roundtable —— 设置页不会出现')

  // 标签解析成文案，而不是抛错（locale 生效的证据）。
  assert.equal(view.entry.label(), 'roundtable:tab')
  assert.equal(settings.entry.label(), 'roundtable:settingsNav')
  // inject face 必须提供 rpc 与 t，否则组件首帧就崩。
  for (const row of [view, settings]) {
    const face = row.entry.inject()
    assert.equal(typeof face.rpc, 'function', `${row.entry.name} 的 inject face 缺少 rpc`)
    assert.equal(typeof face.t, 'function', `${row.entry.name} 的 inject face 缺少 t`)
  }
})

test('两个界面入口都包在渲染错误边界里（崩溃要留下可读报错，而不是静默消失）', () => {
  const { exports } = loadClientBundle()
  const { registered, ctx } = hostShapedCtx()
  exports.apply(ctx)
  for (const row of registered) {
    const name = row.component?.displayName ?? row.component?.name ?? ''
    assert.match(
      String(name),
      /^RoundTableBoundary\(/,
      `${row.entry.name} 的组件没有被错误边界包裹（当前是 "${name}"）—— DSH 会静默摘掉渲染抛错的条目`,
    )
  }
})
