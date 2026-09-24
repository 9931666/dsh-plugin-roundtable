#!/usr/bin/env node
/**
 * node_modules 链接修复器（一次性修复工具，不是常规流程的一部分）。
 *
 * **为什么存在**：本项目在受限环境里 `pnpm install` 会在写链接阶段中断
 * （网络重试 + store 数据库问题），结果是 `.pnpm/` 里包都在，但顶层
 * `node_modules/`、各包自己的 `node_modules/`、`.bin/` 的接线不完整 ——
 * 表现为 `ERR_MODULE_NOT_FOUND`（缺 `@rolldown/pluginutils`、`@quansync/fs`…）
 * 或 `Cannot find module '@rolldown/binding-*'`（原生绑定没链）。
 *
 * 这个脚本**只读 `.pnpm`**，把缺的链接补上。它不下载任何东西、不改版本、
 * 不碰 package.json —— 因此在能正常 `pnpm install` 的机器上完全不需要它。
 *
 * 用法：
 *   node scripts/repair-links.mjs            # 修复并报告
 *   node scripts/repair-links.mjs --dry-run  # 只报告缺什么
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const nm = join(root, 'node_modules')
const pnpmDir = join(nm, '.pnpm')
const dryRun = process.argv.includes('--dry-run')

if (!existsSync(pnpmDir)) {
  process.stdout.write(`未找到 ${pnpmDir}：请先运行一次 pnpm install。\n`)
  process.exit(1)
}

/** 一个链接是否「有效」（存在且不是坏链接）。 */
function linkOk(path) {
  try {
    return existsSync(realpathSync(path))
  } catch {
    return false
  }
}

/** 建链接（Windows 用 junction，其它平台用 dir）。 */
function link(from, to) {
  if (dryRun) return false
  try {
    const parent = dirname(to)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/** 扫 `.pnpm`，建立「包名 → 真实目录」索引。 */
const index = new Map()
for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const inner = join(pnpmDir, entry.name, 'node_modules')
  if (!existsSync(inner)) continue
  const scan = (dir, prefix = '') => {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, child.name)
      if (!child.isDirectory() && !lstatSync(full).isSymbolicLink()) continue
      if (child.name.startsWith('@')) {
        scan(full, `${child.name}/`)
        continue
      }
      const name = `${prefix}${child.name}`
      if (!index.has(name)) index.set(name, full)
    }
  }
  scan(inner)
}
process.stdout.write(`.pnpm 索引：${index.size} 个包\n`)

/** 把 specifier 收敛成包名。 */
function packageNameOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) return undefined
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 从一份文件里抠出所有裸导入的包名。 */
function bareImports(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const names = new Set()
  const patterns = [
    /(?:^|[\s;{(])import\s*\(\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])import\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = packageNameOf(match[1])
      if (name !== undefined) names.add(name)
    }
  }
  // package.json 的依赖声明也算（原生绑定在 optionalDependencies 里，代码里 import 不到）
  const pkgPath = join(dirname(file), 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[field] ?? {})) names.add(name)
      }
    } catch {
      // 读不出来就跳过
    }
  }
  return [...names]
}

/** 候选入口文件：dist/lib/index.mjs 优先。
 *
 *  **只收 `.mjs` / `.cjs`**：`.js` 在 Node+ESM 下必须靠 package.json 的 `type`
 *  才判定，而且 `typescript/lib/tsc.js` 那种巨型 CJS 文件里满是"看着像 import"
 *  的代码片段，正则扫它会产出大量假依赖（实测能刷出几十条噪音）。原生绑定那类
 *  不写 import 的依赖由 `package.json` 的字段兜住。 */
function entryFiles(pkgDir) {
  const out = []
  const pkgJson = join(pkgDir, 'package.json')
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
      for (const field of [pkg.module, pkg.exports?.['.']?.import?.default]) {
        if (typeof field === 'string' && /\.(mjs|cjs)$/.test(field)) out.push(join(pkgDir, field))
      }
    } catch {
      // 忽略
    }
  }
  for (const candidate of ['dist/index.mjs', 'dist/index.cjs', 'lib/index.mjs', 'index.mjs']) {
    out.push(join(pkgDir, candidate))
  }
  return out.filter((file) => existsSync(file))
}

let fixedTotal = 0
for (let round = 1; round <= 4; round += 1) {
  let fixedThisRound = 0
  for (const [name, dir] of index) {
    const entries = entryFiles(dir)
    if (entries.length === 0) continue
    const deps = new Set()
    for (const file of entries.slice(0, 3)) {
      for (const dep of bareImports(file)) {
        if (dep !== name) deps.add(dep)
      }
    }
    for (const dep of deps) {
      if (linkOk(join(dir, 'node_modules', dep))) continue
      const target = index.get(dep)
      if (target === undefined) {
        if (!dryRun && round === 1) process.stdout.write(`  ? 无法解析：${name} 需要 ${dep}\n`)
        continue
      }
      if (link(target, join(dir, 'node_modules', dep))) {
        fixedThisRound += 1
        if (!dryRun) process.stdout.write(`  ✓ ${name} → ${dep}\n`)
      }
    }
  }
  fixedTotal += fixedThisRound
  if (fixedThisRound === 0) break
}

// .bin：tsc / tsdown
const binDir = join(nm, '.bin')
if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true })
const shims = [
  ['tsc.cmd', '@echo off\r\nnode "%~dp0..\\typescript\\bin\\tsc" %*\r\n'],
  ['tsdown.cmd', '@echo off\r\nnode "%~dp0..\\tsdown\\dist\\run.mjs" %*\r\n'],
]
if (!dryRun) {
  for (const [file, content] of shims) {
    const full = join(binDir, file)
    if (!existsSync(full)) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(full, content)
      process.stdout.write(`  ✓ .bin/${file}\n`)
    }
  }
}

process.stdout.write(`\n${dryRun ? '（dry-run）' : ''}补齐链接：${fixedTotal} 条\n`)
