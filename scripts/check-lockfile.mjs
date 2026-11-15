#!/usr/bin/env node
/**
 * 发布门禁：pnpm-lock.yaml 是否与 package.json 一致。
 *
 * ## 为什么需要它
 *
 * `.github/workflows/publish.yml` 用 `pnpm install --frozen-lockfile` 重建产物。
 * 只要 lock 与 package.json 的 specifier 不匹配，这一步就直接
 * `ERR_PNPM_OUTDATED_LOCKFILE` —— **整个发布通道是死的**，而且本地四道门禁
 * （compatibility / verify-package / release / test）一个都不会报。
 *
 * 这个仓库就发生过：lock 停在 `0.1.5-rc.3` 时代、还残留已经删掉的
 * `@deepseek-ai/dsh-settings`，而 package.json 已经走到 `0.2.2-rc.1`。
 *
 * ## 判据（只读、不联网）
 *
 * 1. `pnpm-lock.yaml` 存在；
 * 2. lock 的 `importers."."` 里，每个来自 package.json `devDependencies`
 *    的 `@deepseek-ai/*` 包，其 `specifier` 与 package.json 声明**逐字相同**；
 * 3. lock 里不得残留 package.json 已不存在的 `@deepseek-ai/*` 依赖
 *    （残留说明从未重新解析过）。
 *
 * 只比对 `@deepseek-ai/*`：工具链依赖（tsdown / typescript / react…）允许 caret，
 * 逐个比对没有意义，且它们不影响发布通道的成败判据（specifier 一致即可）。
 *
 * ## 修法
 *
 * 在**能正常访问 npm 的终端**里跑 `pnpm install`（不要加 `--frozen-lockfile`），
 * 把新的 `pnpm-lock.yaml` 提交。
 *
 * 用法：
 *   node scripts/check-lockfile.mjs            # 文本报告；不一致时 exit 1
 *   node scripts/check-lockfile.mjs --json
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const asJson = process.argv.includes('--json')

const problems = []
const notes = []

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

let raw = ''
try {
  await stat(join(root, 'pnpm-lock.yaml'))
  raw = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
} catch {
  problems.push('pnpm-lock.yaml 不存在 —— CI 的 pnpm install --frozen-lockfile 会直接失败')
}

/**
 * 读取 lock 顶部的 `importers."."` 段（pnpm v9 形状）：
 *   importers:
 *     .:
 *       dependencies: ...
 *       devDependencies:
 *         '@deepseek-ai/dsh-agent':
 *           specifier: 0.2.2-rc.1
 *           version: 0.2.2-rc.1(...)
 *
 * 只解析到下一个同级键为止，不做完整 YAML 解析（本文件只需要这一小段，
 * 引一个 YAML 库进来不值得）。
 */
function parseImporterDevDependencies(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^importers:\s*$/.test(line))
  if (start < 0) return undefined
  // importers.".": 形如 `  .:` 或 `  '.':`
  let dot = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{2}['"]?\.?['"]?:\s*$/.test(lines[i]) && /\./.test(lines[i])) {
      dot = i
      break
    }
    if (/^\S/.test(lines[i])) break
  }
  if (dot < 0) return undefined
  const declared = new Map()
  let section = undefined
  let current = undefined
  for (let i = dot + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s{2}\S/.test(line)) break // 下一个 importer
    const sectionMatch = /^\s{4}(\w+):\s*$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1]
      continue
    }
    if (section !== 'devDependencies' && section !== 'dependencies') continue
    const depMatch = /^\s{6}(['"]?)([^'":]+)\1:\s*$/.exec(line)
    if (depMatch !== null) {
      current = { name: depMatch[2].trim(), specifier: undefined }
      declared.set(current.name, current)
      continue
    }
    const specMatch = /^\s{8}specifier:\s*(.+?)\s*$/.exec(line)
    if (specMatch !== null && current !== undefined) current.specifier = specMatch[1].trim()
  }
  return declared
}

if (raw !== '') {
  const declared = parseImporterDevDependencies(raw)
  if (declared === undefined) {
    notes.push('无法解析 lock 里的 importers."." 段（格式可能变了），已跳过逐项比对')
  } else {
    const wanted = Object.entries(pkg.devDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
    for (const [name, wantedVersion] of wanted) {
      const entry = declared.get(name)
      if (entry === undefined) {
        problems.push(`${name}：lock 里没有这条依赖（package.json 要求 ${wantedVersion}）`)
        continue
      }
      if (entry.specifier !== wantedVersion) {
        problems.push(`${name}：lock specifier=${entry.specifier ?? '（缺）'}，package.json=${wantedVersion}`)
      }
    }
    const declaredDsh = [...declared.keys()].filter((name) => name.startsWith('@deepseek-ai/'))
    const wantedNames = new Set(wanted.map(([name]) => name))
    for (const name of declaredDsh) {
      if (!wantedNames.has(name)) problems.push(`${name}：lock 里残留了这个依赖，但 package.json 已经删掉`)
    }
  }
}

const ok = problems.length === 0
if (asJson) {
  process.stdout.write(JSON.stringify({ ok, problems, notes }, null, 2) + '\n')
} else {
  process.stdout.write('\npnpm-lock.yaml 一致性\n')
  if (ok) {
    process.stdout.write(`✓ lock 与 package.json 的 @deepseek-ai/* 依赖逐项一致\n`)
  } else {
    for (const problem of problems) process.stdout.write(`✗ ${problem}\n`)
    process.stdout.write('\n锁定文件不一致。修法：在能访问 npm 的终端里跑 `pnpm install`，提交新的 pnpm-lock.yaml。\n')
  }
  for (const note of notes) process.stdout.write(`… ${note}\n`)
  process.stdout.write(`${ok ? 0 : problems.length} 个问题\n`)
}
process.exit(ok ? 0 : 1)
