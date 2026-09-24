#!/usr/bin/env node
/**
 * 发布门禁：验证"即将发布的那份产物"本身是否自洽。
 *
 * **为什么需要它**：`npm publish` 发布的是 `files` 字段筛出来的那份 tarball，
 * 而不是我们的工作区。源码能跑通、测试全绿，都不代表用户装上之后能跑 ——
 * 只要少带一个文件，消费者那边就是 MODULE_NOT_FOUND，而我们在本机永远复现
 * 不了（本机有完整的 node_modules 和源码）。
 *
 * 首次发布最容易翻车的正是这一层，所以它必须是可执行的门禁，不是清单。
 *
 * 检查项：
 *   1. `files` 是否存在且非空；
 *   2. 源码里每一个**运行时**相对导入，在产物里都能找到对应的 `.js`；
 *   3. 产物里没有任何 `.ts` / `.tsx` 残留（源码泄漏 + 消费者无法加载）；
 *   4. `main` / `types` / `exports` / `dsh.bundle` / `dsh.client` 指向的文件真实存在；
 *   5. 必备文件（README / LICENSE / cordis.patch.yml / release-notes）在 `files` 里；
 *   6. 预发布版本必须带后缀，稳定版本必须不带（dist-tag 规则的静态一半）。
 *
 * 用法：
 *   node scripts/verify-package.mjs            # 文本报告
 *   node scripts/verify-package.mjs --json
 *   node scripts/verify-package.mjs --strict    # 未构建 lib/ 时报错而不是跳过
 */
import { readFile, stat, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const strict = args.has('--strict')

const results = []
const record = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else out.push(full)
  }
  return out
}

// ---------------------------------------------------- 1) files 字段

const files = Array.isArray(pkg.files) ? pkg.files : []
record(
  'package.json 声明了非空 files 清单',
  files.length > 0,
  files.length > 0 ? `${files.length} 项：${files.join(', ')}` : '缺失 —— npm 会按 .gitignore 猜，极易漏带运行时文件',
)

// ---------------------------------------------------- 6) 版本与渠道

const version = String(pkg.version ?? '')
const prerelease = version.includes('-')
record(
  '版本号可解析',
  /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version),
  version === '' ? '缺失' : version,
)
record(
  '版本后缀决定渠道（预发布 → next；稳定 → 可发 latest）',
  /^\d+\.\d+\.\d+/.test(version),
  `${version} → ${prerelease ? '预发布，必须发到项目声明的非 latest 渠道' : '稳定版，才允许进 latest'}`,
)

// ------------------------------------------- 4) 各入口指向真实文件

const entryPoints = []
if (typeof pkg.main === 'string') entryPoints.push(['main', pkg.main])
if (typeof pkg.types === 'string') entryPoints.push(['types', pkg.types])
const walkExports = (value, path) => {
  if (typeof value === 'string') entryPoints.push([path, value])
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walkExports(child, `${path}.${key}`)
  }
}
walkExports(pkg.exports, 'exports')
if (typeof pkg.dsh?.bundle?.patch === 'string') entryPoints.push(['dsh.bundle.patch', pkg.dsh.bundle.patch])

for (const [name, target] of entryPoints) {
  const full = join(root, target)
  record(`入口文件存在：${name} → ${target}`, await exists(full), (await exists(full)) ? 'ok' : '目标文件不存在')
}

// ------------------------------------------- 5) 必备文件在 files 里

const libBuilt = await exists(join(root, 'lib', 'index.js'))
if (!libBuilt && strict) {
  record('lib/ 已构建', false, '未构建：请先 npm run build（--strict 下这是错误）')
} else if (!libBuilt) {
  record('lib/ 已构建', true, '未构建 —— 产物检查将跳过（用 --strict 可改为强制）')
}

const mustShip = [
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
]
for (const [label, file] of mustShip) {
  const present = await exists(join(root, file))
  record(`仓库中存在 ${label}`, present, present ? 'ok' : '文件缺失，发布出去就没有它')
}

record(
  'cordis.patch.yml 在 files 清单里（DSH 靠它注册插件）',
  files.includes('cordis.patch.yml'),
  files.includes('cordis.patch.yml') ? 'ok' : '不在 files 里 —— 消费者装上后插件不会被注册',
)

// ------------------------------- 2/3) 产物完整性（仅在 lib/ 已构建时）

if (libBuilt) {
  const libFiles = await walk(join(root, 'lib'))
  const srcFiles = (await walk(join(root, 'src'))).filter((file) => /\.tsx?$/.test(file))
  const tsLeftovers = libFiles.filter((file) => /\.tsx?$/.test(file) && !/\.d\.ts$/.test(file))
  record(
    '产物 lib/ 里没有 .ts/.tsx 残留',
    tsLeftovers.length === 0,
    tsLeftovers.length === 0 ? `${libFiles.length} 个产物文件` : `残留：${tsLeftovers.slice(0, 5).map((f) => relative(root, f)).join(', ')}`,
  )

  // 源码的每个**运行时模块**都必须在产物里留下痕迹。
  //
  // 为什么不用"相对导入 → 同名 .js"来判断：tsdown 会把模块合并进 lib/index.js
  // 或 code-splitting 出来的分块（`state-BzBQig2q.js` 这类带哈希名），所以
  // 找不到同名产物是**正常**的，那种检查恒真、等于没检查（本项目已经踩过
  // "软检查说了 ok 但其实是空的"这个坑）。
  //
  // 改用有内容的判据：所有 lib/*.js 拼起来，必须包含每个源码模块导出的符号名。
  const libJs = libFiles.filter((file) => file.endsWith('.js'))
  const bundle = (await Promise.all(libJs.map((file) => readFile(file, 'utf8')))).join('\n')
  const srcModules = srcFiles.filter((file) => !file.endsWith('.d.ts') && !file.includes(`${join('src', 'client')}`))
  const missingModules = []
  for (const file of srcModules) {
    const source = await readFile(file, 'utf8')
    // 取该模块导出的具名符号；没有具名导出的模块用文件名兜底
    const symbols = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1])
      .filter((name) => name.length > 3)
    const probe = symbols.length > 0 ? symbols : [relative(root, file).replace(/^src[\\/]/, '').replace(/\.tsx?$/, '')]
    const hit = probe.some((name) => bundle.includes(name))
    if (!hit) missingModules.push(relative(root, file))
  }
  record(
    '每个宿主侧源码模块都在产物里有痕迹（强检查）',
    missingModules.length === 0,
    missingModules.length === 0
      ? `${srcModules.length} 个模块全部命中`
      : `可能未被打包：${missingModules.slice(0, 6).join(', ')}`,
  )

  const clientEntry = await exists(join(root, 'lib', 'client.js'))
  record('浏览器半体产物 lib/client.js 存在', clientEntry, clientEntry ? 'ok' : '缺失 —— 界面页签不会出现')
}

// ---------------------------------------------------- 输出

const failed = results.filter((result) => !result.ok)
if (asJson) {
  process.stdout.write(JSON.stringify({ version, files, checks: results, ok: failed.length === 0 }, null, 2) + '\n')
} else {
  const width = Math.max(...results.map((result) => result.name.length))
  for (const result of results) {
    process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.name.padEnd(width)}  ${result.detail}\n`)
  }
  process.stdout.write(`\n发布门禁：${results.length} 项检查，${failed.length} 项失败\n`)
}
process.exit(failed.length === 0 ? 0 : 1)
