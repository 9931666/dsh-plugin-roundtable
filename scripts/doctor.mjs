#!/usr/bin/env node
/**
 * 只读安装诊断（doctor）。
 *
 * **它要回答的问题**：用户说"界面调不出来"时，到底是哪一层坏了？在此之前
 * 只能靠猜或让对方贴日志，而这个插件历史上最严重的两次事故（`inject` 加载
 * 门禁、cordis 混装导致声明合并失效）都是**静默**的——没有报错，只是不工作。
 *
 * 因此 doctor 只做三件事，且**绝不执行插件、绝不修改任何配置**：
 *   1. 报告宿主与插件的精确版本、安装位置；
 *   2. 探测**混装**：插件依赖树里同一族包出现多个版本，或插件与宿主解析到
 *      不同实例的 cordis —— 后者会让 Context 声明合并失效，表现为一大片
 *      "Property 'subagents' does not exist on type 'Context'"；
 *   3. 打印插件的宿主能力清单（来自 `src/harness-compat.ts` 的 CAPABILITY_SPECS），
 *      让"宿主支持什么"在一个命令里可见。
 *
 * **它的成功不代表插件能用**：doctor 通过 ≠ 会议能开起来。它只排除安装层故障。
 *
 * 用法：
 *   node scripts/doctor.mjs                                   # 自动探测宿主
 *   node scripts/doctor.mjs --host-root "<dsh 包目录>" --profile-root "<profile 目录>"
 *   node scripts/doctor.mjs --json
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined
}
const asJson = args.includes('--json')
const hostRootArg = valueOf('--host-root')
const profileRootArg = valueOf('--profile-root')

const report = {
  node: process.version,
  pluginRoot: root,
  pluginVersion: undefined,
  hostRoot: undefined,
  hostVersion: undefined,
  profileRoot: profileRootArg ?? undefined,
  installedPluginVersion: undefined,
  mixedCohorts: [],
  cordisIdentity: undefined,
  capabilitySpecs: [],
  notes: [],
}

const load = async (path) => JSON.parse(await readFile(path, 'utf8'))

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

try {
  report.pluginVersion = (await load(join(root, 'package.json'))).version
} catch {
  report.notes.push('无法读取本仓库 package.json')
}

/** 从宿主的 node_modules 里探测 @deepseek-ai/* 的版本分布。 */
async function scanScope(modulesDir, label) {
  const scopeDir = join(modulesDir, '@deepseek-ai')
  const versions = new Map()
  let entries
  try {
    entries = await readdir(scopeDir, { withFileTypes: true })
  } catch {
    return versions
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const pkgPath = join(scopeDir, entry.name, 'package.json')
    if (!(await exists(pkgPath))) continue
    try {
      const pkg = await load(pkgPath)
      const list = versions.get(pkg.name) ?? new Set()
      list.add(pkg.version)
      versions.set(pkg.name, list)
    } catch {
      // 单个包读不出来不影响整体诊断
    }
  }
  for (const [name, list] of versions) {
    if (list.size > 1) {
      report.mixedCohorts.push({ where: label, package: name, versions: [...list] })
    }
  }
  return versions
}

// ---------------------------------------------- 宿主定位

let hostRoot = hostRootArg === undefined ? undefined : resolve(hostRootArg)
if (hostRoot === undefined) {
  // 自动探测：本机 DSH 常装在 npx 缓存里；只做只读扫描。
  const candidates = []
  const npxCache = process.env.RT_NPX_CACHE ?? 'F:\\AI\\npm-cache\\_npx'
  try {
    for (const entry of await readdir(npxCache, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgPath = join(npxCache, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      if (await exists(pkgPath)) candidates.push(dirname(pkgPath))
    }
  } catch {
    // 探测失败：提示用户显式传 --host-root
  }
  if (candidates.length === 1) hostRoot = candidates[0]
  else if (candidates.length > 1) report.notes.push(`发现 ${candidates.length} 个宿主安装，请用 --host-root 指定：${candidates.join(' | ')}`)
  else report.notes.push('未自动找到宿主，请用 --host-root "<dsh 包目录>" 指定')
}

if (hostRoot !== undefined) {
  report.hostRoot = hostRoot
  try {
    report.hostVersion = (await load(join(hostRoot, 'package.json'))).version
  } catch {
    report.notes.push(`宿主目录读不到 package.json：${hostRoot}`)
  }
}

// ---------------------------------------------- 混装探测

// hostRoot 形如 …/node_modules/@deepseek-ai/dsh → 上两级就是宿主 node_modules
if (hostRoot !== undefined) {
  const hostNodeModules = dirname(dirname(hostRoot))
  await scanScope(hostNodeModules, 'host')
}
await scanScope(join(root, 'node_modules'), 'plugin')

// ---------------------------------------------- cordis 实例同一性

if (hostRoot !== undefined) {
  const hostCordis = join(dirname(dirname(hostRoot)), '@deepseek-ai', 'cordis', 'package.json')
  const pluginCordis = join(root, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')
  try {
    const { realpath } = await import('node:fs/promises')
    const hostReal = await realpath(hostCordis)
    const pluginReal = await realpath(pluginCordis)
    report.cordisIdentity = {
      same: hostReal === pluginReal,
      host: hostReal,
      plugin: pluginReal,
    }
    if (hostReal !== pluginReal) {
      report.notes.push(
        'cordis 不是同一个物理副本：TypeScript 会把它当作两个模块，Context 声明合并失效，'
        + '表现为编译期大片 "Property \'subagents\' does not exist on type \'Context\'"。'
        + '把插件 node_modules 的 @deepseek-ai/cordis 指向宿主那一份即可。',
      )
    }
  } catch {
    report.notes.push('无法比对 cordis 实例（缺少其中一个副本）')
  }
}

// ---------------------------------------------- 已安装插件版本

if (report.profileRoot !== undefined) {
  const installed = join(resolve(report.profileRoot), 'node_modules', '@huanlin', 'dsh-plugin-roundtable', 'package.json')
  try {
    report.installedPluginVersion = (await load(installed)).version
  } catch {
    report.notes.push(`profile 里没有安装本插件：${installed}`)
  }
}

// ---------------------------------------------- 能力清单（读源码侧单一来源）

try {
  const mod = await import(pathToFileURL(join(root, 'src', 'harness-compat.ts')).href)
  report.capabilitySpecs = mod.CAPABILITY_SPECS.map((spec) => ({
    id: spec.id,
    kind: spec.kind,
    purpose: spec.purpose,
    whenMissing: spec.whenMissing,
  }))
  report.notes.push('能力清单读取自 src/harness-compat.ts（未执行插件）')
} catch (error) {
  report.notes.push(`无法读取能力清单：${error instanceof Error ? error.message : String(error)}`)
}

// ---------------------------------------------- 输出

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  const line = (label, value) => process.stdout.write(`${label.padEnd(22)} ${value}\n`)
  process.stdout.write('\n=== RoundTable 只读安装诊断 ===\n\n')
  line('Node', report.node)
  line('插件仓库', report.pluginRoot)
  line('插件版本', report.pluginVersion ?? '（读不到）')
  line('宿主版本', report.hostVersion ?? '（未定位）')
  line('宿主目录', report.hostRoot ?? '（未定位，用 --host-root 指定）')
  line('profile 版本', report.installedPluginVersion ?? '（未指定 --profile-root 或未安装）')

  process.stdout.write('\n--- 混装检查 ---\n')
  if (report.mixedCohorts.length === 0) {
    process.stdout.write('✓ 同一族包没有出现多个版本\n')
  } else {
    for (const item of report.mixedCohorts) {
      process.stdout.write(`✗ [${item.where}] ${item.package} 出现多个版本：${item.versions.join(', ')}\n`)
    }
  }

  process.stdout.write('\n--- cordis 实例同一性 ---\n')
  if (report.cordisIdentity === undefined) {
    process.stdout.write('· 未比对（缺宿主路径）\n')
  } else if (report.cordisIdentity.same) {
    process.stdout.write('✓ 宿主与插件解析到同一个 cordis 副本\n')
  } else {
    process.stdout.write('✗ 两者是不同副本 —— 声明合并会失效\n')
  }

  process.stdout.write('\n--- 宿主能力探测点（来自 harness-compat）---\n')
  for (const spec of report.capabilitySpecs) {
    process.stdout.write(`${spec.kind === 'required' ? '必需' : '可选'}  ${spec.id.padEnd(20)} ${spec.purpose}\n`)
  }

  if (report.notes.length > 0) {
    process.stdout.write('\n--- 说明 ---\n')
    for (const note of report.notes) process.stdout.write(`· ${note}\n`)
  }
  process.stdout.write('\n> 本诊断只读，不执行插件、不修改配置。通过 ≠ 插件能用，只排除安装层故障。\n')
}
