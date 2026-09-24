#!/usr/bin/env node
/**
 * npm 发布护栏（发布语义门禁）。
 *
 * **发布是单向操作**：`npm publish` 之后版本永久存在，只能 `npm deprecate`，
 * 装过的人不会自动回退。所以"发之前该确认什么"必须由脚本回答，而不是靠记性。
 *
 * 检查项：
 *   1. **渠道判定**：预发布（带 `-rc.N` 后缀）只能进项目声明的非 latest 渠道；
 *      稳定版本才允许进 `latest`；
 *   2. **防 latest 倒退**：稳定发布前查 registry 的 `latest`，比现有更低就拒绝
 *      —— 把 latest 指向更旧的版本，是所有发布事故里最难查的一类；
 *   3. **首次发布识别**：registry 查不到该包时明确说明（首次发布属预期），
 *      并提醒 scope 归属（否则 publish 以 403 失败，而不是 404）；
 *   4. **产物指纹**：按 package.json 的 `files` 打包候选 tarball 并算 SHA-256
 *      —— 发布后消费者复验要核对的是同一串字节，而不是"看起来一样"。
 *
 * **刻意不调用 npm 命令**：一是本机 npm 的全局缓存在沙箱外，二是 Windows 上
 * 脚本化调用 `npm.cmd` 脆弱（EINVAL/EPERM）。registry 直接走 HTTPS，打包用
 * 纯 Node 实现，于是这个门禁在任何环境下都跑得动，也更容易在 CI 里用。
 *
 * **本脚本永不自动 publish**（除非显式 `--publish`，且要先通过全部检查）。
 *
 * 用法：
 *   node scripts/release.mjs                # 只做检查与指纹（默认，安全）
 *   node scripts/release.mjs --publish      # 检查全绿后真正发布（仍走 npm）
 *   node scripts/release.mjs --json
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const doPublish = args.has('--publish')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))

const name = pkg.name
const version = String(pkg.version)
const channel = compatibility.previewTag ?? 'next'
const prerelease = version.includes('-')
const registry = pkg.publishConfig?.registry ?? 'https://registry.npmjs.org/'

const results = []
const record = (label, ok, detail, { fatal = true } = {}) =>
  results.push({ label, ok: Boolean(ok), detail, fatal })

/* ------------------------------------------------------------------ *
 * registry 查询（HTTPS 直连，不经过 npm 命令）
 * ------------------------------------------------------------------ */

/** 取一个包的 registry 元数据；首次发布时返回 { exists: false }。 */
async function registryInfo(packageName) {
  const url = registry.replace(/\/?$/, '/') + packageName.replace('/', '%2f')
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (response.status === 404) return { exists: false, reachable: true, versions: [], latest: undefined }
    if (!response.ok) return { exists: false, reachable: false, error: `HTTP ${response.status}`, versions: [], latest: undefined }
    const body = await response.json()
    return {
      exists: true,
      reachable: true,
      versions: Object.keys(body.versions ?? {}),
      latest: body['dist-tags']?.latest,
      distTags: body['dist-tags'] ?? {},
    }
  } catch (error) {
    return {
      exists: false,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
      versions: [],
      latest: undefined,
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯 Node 打包（复刻 npm pack 的 `files` 语义，够用即止）
 * ------------------------------------------------------------------ */

/** 把相对路径规范成 POSIX 形式（tar 头要求 `/` 分隔）。 */
const posix = (value) => value.split(sep).join('/')

async function collectFiles() {
  const selections = Array.isArray(pkg.files) ? pkg.files : []
  const out = []
  const seen = new Set()
  const push = (absPath, tarPath) => {
    if (seen.has(tarPath)) return
    seen.add(tarPath)
    out.push({ absPath, tarPath })
  }
  // npm 总是包含这两个（package.json 必备，README 用于展示）
  push(join(root, 'package.json'), 'package/package.json')
  push(join(root, 'README.md'), 'package/README.md')
  if (await exists(join(root, 'LICENSE'))) push(join(root, 'LICENSE'), 'package/LICENSE')

  const walkInto = async (dir, tarPrefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const tarPath = `${tarPrefix}/${entry.name}`
      if (entry.isDirectory()) await walkInto(full, tarPath)
      else push(full, tarPath)
    }
  }

  for (const entry of selections) {
    const full = join(root, entry)
    if (!(await exists(full))) continue
    const info = await stat(full)
    if (info.isDirectory()) await walkInto(full, `package/${posix(entry)}`)
    else push(full, `package/${posix(entry)}`)
  }
  // 顺序稳定 → 同样的内容得到同样的 tarball（可复现）
  return out.sort((a, b) => (a.tarPath < b.tarPath ? -1 : a.tarPath > b.tarPath ? 1 : 0))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 写一个 ustar 头（512 字节）。 */
function tarHeader({ tarPath, size, mode = 0o644, mtime = 0 }) {
  const block = Buffer.alloc(512)
  const write = (value, offset, length) => {
    Buffer.from(value, 'utf8').copy(block, offset, 0, Math.min(length, Buffer.byteLength(value)))
  }
  if (Buffer.byteLength(tarPath) > 100) {
    throw new Error(`tar 路径超过 100 字节，需要 GNU longname 扩展（本打包器刻意不实现）：${tarPath}`)
  }
  write(tarPath, 0, 100)
  write(mode.toString(8).padStart(7, '0') + '\0', 100, 8)
  write('0000000\0', 108, 8)                              // uid
  write('0000000\0', 116, 8)                              // gid
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  write(Math.max(0, Math.floor(mtime / 1000)).toString(8).padStart(11, '0') + '\0', 136, 12)
  write('        ', 148, 8)                               // 校验和先填空格
  write('0', 156, 1)                                      // typeflag: regular file
  write('ustar\0', 257, 6)                                // magic
  write('00', 263, 2)                                     // version
  let sum = 0
  for (const byte of block) sum += byte
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return block
}

/** 按 `files` 语义打出候选 tarball，返回 { filename, bytes }。 */
async function packTarball() {
  const files = await collectFiles()
  const chunks = []
  for (const file of files) {
    const bytes = await readFile(file.absPath)
    const info = await stat(file.absPath)
    chunks.push(tarHeader({ tarPath: file.tarPath, size: bytes.length, mode: 0o644, mtime: info.mtimeMs }))
    chunks.push(bytes)
    const padding = (512 - (bytes.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))                          // 两个空块收尾
  const tarBuf = Buffer.concat(chunks)
  const gz = gzipSync(tarBuf, { level: 9 })
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const filename = `${unscoped}-${version}.tgz`
  const previewDir = join(root, '.git', 'pack-preview')
  await rm(previewDir, { recursive: true, force: true })
  await mkdir(previewDir, { recursive: true })
  await writeFile(join(previewDir, filename), gz)
  return { filename, bytes: gz, fileCount: files.length, unpacked: tarBuf.length }
}

/* ------------------------------------------------------------------ *
 * 1) 渠道判定
 * ------------------------------------------------------------------ */

record(
  '发布渠道判定',
  true,
  prerelease
    ? `预发布版 ${version} → 必须发到 "${channel}" 渠道（验证通过后再提升为 latest）`
    : `稳定版 ${version} → 允许进 latest`,
  { fatal: false },
)

/* ------------------------------------------------------------------ *
 * 2) registry 现状 + 3) 防 latest 倒退
 * ------------------------------------------------------------------ */

const info = await registryInfo(name)
record(
  'registry 连通性与存在性',
  info.reachable,
  !info.reachable
    ? `无法访问 ${registry}（${info.error ?? '未知错误'}）—— 发布前需要能连上`
    : info.exists
      ? `已发布，共 ${info.versions.length} 个版本，latest=${info.latest}`
      : 'registry 上不存在该包 → 这是**首次发布**（属预期，不是错误）',
  { fatal: false },
)

if (!info.reachable) {
  record('registry 可达（发布前提）', false, `连不上 ${registry}，无法完成后续核对`)
}

const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
if (scope !== undefined) {
  record(
    'scope 归属提醒',
    true,
    `包名属于 ${scope} —— 你的 npm 账号必须拥有该 scope 的发布权，否则 publish 会以 403 失败（而不是 404）`,
    { fatal: false },
  )
}

const toNumbers = (value) => String(value).split('-')[0].split('.').map(Number)
const compare = (a, b) => {
  const left = toNumbers(a)
  const right = toNumbers(b)
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1
  }
  return 0
}
if (!prerelease) {
  const latest = info.latest
  if (latest === undefined) {
    record('latest 不会倒退', true, 'registry 上没有 latest（首次稳定发布）', { fatal: false })
  } else {
    const ok = compare(version, latest) >= 0
    record(
      'latest 不会倒退',
      ok,
      ok ? `${version} ≥ 现有 latest ${latest}` : `拒绝：${version} 低于现有 latest ${latest} —— 会把用户带到更旧的版本`,
    )
  }
} else {
  record('latest 不会倒退', true, `预发布版不进 latest，本项不适用（渠道：${channel}）`, { fatal: false })
}

/* ------------------------------------------------------------------ *
 * 4) 产物指纹
 * ------------------------------------------------------------------ */

let fingerprint
try {
  fingerprint = await packTarball()
  const sha256 = createHash('sha256').update(fingerprint.bytes).digest('hex')
  const sha1 = createHash('sha1').update(fingerprint.bytes).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(fingerprint.bytes).digest('base64')
  record(
    '候选产物已打包',
    true,
    `${fingerprint.filename}：${fingerprint.fileCount} 个文件，${fingerprint.bytes.length} B 打包 / ${fingerprint.unpacked} B 解包`,
    { fatal: false },
  )
  record(
    '打包器说明',
    true,
    '本指纹由 scripts/release.mjs 内置的 ustar 打包器生成（复刻 `files` 语义）；npm 的 include/exclude 细节可能有差异，'
    + '因此它是**候选预览**，不是 npm 的逐字节复现 —— 最终以 registry 上报的 integrity 为准',
    { fatal: false },
  )
  record('候选 tarball SHA-256', true, sha256, { fatal: false })
  record('候选 tarball SHA-1（对照 npm shasum）', true, sha1, { fatal: false })
  record('候选 tarball integrity', true, integrity, { fatal: false })
} catch (error) {
  record('候选产物已打包', false, `打包失败：${error instanceof Error ? error.message : String(error)}`)
}

/* ------------------------------------------------------------------ *
 * 5) 发布后复验指引
 * ------------------------------------------------------------------ */

const tag = prerelease ? channel : 'latest'
record(
  '发布后的消费者复验（做完才算真的发布成功）',
  true,
  [
    `npm view ${name}@${version} dist.integrity dist.tarball`,
    `npm view ${name} dist-tags.${tag}`,
    `dsh plugin --profile roundtable-verify add --save-exact ${name}@${version}`,
    '核对 registry 上报的 integrity 与上面那串是否一致（同一份字节）',
  ].join('   |   '),
  { fatal: false },
)

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

const fatalFailures = results.filter((result) => !result.ok && result.fatal)

if (asJson) {
  process.stdout.write(JSON.stringify({ name, version, channel: tag, checks: results, ok: fatalFailures.length === 0 }, null, 2) + '\n')
} else {
  const width = Math.max(...results.map((result) => result.label.length))
  process.stdout.write(`\n发布目标：${name}@${version}  →  渠道 ${tag}\n\n`)
  for (const result of results) {
    process.stdout.write(`${result.ok ? '✓' : '✗'} ${result.label.padEnd(width)}  ${result.detail}\n`)
  }
  process.stdout.write(`\n${results.length} 项检查，${fatalFailures.length} 项阻断发布\n`)
  if (fingerprint !== undefined) {
    process.stdout.write(`\n候选产物：${join('.git', 'pack-preview', fingerprint.filename)}\n`)
  }
}

if (fatalFailures.length > 0) {
  process.stdout.write('\n存在阻断项，未执行发布。\n')
  process.exit(1)
}

if (doPublish) {
  process.stdout.write(`\n检查全绿，开始发布（tag=${tag}，access=public）…\n`)
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync('npm', ['publish', '--tag', tag, '--access', 'public'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, npm_config_cache: join(root, '.git', 'npm-cache') },
  })
  process.exit(result.status ?? 1)
}

process.stdout.write('\n检查全绿。确认无误后由你执行发布：\n')
process.stdout.write(`  npm publish --tag ${tag} --access public\n`)
process.stdout.write('（本脚本不会自动发布；加 --publish 才会真正推上去。）\n')
