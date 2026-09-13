/**
 * DSH 原生 skill 能力的宿主侧读取（R2）。
 *
 * 插件**不**做 skill 导入：skill 的来源是官方目录
 * （`<工作区>/.dsh/skills/`、`<工作区>/.agents/skills/`、`<DSH_HOME>/skills/`
 * 以及 bundled 目录），由 `@deepseek-ai/dsh-skill-filesystem` 发现。本模块只
 * 通过 `ctx.get('skills')` 可选读取清单与正文。
 *
 * 两个硬约束决定了这里的形状：
 * 1. 插件可以在没有挂载 skill 服务的 profile 里加载 —— 因此一律走
 *    `ctx.get('skills')` 的**可选**读取，服务缺失只降级为空清单，绝不
 *    让插件加载失败。
 * 2. skill 工具的可用性由宿主决定，"放行 `skill` 工具"不等于"服务可用"，
 *    因此放行与否由调用方单独判断（见 members.ts）。
 *
 * @module dsh-plugin-roundtable/skills
 */

import type { Context } from '@deepseek-ai/cordis'

/** `ctx.skills.list()` 返回条目的结构性最小视图（只取插件要用的字段）。 */
export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source?: string
  readonly provider?: string
  readonly invocation?: { readonly modelInvocable?: boolean; readonly userInvocable?: boolean }
}

/** 完整 skill 定义（含正文）。 */
export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
}

/** 只声明插件真正用到的两个方法，避免把宿主的服务类绑死在类型里。 */
export interface SkillRegistryLike {
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<SkillSummaryLike[]>
  get(name: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<SkillDefinitionLike | undefined>
}

/** 读取 skill 服务；未挂载时返回 undefined（不抛错、不影响插件加载）。 */
export function skillRegistryOf(ctx: Context): SkillRegistryLike | undefined {
  const skills = ctx.get('skills') as SkillRegistryLike | undefined
  if (skills === undefined || skills === null || typeof skills.list !== 'function') return undefined
  return skills
}

/**
 * 列出某个工作区可见的、**可被模型调用**的 skill 清单。
 *
 * 服务缺失、发现失败或工作区不可读时都降级为空数组：设置卡片上的 skill
 * 列表因此永远不会成为创建会议的阻塞点。
 */
export async function listInvocableSkills(
  ctx: Context,
  cwd: string,
  signal?: AbortSignal,
): Promise<SkillSummaryLike[]> {
  const registry = skillRegistryOf(ctx)
  if (registry === undefined) return []
  let summaries: SkillSummaryLike[]
  try {
    summaries = await registry.list({ cwd, ...(signal !== undefined ? { signal } : {}) })
  } catch {
    return []
  }
  return summaries
    .filter((summary) => summary !== undefined && typeof summary.name === 'string' && summary.name !== '')
    // modelInvocable 缺省视为可调用：`skill` 工具本身也只在可调用时才列出。
    .filter((summary) => summary.invocation?.modelInvocable !== false)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 读取一个 skill 的正文（relay 模式下主持人转交用）。
 * 未挂载服务或 skill 不存在时返回 undefined。
 */
export async function readSkillBody(
  ctx: Context,
  name: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SkillDefinitionLike | undefined> {
  const registry = skillRegistryOf(ctx)
  if (registry === undefined) return undefined
  try {
    return await registry.get(name, { cwd, ...(signal !== undefined ? { signal } : {}) })
  } catch {
    return undefined
  }
}

/** 把清单渲染成卡片/工具输出用的一行行文本。 */
export function formatSkillLine(summary: SkillSummaryLike): string {
  const description = summary.description.trim() === '' ? '' : ` — ${summary.description.trim()}`
  const source = summary.source === undefined || summary.source === '' ? '' : ` [${summary.source}]`
  return `- \`${summary.name}\`${description}${source}`
}
