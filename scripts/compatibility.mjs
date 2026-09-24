#!/usr/bin/env node
/**
 * 宿主支持矩阵的唯一校验器。
 *
 * **设计原则（借鉴社区项目 dsh-agent-teams 的 scripts/compatibility.mjs）**：
 * 「支持哪些宿主」只能有一处真话。本脚本把散落在四个地方、必须彼此一致的
 * 声明全部对齐，不一致就直接失败：
 *
 *   1. `compatibility.json`                   —— 矩阵与能力清单的唯一来源
 *   2. `package.json` 的 devDependencies      —— **类型基线**（决定消费者
 *      `npm install` 后拿到哪一版类型）
 *   3. `package.json` 的 peerDependencies     —— 允许的宿主区间
 *   4. `src/harness-compat.ts` 的能力清单     —— 代码实际探测了什么
 *
 * 任何一个漂移都会在生产里表现为「本机好好的、用户装完就坏」，而那种故障最
 * 难查。所以宁可在这里大声失败。
 *
 * 用法：
 *   node scripts/compatibility.mjs            # 文本报告，失败退出码 1
 *   node scripts/compatibility.mjs --json     # 机器可读
 *   node scripts/compatibility.mjs --github-output   # 写 CI matrix 到 $GITHUB_OUTPUT
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const githubOutput = args.has('--github-output')

/** 一条校验结果。 */
function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail }
}

/** 解析 `1.2.3-rc.4` 这类版本号（故意不支持 build metadata，我们不用到）。 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value).trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(a, b) {
  // 无 prerelease 的版本大于有 prerelease 的（1.0.0 > 1.0.0-rc.1）
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * 判定 `range` 是否覆盖 `target`。
 *
 * **刻意只实现 `^`**，其余形式一旦出现就报错退出而不是猜：这个脚本是发布
 * 门禁，静默猜错比直接失败危险得多。要支持新区间写法时，请连同单测一起加。
 *
 * npm 语义：`^0.1.5-rc.1` 覆盖同 `major.minor.patch` 的更高 prerelease
 * （rc.2、rc.3）与该版本的正式版（0.1.5），但**不覆盖** 0.1.6 —— prerelease
 * 只在同一 base version 内被接受。
 */
function rangeCovers(range, target) {
  const trimmed = String(range).trim()
  if (!trimmed.startsWith('^')) return { ok: false, reason: `unsupported range form: ${trimmed}` }
  const wanted = parseVersion(trimmed.slice(1))
  if (wanted === undefined) return { ok: false, reason: `unparseable range: ${trimmed}` }
  if (compareVersion(wanted, target) > 0) return { ok: false, reason: `${target.major}.${target.minor}.${target.patch} is below ${trimmed}` }
  if (target.major !== wanted.major || target.minor !== wanted.minor) {
    return { ok: false, reason: `${target.major}.${target.minor} is outside the ${wanted.major}.${wanted.minor} line` }
  }
  if (target.patch !== wanted.patch) {
    return { ok: false, reason: `patch ${target.patch} differs from ${wanted.patch}` }
  }
  return { ok: true, reason: '' }
}

const errors = []
const results = []

function record(result) {
  results.push(result)
  if (!result.ok) errors.push(result)
}

// ---------------------------------------------------------------- 读取

const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compatSource = await readFile(join(root, 'src', 'harness-compat.ts'), 'utf8')
const indexSource = await readFile(join(root, 'src', 'index.ts'), 'utf8')

const recommendedRaw = compatibility.recommendedHost
const recommended = parseVersion(recommendedRaw)

record(check(
  'compatibility.recommendedHost 可解析',
  recommended !== undefined,
  recommended === undefined ? `无法解析版本号：${recommendedRaw}` : `${recommendedRaw} ok`,
))

/** 从一个 TS 源码里抠出 `export const NAME = [ 'a', 'b' ] as const` 的字符串项。 */
function stringArrayFrom(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(source)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
}

const sourceRequired = stringArrayFrom(compatSource, 'REQUIRED_CAPABILITIES')
const sourceOptional = stringArrayFrom(compatSource, 'OPTIONAL_CAPABILITIES')
const declaredInject = stringArrayFrom(indexSource, 'inject')

// ------------------------------------------------- 1) 基线字段与矩阵一致

const baselineVersion = pkg.roundtable?.hostBaseline
record(check(
  'package.json 声明了宿主基线（roundtable.hostBaseline）',
  typeof baselineVersion === 'string' && baselineVersion !== '',
  baselineVersion === undefined ? '缺失：无法判断类型基线指向哪个宿主' : baselineVersion,
))
record(check(
  'package.json 基线 == compatibility.json 的 recommendedHost',
  baselineVersion === recommendedRaw,
  `package.json=${baselineVersion} compatibility.json=${recommendedRaw}`,
))

// --------------------------------------------- 2) devDependencies 精确一致

const baselinePackages = compatibility.baseline?.packages ?? []
record(check(
  'compatibility.json 声明了基线包清单',
  Array.isArray(baselinePackages) && baselinePackages.length > 0,
  `${baselinePackages.length} 个包`,
))

for (const name of baselinePackages) {
  const dev = pkg.devDependencies?.[name]
  record(check(
    `devDependencies 精确指向基线：${name}`,
    dev === recommendedRaw,
    dev === undefined ? '未声明' : `实际 ${dev}（应为 ${recommendedRaw}）`,
  ))
}

// ------------------------------------------------ 3) peer 区间覆盖基线

for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/dsh')) continue
  if (recommended === undefined) break
  const verdict = rangeCovers(range, recommended)
  record(check(
    `peerDependencies 覆盖基线：${name}`,
    verdict.ok,
    verdict.ok ? `${range} ⊇ ${recommendedRaw}` : `${range} 不覆盖 ${recommendedRaw}：${verdict.reason}`,
  ))
}

// ---------------------------------- 4) 三处能力清单（代码 / 矩阵 / inject）

record(check(
  'harness-compat 的必需能力清单与 compatibility.json 一致',
  JSON.stringify(sourceRequired) === JSON.stringify(compatibility.capabilities?.required),
  `源码=${JSON.stringify(sourceRequired)} 矩阵=${JSON.stringify(compatibility.capabilities?.required)}`,
))
record(check(
  'harness-compat 的可选能力清单与 compatibility.json 一致',
  JSON.stringify(sourceOptional) === JSON.stringify(compatibility.capabilities?.optional),
  `源码=${JSON.stringify(sourceOptional)} 矩阵=${JSON.stringify(compatibility.capabilities?.optional)}`,
))
record(check(
  'index.ts 的 inject 与必需能力清单一致',
  JSON.stringify(declaredInject) === JSON.stringify(compatibility.capabilities?.required),
  `inject=${JSON.stringify(declaredInject)} 必需=${JSON.stringify(compatibility.capabilities?.required)}`,
))

// ---------------------------------------- 5) 每个探测点都在 CAPABILITY_SPECS

const specIds = [...compatSource.matchAll(/^\s{2}\{\s*\n\s*id:\s*'([^']+)'/gm)].map((m) => m[1])
const declaredCapabilities = [
  ...(compatibility.capabilities?.required ?? []),
  ...(compatibility.capabilities?.optional ?? []),
]
const undocumented = declaredCapabilities.filter((id) => !specIds.includes(id))
const extraSpecs = specIds.filter((id) => !declaredCapabilities.includes(id))
record(check(
  '每个被声明的能力都在 CAPABILITY_SPECS 里登记了探测点',
  undocumented.length === 0,
  undocumented.length === 0 ? `${specIds.length} 个探测点` : `缺登记：${undocumented.join(', ')}`,
))
record(check(
  'CAPABILITY_SPECS 里没有未声明的多余探测点',
  extraSpecs.length === 0,
  extraSpecs.length === 0 ? 'ok' : `多余：${extraSpecs.join(', ')}`,
))

// ---------------------------------------------------------------- 输出

if (githubOutput) {
  const matrix = (compatibility.supportedHosts ?? [])
    .filter((host) => typeof host.version === 'string')
    .map((host) => ({ version: host.version, track: host.track ?? 'unsupported' }))
  const line = `hosts=${JSON.stringify(matrix)}\nrecommended=${recommendedRaw}\n`
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(process.env.GITHUB_OUTPUT, line, 'utf8')
  } else {
    process.stdout.write(line)
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({
    recommendedHost: recommendedRaw,
    supportedHosts: compatibility.supportedHosts ?? [],
    checks: results,
    ok: errors.length === 0,
  }, null, 2) + '\n')
} else {
  const width = Math.max(...results.map((result) => result.name.length))
  for (const result of results) {
    process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.name.padEnd(width)}  ${result.detail}\n`)
  }
  process.stdout.write(`\n宿主基线 ${recommendedRaw}；${results.length} 项检查，${errors.length} 项失败\n`)
}

process.exit(errors.length === 0 ? 0 : 1)
