/**
 * 宿主兼容与能力边界（Host compatibility boundary）。
 *
 * **所有与 DSH 版本相关的形状都集中在这个文件里。**
 * 理由与做法直接借鉴社区项目 dsh-agent-teams 的 `src/harness-compat.ts`：
 *
 * > Keep version-specific shapes here: **API presence alone is not a promise of
 * > support for future versions.**
 *
 * 我们的宿主是 **rc 线**（0.1.5-rc.2 → rc.3 → 0.1.6-alpha.*），API 尚未冻结，
 * 破坏性变更属于常态。所以在写任何 `ctx.get(...)` / `ctx.on(...)` / 服务方法
 * 调用之前，先问一句：**这个形状在别的 rc 上还成立吗？** 如果答案需要翻源码，
 * 那它就应该写进本文件，而不是散进业务代码。
 *
 * 两条铁律：
 *   1. **探测绝不成为新的加载门禁**。这里没有 `inject`、没有静态导入宿主包，
 *      缺失的能力一律降级（记录进审计表）——v0.2.36 的「整个界面消失」事故
 *      就是可选能力被当成必需能力造成的。
 *   2. **降级要留痕**。每个能力第一次被探测时记一条审计，`roundtable_status`
 *      与 `scripts/doctor.mjs` 都能把它打出来，让"为什么某个功能没生效"
 *      有一个能查的答案，而不是靠猜。
 *
 * @module dsh-plugin-roundtable/harness-compat
 */

import type { Context } from '@deepseek-ai/cordis'
// 仅做声明合并：让 ctx.subagents / ctx.llm 等在本文件可见。
import type {} from '@deepseek-ai/dsh-subagent'

/* ------------------------------------------------------------------ *
 * 1. 支持声明（与 compatibility.json 必须一致，由测试强制）
 * ------------------------------------------------------------------ */

/**
 * 插件**要求**宿主提供的服务能力：少一个就装不起来。
 *
 * 这个数组必须与 `src/index.ts` 的 `inject`、`compatibility.json` 的
 * `capabilities` 三者逐字一致 —— `scripts/compatibility.mjs` 会校验，
 * 不一致直接失败。这样"支持哪些宿主"只有一处真话。
 */
export const REQUIRED_CAPABILITIES = ['tools', 'subagents', 'agents', 'systemPrompt'] as const

/** 可选能力：缺失只降级，绝不阻断加载。 */
export const OPTIONAL_CAPABILITIES = [
  'connection',
  'llm',
  'skills',
  'settings',
  'userQuestions',
  'sessionProjections',
  'webServer',
  'workspaceRegistry',
] as const

/* ------------------------------------------------------------------ *
 * 2. 探测点清单
 * ------------------------------------------------------------------ */

/** 一个能力探测点的静态描述。 */
export interface CapabilitySpec {
  id: string
  kind: 'required' | 'optional'
  /** 用来做什么。 */
  purpose: string
  /** 缺失（或形状不符）时发生什么 —— 这一栏是运维价值的核心。 */
  whenMissing: string
  /** 版本相关的证据说明。 */
  evidence: string
}

/**
 * 本插件触碰过的**每一个**宿主能力探测点。
 *
 * 加新的探测点时同时更新这里：`scripts/doctor.mjs` 与
 * `test/compatibility.test.mjs` 都以本表为准，漏登记会被测试拦下。
 */
export const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
  {
    id: 'tools',
    kind: 'required',
    purpose: '注册 roundtable_* 工具',
    whenMissing: '整个插件不加载：工具、Web 路由、界面页签一起消失，且没有任何报错',
    evidence: 'inject 加载门禁（cordis 无"可选注入"形式）',
  },
  {
    id: 'subagents',
    kind: 'required',
    purpose: '派发/中断专家子代理',
    whenMissing: '同 tools：插件 fiber 停在 PENDING',
    evidence: 'inject 加载门禁',
  },
  {
    id: 'agents',
    kind: 'required',
    purpose: '中断子代理（父 Agent 离线时的兜底）',
    whenMissing: '同 tools：插件 fiber 停在 PENDING',
    evidence: 'inject 加载门禁',
  },
  {
    id: 'systemPrompt',
    kind: 'required',
    purpose: '把《全局协作总纲》与使用协议注入系统提示',
    whenMissing: '同 tools：插件 fiber 停在 PENDING',
    evidence: 'inject 加载门禁',
  },
  {
    id: 'settings',
    kind: 'optional',
    purpose: '偏好持久化（settings.yaml 的 roundtable 命名空间）',
    whenMissing: '设置页读不出来；偏好退回内存态，重启即丢',
    evidence: 'ctx.inject([\'settings\']) 回调内 try/catch 已兜底',
  },
  {
    id: 'connection',
    kind: 'optional',
    purpose: '① web 路由认证栅栏 ② RPC 兜底传输',
    whenMissing: '栅栏缺失 → 路由可被本机任意网页命中（安全缺口）；主传输仍是插件自己的 web 路由',
    evidence: 'ctx.get(\'connection\')；requestRejection 由宿主 connection 服务提供',
  },
  {
    id: 'llm',
    kind: 'optional',
    purpose: '专家管理下拉的 provider/model 清单；评审观点拆分',
    whenMissing: '专家管理里选不了模型（派发时继承主持人）；观点拆分退回本地兜底',
    evidence: 'ctx.get(\'llm\')；listProviders/listModels',
  },
  {
    id: 'skills',
    kind: 'optional',
    purpose: 'skill 清单与正文（relay 模式由主持人中转）',
    whenMissing: '会议卡片「技能」区空白，不报错',
    evidence: 'skills.ts 硬约束 #1：绝不让插件加载失败',
  },
  {
    id: 'userQuestions',
    kind: 'optional',
    purpose: '专家向用户提问 / 人类决策卡片',
    whenMissing: '「需人类决策」弹不出来，主持人退回"用文字陈述草稿"',
    evidence: 'tools.ts 的 decision:unavailable 回退分支',
  },
  {
    id: 'sessionProjections',
    kind: 'optional',
    purpose: 'provider 上报的真实 token 用量',
    whenMissing: '预算里只显示发言文本粗估，真实用量恒为 0',
    evidence: 'ctx.get(\'sessionProjections\')；snapshot(session, [...]) 形状',
  },
  {
    id: 'webServer',
    kind: 'optional',
    purpose: '挂载 snapshot 与 RPC 两条 HTTP 路由',
    whenMissing: '界面一直转圈、读不到任何会议（headless profile 属预期）',
    evidence: 'ctx.get(\'webServer\') ?? ctx.get(\'httpServer\')，服务键为结构式候选',
  },
  {
    id: 'workspaceRegistry',
    kind: 'optional',
    purpose: '枚举工作区，定位各会议的 state root',
    whenMissing: 'snapshot 路由不挂载（拿不到工作区列表）',
    evidence: 'ctx.get(\'workspaceRegistry\') ?? ctx.get(\'workspace\')',
  },
]

/* ------------------------------------------------------------------ *
 * 3. 审计：探测结果留痕
 * ------------------------------------------------------------------ */

/** 一次能力探测的结果。 */
export type CapabilityState = 'not_probed' | 'available' | 'missing' | 'degraded'

/** 审计表里的一条。 */
export interface CapabilityAudit {
  state: CapabilityState
  /** 人类可读的一句话，说明探测到了什么或为什么降级。 */
  note: string
  ts: number
}

/** 进程级审计表：每个能力只记第一次探测（避免 1 秒轮询刷爆）。 */
const audit = new Map<string, CapabilityAudit>()

/** 当前审计快照（给 roundtable_status / doctor 用）。 */
export function capabilityAudit(): ReadonlyMap<string, CapabilityAudit> {
  return audit
}

/** 渲染成紧凑的一行行文本（诊断输出用）。 */
export function formatCapabilityAudit(): string {
  const lines: string[] = []
  for (const spec of CAPABILITY_SPECS) {
    const entry = audit.get(spec.id)
    const state = entry?.state ?? 'not_probed'
    const mark = state === 'available' ? '✓' : state === 'not_probed' ? '·' : '✗'
    lines.push(`${mark} ${spec.id.padEnd(20)} ${state}${entry === undefined ? '' : ` — ${entry.note}`}`)
  }
  return lines.join('\n')
}

/**
 * 记录一次探测结果（**每个能力只保留第一条**）。
 *
 * 只记第一条是刻意的：探测点常在 tick / 轮询路径上，每次都记会把内存和日志
 * 都吃掉；而"第一次看到它是什么状态"已经足够定位问题。
 */
export function noteCapability(id: string, state: CapabilityState, note: string): CapabilityState {
  if (!audit.has(id)) audit.set(id, { state, note, ts: Date.now() })
  return state
}

/** 测试用：清空审计表。 */
export function resetCapabilityAudit(): void {
  audit.clear()
}

/* ------------------------------------------------------------------ *
 * 4. 服务读取（绝不成为加载门禁）
 * ------------------------------------------------------------------ */

/**
 * 读一个**可选**宿主服务。
 *
 * 统一走 `ctx.get`（cordis 核心、非严格：缺失返回 `undefined`）而不是属性访问
 * —— 后者在没有 `inject` 时会**直接抛错**：
 * `cannot get property "connection" without inject`。
 */
export function optionalService<T>(ctx: Context, name: string): T | undefined {
  const getter = (ctx as unknown as { get?: (service: string) => unknown }).get
  if (typeof getter !== 'function') {
    noteCapability(name, 'missing', 'ctx.get 不存在（宿主 Context 形状变化）')
    return undefined
  }
  let service: unknown
  try {
    service = getter.call(ctx, name)
  } catch (error: unknown) {
    noteCapability(name, 'degraded', `ctx.get('${name}') 抛错：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (service === undefined || service === null) {
    noteCapability(name, 'missing', '宿主未挂载该服务')
    return undefined
  }
  noteCapability(name, 'available', '已解析')
  return service as T
}

/** 可选服务键的结构式候选（宿主可能改名；按序取第一个可用的）。 */
export const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
export const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

/** webServer 服务面（只声明我们真正调用的部分）。
 *
 *  `register` 的返回值刻意只声明为 `() => void`：宿主不同 rc 上返回过
 *  disposer 与 `unknown`，而调用处一律以 `ctx.effect(() => webServer.register(…))`
 *  的形式**忽略返回值**——effect 自带卸载。声明成 `unknown` 会让
 *  `ctx.effect` 的重载解析失败（它要求回调返回具体 Effect，不接受 unknown），
 *  所以这里保留"当它是清理函数"的写法。 */
export interface WebRouteHost {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void
  }): () => void
}

/** workspace 注册表面。 */
export interface WorkspaceListHost {
  list(): { title: string; path: string }[]
}

/**
 * 解析 webServer 服务面。
 *
 * 服务键是**结构式候选**而非固定名：宿主可能把 `webServer` 换成别的名字，
 * 所以按 `WEB_SERVER_KEYS` 顺序探测。headless profile 下取不到属预期，
 * 只降级不报错。
 */
export function webRouteHostOf(ctx: Context): WebRouteHost | undefined {
  for (const key of WEB_SERVER_KEYS) {
    const host = optionalService<WebRouteHost>(ctx, key)
    if (host !== undefined && typeof host.register === 'function') {
      noteCapability('webServer', 'available', `经 ${key} 解析`)
      return host
    }
  }
  noteCapability('webServer', 'missing', `候选键都不可用：${WEB_SERVER_KEYS.join(' / ')}`)
  return undefined
}

/** 解析 workspace 注册表面（同上，结构式候选 + 降级留痕）。 */
export function workspaceRegistryOf(ctx: Context): WorkspaceListHost | undefined {
  for (const key of WORKSPACE_KEYS) {
    const host = optionalService<WorkspaceListHost>(ctx, key)
    if (host !== undefined && typeof host.list === 'function') {
      noteCapability('workspaceRegistry', 'available', `经 ${key} 解析`)
      return host
    }
  }
  noteCapability('workspaceRegistry', 'missing', `候选键都不可用：${WORKSPACE_KEYS.join(' / ')}`)
  return undefined
}

/**
 * 判定一个 `rpc.handle(...)` 返回值能不能当清理函数用。
 *
 * 宿主签名在 rc 线上变过：0.1.1 时代第三参 `{ authority }` 被移除，返回值在
 * 不同版本里出现过 `disposer` / `undefined` / Promise。这里只做**形状判定**，
 * 不 import 宿主类型：合法就交出去，不合法就交给调用方记一条降级。
 */
export function asDisposer(value: unknown): (() => void) | undefined {
  return typeof value === 'function' ? (value as () => void) : undefined
}

/**
 * 在可选的清理函数存在时注册一个 effect。
 *
 * `connection.rpc.handle` 的返回值形状随版本变化，直接 `ctx.effect(() => () =>
 * release())` 会在返回值不是函数时静默留下一个永远不执行的清理器（通道泄漏）。
 */
export function effectWithOptionalDisposer(
  ctx: { effect(callback: () => () => void, label?: string): unknown },
  disposer: unknown,
  label: string,
): boolean {
  const release = asDisposer(disposer)
  if (release === undefined) return false
  ctx.effect(() => () => {
    release()
  }, label)
  return true
}

/* ------------------------------------------------------------------ *
 * 5. sessionProjections 读取（版本敏感的投影形状）
 * ------------------------------------------------------------------ */

/** 投影读取面：宿主只暴露 `snapshot(session, keys)`。 */
export interface ProjectionReadFace {
  snapshot(session: unknown, keys: string[]): { values?: Record<string, unknown> } | undefined
}

/**
 * 读一个 live session 的投影值。
 *
 * **返回 `undefined`，绝不抛错**：测量用量是观察行为，不能因为宿主投影形状
 * 变化就把 `roundtable_status` 弄崩 —— 与 `token-usage.ts` 的既有契约一致。
 */
export function projectionValuesOf(ctx: Context, session: unknown): Record<string, unknown> | undefined {
  if (session === undefined || session === null) return undefined
  try {
    const projections = optionalService<ProjectionReadFace>(ctx, 'sessionProjections')
    if (projections === undefined || typeof projections.snapshot !== 'function') return undefined
    const snapshot = projections.snapshot(session, ['tokenUsage', 'contextPressure'])
    const values = snapshot?.values
    if (values === null || typeof values !== 'object') return undefined
    return values as Record<string, unknown>
  } catch (error: unknown) {
    noteCapability('sessionProjections', 'degraded', `snapshot() 抛错：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
