/**
 * 运行时偏好的持久化与净化（宿主设置模型重构后的自持久化实现）。
 *
 * ## 为什么不再是宿主的 settings 命名空间
 *
 * 0.1.5-rc.3 时代，宿主 `settings` 服务提供
 * `settings.register(ns, schema, { base })`，返回一个 `SettingsScope`，自带
 * `get()` / `update()` / `watch()` —— 插件因此可以把「运行时可改、改完立即
 * 生效」的偏好寄存在宿主的 `settings.yaml` 里。
 *
 * 0.2.0-rc.2 把该服务重构为 `SettingsForms`：它把 **profile 配置投影成表单**
 * （`configure` / `describe` / `update` / `replace` / `mutate`），插件不再有
 * 「注册自己的命名空间」这个动作，`SettingsScope` 类型也随之消失。新模型里
 * 插件的可配置面是它自己的 Cordis `Config`，而写 Config 会触发 Loader 重载
 * 该 entry —— 对「改一个偏好就重启整场会议」来说太重了。
 *
 * 因此本插件改为自持久化：偏好落在 DSH home 下的
 * `roundtable/preferences.json`，读写都在插件内部完成，不再依赖宿主设置服务，
 * 也就不会因为该服务的下一次重构而再次失效。
 *
 * ## 三条铁律（与 state.ts 同源）
 *
 * 1. **读失败绝不抛给调用方**：偏好文件损坏或被手改成非法 JSON，一律退回默认
 *    值并留一条日志。偏好是观察性配置，它不能让整场会议从界面上消失。
 * 2. **写入必须原子**：复用 {@link writeTextAtomic}（宿主 `writeFileAtomic`
 *    优先、本地 tmp+rename 兜底），避免半截 JSON 落盘。
 * 3. **非法字段一律净化**：schemastery 不校验数组条目的 required 字段，
 *    条目级校验只能手写 —— 与既有净化契约一致。
 *
 * @module dsh-plugin-roundtable/preferences
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RolePreset, RoleSquad, RoleSquadMember } from './types.ts'
import { writeTextAtomic } from './state.ts'

/* ------------------------------------------------------------------ *
 * 0. 偏好文件位置
 * ------------------------------------------------------------------ */

/**
 * 解析 DeepSeek Harness home。
 *
 * 与宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 优先级对齐：
 * `configured` > `$DSH_HOME` > `~/.dsh`。只有第一级做不到 —— 它是宿主进程内部
 * 传入的显式覆盖，插件拿不到 —— 但环境变量与默认值这两级完全一致，因此在
 * 任何正常启动的宿主里都会落到同一个目录。
 *
 * 刻意**不**静态 import `@deepseek-ai/dsh-home-paths`：那会把它变成加载门禁，
 * 而本模块只是要一个路径（见 harness-compat 的铁律 #1）。
 */
export function dshHomeDir(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 偏好文件的绝对路径（DSH home 下的 `roundtable/preferences.json`）。 */
export function preferencesFilePath(): string {
  return join(dshHomeDir(), 'roundtable', 'preferences.json')
}

/* ------------------------------------------------------------------ *
 * 1. 偏好形状
 * ------------------------------------------------------------------ */

/** Wire shape of the runtime preferences. */
export interface RoundTablePreferences {
  readonly defaultMode: 'orchestrated' | 'egalitarian' | 'redteam'
  readonly maxRounds: number
  readonly maxTokens: number
  /** 互通开关：true = 显示所有圆桌会议；false = 仅显示当前对话开启的会议。 */
  readonly showAllMeetings: boolean
  /** 专家每轮输出 token 上限（模型请求 max_tokens），0 = 不限制。 */
  readonly expertMaxTokens: number
  /** 专家每轮最多提几条意见，0 = 不限制。 */
  readonly expertMaxOpinions: number
  /** E1/E4 反馈：会议结束后是否询问轻量反馈；false = 永久关闭（设置页可改）。 */
  readonly feedbackEnabled: boolean
  /** R2.2/D5：skill 传递方式（relay=主持人中转；direct=专家自行调用）。 */
  readonly skillDelivery: 'relay' | 'direct'
  /** 右栏面板可见性（R3）：被列出的面板在拓扑页隐藏；空 = 全部显示。 */
  readonly hiddenPanels: string[]
  /** A1：画布图例是否已被用户关闭（默认 false = 显示）。 */
  readonly legendHidden: boolean
  /** B3：用户自建角色预设（全局偏好；不预置任何内置角色）。 */
  readonly rolePresets: RolePreset[]
  /** B3+：用户自建阵容预设（一次套用多位专家；同样不预置）。 */
  readonly squads: RoleSquad[]
}

/** 没有任何持久化数据时的偏好。`defaultMode` 由调用方按插件 Config 覆盖。 */
export function defaultPreferences(defaultMode: RoundTablePreferences['defaultMode']): RoundTablePreferences {
  return {
    defaultMode,
    maxRounds: 10,
    maxTokens: 200_000,
    showAllMeetings: true,
    expertMaxTokens: 0,
    expertMaxOpinions: 0,
    feedbackEnabled: true,
    skillDelivery: 'relay',
    hiddenPanels: [],
    legendHidden: false,
    rolePresets: [],
    squads: [],
  }
}

/* ------------------------------------------------------------------ *
 * 2. 字段级净化（schemastery 不替我们拦条目级错误）
 * ------------------------------------------------------------------ */

/** 右栏可隐藏的面板 id（客户端与服务端共用的稳定标识）。 */
export const ROUNDTABLE_PANELS: readonly string[] = [
  'agents',
  'tasks',
  'kb',
  'skills',
  'activity',
  'review',
  'files',
]

/** 把任意输入收敛成合法的隐藏面板清单（未知 id 丢弃，去重）。 */
export function sanitizeHiddenPanels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (id === '' || !ROUNDTABLE_PANELS.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** 预设条目的硬上限（客户端与服务端共用；服务端截断，客户端提前拦截）。 */
export const ROLE_PRESET_MAX = 50
const ROLE_PRESET_ID_MAX = 64
const ROLE_PRESET_NAME_MAX = 40
const ROLE_PRESET_ROLE_MAX = 400

/**
 * 把任意输入收敛成合法的角色预设清单（B3）。
 *
 * schemastery 的 `z.object` 在 resolve 阶段**不校验缺失的 required 字段**
 * （`s({ rolePresets: [{ id: 'a' }] })` 直接通过），所以条目级校验不能依赖
 * schema，必须在这里手写 —— 与 {@link sanitizeHiddenPanels} 同一套路：
 *   - `name` 与 `role` 非空是硬要求，二者缺一即丢弃该条；
 *   - `id` 为空或与前面的条目重复时**重新分配**（保数据，不静默丢条目）；
 *   - `provider`/`model` 必须成对出现，否则整体视为"继承主持人"；
 *   - 单字段超长截断，总条数超 {@link ROLE_PRESET_MAX} 截断。
 */
export function sanitizeRolePresets(value: unknown): RolePreset[] {
  if (!Array.isArray(value)) return []
  const out: RolePreset[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (out.length >= ROLE_PRESET_MAX) break
    if (item === null || typeof item !== 'object') continue
    const raw = item as { id?: unknown; name?: unknown; role?: unknown; provider?: unknown; model?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, ROLE_PRESET_NAME_MAX) : ''
    const role = typeof raw.role === 'string' ? raw.role.trim().slice(0, ROLE_PRESET_ROLE_MAX) : ''
    if (name === '' || role === '') continue
    const candidate = typeof raw.id === 'string' ? raw.id.trim().slice(0, ROLE_PRESET_ID_MAX) : ''
    const id = candidate === '' || seen.has(candidate) ? randomUUID() : candidate
    seen.add(id)
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    const routed = provider !== '' && model !== ''
    out.push({
      id,
      name,
      role,
      ...(routed ? { provider, model } : {}),
    })
  }
  return out
}

/** 阵容预设的硬上限（客户端与服务端共用；服务端截断，客户端提前拦截）。 */
export const SQUAD_MAX = 20
export const SQUAD_MEMBER_MAX = 8
const SQUAD_ID_MAX = 64
const SQUAD_NAME_MAX = 40
const SQUAD_MEMBER_ROLE_MAX = 400

/** 阵容成员 key 的净化规则：与客户端 `sanitizeKey` 同源
 *  （小写、保留中日韩、非法字符折成 '-'、去首尾）。 */
function sanitizeSquadKey(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 把任意输入收敛成合法的阵容预设清单（B3+）。
 *
 * 与 {@link sanitizeRolePresets} 同一套路（schemastery 不校验 required，
 * 条目级校验只能手写），差别只有两条：
 *   - 成员的**去重键是 key**（同一阵容里不能有两位同名专家）；
 *   - **没有任何成员的阵容被丢弃** —— 否则设置页会出现一条点了没反应的条目。
 *
 * 兼容性（这一条就是"结构变更必须自带迁移"的落地方式）：`squads` 是
 * **可选新增字段**，旧偏好对象里没有它时读到的是 `[]`，读侧归一化、
 * 只有用户真的保存时才写回，因此不需要版本号迁移，也不可能损坏已有数据。
 */
export function sanitizeSquads(value: unknown): RoleSquad[] {
  if (!Array.isArray(value)) return []
  const out: RoleSquad[] = []
  const seenIds = new Set<string>()
  for (const item of value) {
    if (out.length >= SQUAD_MAX) break
    if (item === null || typeof item !== 'object') continue
    const raw = item as { id?: unknown; name?: unknown; members?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, SQUAD_NAME_MAX) : ''
    if (name === '') continue
    const members: RoleSquadMember[] = []
    const seenKeys = new Set<string>()
    if (Array.isArray(raw.members)) {
      for (const entry of raw.members) {
        if (members.length >= SQUAD_MEMBER_MAX) break
        if (entry === null || typeof entry !== 'object') continue
        const member = entry as { key?: unknown; role?: unknown; provider?: unknown; model?: unknown }
        const key = sanitizeSquadKey(member.key)
        if (key === '' || seenKeys.has(key)) continue
        seenKeys.add(key)
        const role = typeof member.role === 'string' ? member.role.trim().slice(0, SQUAD_MEMBER_ROLE_MAX) : ''
        const provider = typeof member.provider === 'string' ? member.provider.trim() : ''
        const model = typeof member.model === 'string' ? member.model.trim() : ''
        const routed = provider !== '' && model !== ''
        members.push({ key, role, ...(routed ? { provider, model } : {}) })
      }
    }
    if (members.length === 0) continue
    const candidate = typeof raw.id === 'string' ? raw.id.trim().slice(0, SQUAD_ID_MAX) : ''
    const id = candidate === '' || seenIds.has(candidate) ? randomUUID() : candidate
    seenIds.add(id)
    out.push({ id, name, members })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 3. 归一化：把任意一层输入叠到基准之上
 * ------------------------------------------------------------------ */

/** 0 = 不限制；任何有限非负整数都接受。 */
function clampLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * 把 `layer` 叠在 `base` 之上并逐字段净化。
 *
 * 语义与宿主 `SettingsScope.update(patch)` + `get()` 的组合一致：**只覆盖
 * `layer` 中出现的字段**，其余沿用 `base`。因此同一个函数同时服务于两条路径：
 *   - 读盘：`normalizePreferences(fileContent, defaults)` —— 旧文件缺新字段时补默认；
 *   - 写入：`normalizePreferences(patch, current)` —— 设置页的部分更新。
 */
export function normalizePreferences(layer: unknown, base: RoundTablePreferences): RoundTablePreferences {
  const raw = (layer !== null && typeof layer === 'object' ? layer : {}) as Record<string, unknown>
  const pick = <T>(key: keyof RoundTablePreferences, fallback: T, accept: (value: unknown) => T | undefined): T => {
    if (!(key in raw)) return fallback
    const accepted = accept(raw[key])
    return accepted === undefined ? fallback : accepted
  }
  const asMode = (value: unknown): RoundTablePreferences['defaultMode'] | undefined =>
    value === 'orchestrated' || value === 'egalitarian' || value === 'redteam' ? value : undefined
  const asPositiveInt = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined
  const asTokens = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? Math.floor(value) : undefined
  const asBoolean = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined
  const asDelivery = (value: unknown): RoundTablePreferences['skillDelivery'] | undefined =>
    value === 'relay' || value === 'direct' ? value : undefined

  return {
    defaultMode: pick('defaultMode', base.defaultMode, asMode),
    maxRounds: pick('maxRounds', base.maxRounds, asPositiveInt),
    maxTokens: pick('maxTokens', base.maxTokens, asTokens),
    showAllMeetings: pick('showAllMeetings', base.showAllMeetings, asBoolean),
    expertMaxTokens: pick('expertMaxTokens', base.expertMaxTokens, (value) => clampLimit(value, base.expertMaxTokens)),
    expertMaxOpinions: pick('expertMaxOpinions', base.expertMaxOpinions, (value) => clampLimit(value, base.expertMaxOpinions)),
    feedbackEnabled: pick('feedbackEnabled', base.feedbackEnabled, asBoolean),
    skillDelivery: pick('skillDelivery', base.skillDelivery, asDelivery),
    hiddenPanels: pick('hiddenPanels', base.hiddenPanels, sanitizeHiddenPanels),
    legendHidden: pick('legendHidden', base.legendHidden, asBoolean),
    rolePresets: pick('rolePresets', base.rolePresets, sanitizeRolePresets),
    squads: pick('squads', base.squads, sanitizeSquads),
  }
}

/* ------------------------------------------------------------------ *
 * 4. 偏好存储
 * ------------------------------------------------------------------ */

/** 偏好读取面：`get()` 永远返回一个完整、合法的对象。 */
export interface PreferenceStore {
  /** 当前生效的偏好（同步读，永远完整）。 */
  get(): RoundTablePreferences
  /** 叠加一次部分更新，落盘后返回新值；写失败只记日志，不抛给调用方。 */
  update(patch: unknown): Promise<RoundTablePreferences>
  /** 订阅变更（返回退订函数）；回调抛错不影响其它订阅者。 */
  watch(listener: (value: RoundTablePreferences) => void): () => void
  /** 等待首次读盘完成（测试与诊断用）。 */
  ready(): Promise<void>
}

/** 建一个偏好存储所需的最小依赖。 */
export interface PreferenceStoreOptions {
  /** 基准偏好（通常来自插件 Config 的 `defaultMode` 与内置默认值）。 */
  base: RoundTablePreferences
  /** 覆盖偏好文件路径（测试用）。 */
  file?: string
  /** 诊断日志；缺省静默 —— 偏好问题不该刷屏。 */
  log?: (message: string, error?: unknown) => void
}

/**
 * 创建偏好存储。
 *
 * 读盘是**惰性且异步**的（构造后立刻开始），因此 `get()` 在首次读盘完成前
 * 返回基准值而不是阻塞宿主启动 —— 这与宿主设置服务的可用性无关，也是它比
 * `ctx.inject(['settings'])` 更稳的地方：没有可选能力可缺。
 */
export function createPreferenceStore(options: PreferenceStoreOptions): PreferenceStore {
  const file = options.file ?? preferencesFilePath()
  let current = options.base
  let writeQueue: Promise<void> = Promise.resolve()
  const listeners = new Set<(value: RoundTablePreferences) => void>()

  const load = (async (): Promise<void> => {
    try {
      const text = await readFile(file, 'utf8')
      current = normalizePreferences(JSON.parse(text), options.base)
    } catch (error: unknown) {
      // 文件不存在是正常首次启动；其余情况（坏 JSON、权限）留痕但继续。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.log?.(`roundtable: preferences at ${file} unreadable; using defaults`, error)
      }
    }
  })()

  const publish = (next: RoundTablePreferences): void => {
    current = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error: unknown) {
        options.log?.('roundtable: a preference listener threw', error)
      }
    }
  }

  return {
    get: () => current,
    ready: () => load.then(() => undefined),
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async update(patch) {
      await load
      const next = normalizePreferences(patch, current)
      publish(next)
      // 串行化落盘：并发的设置页提交不会互相截断，最后一次写入胜出。
      writeQueue = writeQueue.then(async () => {
        try {
          await mkdir(dirname(file), { recursive: true })
          await writeTextAtomic(file, JSON.stringify(next, null, 2))
        } catch (error: unknown) {
          options.log?.(`roundtable: failed to persist preferences to ${file}`, error)
        }
      })
      await writeQueue
      return next
    },
  }
}
