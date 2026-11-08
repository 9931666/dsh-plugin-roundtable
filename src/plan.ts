/**
 * 会议设置确认卡片（R1）：草案数据结构 + 卡片 Markdown 渲染 + 答案解析。
 *
 * 原生 `ctx.userQuestions` 没有表单能力（只有选项列表 + 一个自由文本
 * `custom`），所以"可改全部"是通过 `custom` 自由文本 + 回流重建实现的，
 * 而不是富表单。本模块只负责把一份草案渲染成**可读**的 Markdown，并把
 * 用户的回答解析成三态：approved / revise / unavailable。
 *
 * 卡片形态（v1）是两张 Markdown 表：表 1 会议设置、表 2 专家名单。表格比
 * 逐行列表更容易横向对照"这一场会到底会怎么开"，也让新增字段（模型、提示词）
 * 有固定位置可放。渲染规则全部落在这里 —— 工具层只负责拼参数，不再自己拼字。
 *
 * @module dsh-plugin-roundtable/plan
 */

import type { SkillDelivery } from './types.ts'

/** skill 的两种传递方式（D5）。单一来源：types.ts。 */
export type { SkillDelivery }

/** 卡片上"确定开始"选项的固定标签；`intent.approve` 必须与它逐字一致。
 *
 *  文案与针锋（crossfire）保持一致：两个插件在"确认后真正开始"这一步给用户
 *  的应当是同一句话，否则同一套流程在两个入口上看起来像两件事。 */
export const PLAN_APPROVE_LABEL = '确定开始'

/** 卡片上的次选项：用户想改点什么（改完会再弹一次同一张卡）。 */
export const PLAN_REVISE_LABEL = '仍需修改'

/** 草案里的一位专家（尚未创建节点）。
 *
 *  与 `roundtable_add_node` 的入参对应：确认后主持人逐个照此拉节点，`prompt`
 *  写进 `MeetingNode.expertPrompt`，由 `nodePersona()` 生成「专家补充定位」段。 */
export interface DraftExpert {
  /** 专家唯一标识（会议内节点 key）。 */
  key: string
  /** 角色说明，如"安全审查"。 */
  role?: string
  /** 可选 LLM provider 路由；必须与 model 同时给出才生效。 */
  provider?: string
  /** 可选模型名；空 = 继承主持人当前路由。 */
  model?: string
  /** 专家补充定位（可选）：只放宽"你的专长范围/关注点"，
   *  **不能**放宽总纲红线（格式、编造、拍板边界）—— 硬边界由 persona 声明。 */
  prompt?: string
}

/**
 * 一张设置卡片所描述的会议草案（尚未创建）。
 *
 * 字段与 `roundtable_create` 的入参一一对应，外加 `experts` / `skills` /
 * `skillDelivery`，这样用户确认后主持人可以**原样**按草案创建会议与拉专家，
 * 不再自行拍参数。
 */
export interface MeetingDraft {
  /** 会议名称（同时作为会议 id 的稳定来源）。 */
  name: string
  /** 会议背景与核心目标（总纲第一节）。 */
  goal: string
  /** 协作模式。 */
  mode: 'orchestrated' | 'egalitarian' | 'redteam'
  /** 轮数上限，超限闭麦。 */
  maxRounds: number
  /** Token 预算上限，超限闭麦。 */
  maxTokens: number
  /** 知识库目录（可空）：主持人按需读取其中文件转交专家。 */
  kbPath: string
  /** 本次会议选中的 skill 名称清单（可为空）。 */
  skills: string[]
  /** skill 传递方式：relay=主持人中转；direct=专家自行调用。 */
  skillDelivery: SkillDelivery
  /** 草案里的专家名单（可为空；空名单在卡片上给出可操作提示）。 */
  experts: DraftExpert[]
}

/** 卡片选项的两态解析结果。 */
export type PlanConfirmation =
  | { kind: 'approved' }
  | { kind: 'revise'; note: string }
  /** 服务缺失或用户没给任何选择：主持人应把它当作"再确认一次"。 */
  | { kind: 'unavailable'; note: string }

/** 可选 skill 清单在卡片上最多列出的条数（超出只给数量）。 */
const SKILL_LIST_LIMIT = 12

/** 提示词列的摘要长度上限。
 *
 *  40 字足够看出"这位专家被额外要求盯什么"，再长就会把整张表撑成一段文章；
 *  完整提示词留在主持人上下文里，卡片只负责让人一眼看懂。 */
const PROMPT_SUMMARY_LIMIT = 40

/** 清单里的一条 skill：只要名字与描述这两个字段。 */
export interface SkillListEntry {
  readonly name: string
  readonly description?: string
}

/**
 * 表格单元格的内容归一化：压平换行与连续空白、转义裸 `|`。
 *
 * 卡片是纯文本渲染的 Markdown：一个没转义的 `|` 会被当成列分隔符，一个换行
 * 会把整行拦腰截断 —— 用户看到的表格就会错列。所有进表格的值都必须先过这里。
 */
function cell(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

/** 单元格值，空串换成占位符（占位符也过一遍 `cell`，保持一致）。 */
function cellOr(value: string, empty: string): string {
  const flat = cell(value)
  return flat === '' ? empty : flat
}

/** 渲染一张 Markdown 表格（列头 + 分隔行 + 数据行）。 */
function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`
  return [
    line(header),
    line(header.map(() => '---')),
    ...rows.map((row) => line(row)),
  ].join('\n')
}

/** 协作模式的可读标签（括号里是它改变行为的那一点）。 */
function modeLabel(mode: MeetingDraft['mode']): string {
  if (mode === 'egalitarian') return 'egalitarian（多模型平等，专家互相直达，超预算闭麦）'
  if (mode === 'redteam') return 'redteam（针锋相对，专家只挑已定稿方案的毛病）'
  return 'orchestrated（主持人统筹，一切经由主持人转达）'
}

/** skill 传递方式的可读标签。 */
function deliveryLabel(delivery: SkillDelivery): string {
  return delivery === 'relay'
    ? 'relay（主持人中转：主持人读正文后按需转交，省 token、行为可预测）'
    : 'direct（专家直接调用：专家自己用 `skill` 工具加载，更自主、各自读取）'
}

/** 主持人实际路由（用于把「继承主持人」画成用户看得懂的模型名）。 */
export interface InheritedRoute {
  provider?: string
  model?: string
}

/** 专家名单的「模型」列：只有 provider+model 同时给出才算显式路由。
 *
 *  没给路由时显示「继承主持人」；调用方把主持人的实际 route 传进来后追加
 *  括号（`继承主持人（deepseek/deepseek-chat）`），否则用户根本不知道继承的
 *  到底是哪个模型。取不到时不猜 —— 猜一个模型名比不写更误导。 */
function routeLabel(expert: DraftExpert, inherited?: InheritedRoute): string {
  const provider = (expert.provider ?? '').trim()
  const model = (expert.model ?? '').trim()
  if (provider !== '' && model !== '') return `${provider}/${model}`
  const inheritedProvider = (inherited?.provider ?? '').trim()
  const inheritedModel = (inherited?.model ?? '').trim()
  return inheritedProvider !== '' && inheritedModel !== ''
    ? `继承主持人（${inheritedProvider}/${inheritedModel}）`
    : '继承主持人'
}

/** 专家名单的「提示词」列：有值给前 N 字摘要，无值说明它是自动推导的。 */
function promptSummary(expert: DraftExpert): string {
  const text = cell(expert.prompt ?? '')
  if (text === '') return '自动（总纲 + 角色）'
  // 只有真的被截断才补省略号：短提示词挂个"…"会让用户以为卡片藏了内容。
  return text.length <= PROMPT_SUMMARY_LIMIT ? text : `${text.slice(0, PROMPT_SUMMARY_LIMIT)}…`
}

/** 专家名单表的行（表头固定 5 列：序号 / key / 角色 / 模型 / 提示词）。 */
function expertRows(experts: readonly DraftExpert[], inherited?: InheritedRoute): string[][] {
  return experts.map((expert, index) => [
    String(index + 1),
    `\`${cell(expert.key)}\``,
    cellOr(expert.role ?? '', '（未填角色）'),
    routeLabel(expert, inherited),
    promptSummary(expert),
  ])
}

/** revised 卡片顶部的「本次变更」列表。
 *
 *  `changes` 为空时**不假装**有变更（写明"本次未标注"）：主持人没总结变更，
 *  用户就会以为卡片和上一版一模一样，反而更容易漏看真正的改动。
 */
function formatChanges(changes: readonly string[]): string {
  const items = changes.map((change) => cell(change)).filter((change) => change !== '')
  const body = items.length === 0
    ? '> - （本次未标注具体变更）'
    : items.map((change) => `> - ${change}`).join('\n')
  return `> 本次变更：\n${body}`
}

/**
 * 把一份草案渲染成卡片正文（Markdown）。
 *
 * 这里是"让用户看懂将要创建什么"的唯一位置：表 1 摊开会议参数，表 2 逐个
 * 列出专家的 key / 角色 / 模型 / 提示词摘要，表格下方是完整目标，并把
 * **当前可选**的 skill 清单也列出来（用户要在「仍需修改」的自由文本里增删
 * skill，就得先看得到名字）。禁止在其中塞伪交互说明。
 */
export function formatMeetingDraft(
  draft: MeetingDraft,
  options: {
    revised?: boolean
    changes?: readonly string[]
    availableSkills?: readonly SkillListEntry[]
    /** 主持人实际路由：把「继承主持人」补成「继承主持人（provider/model）」。 */
    inheritedRoute?: InheritedRoute
  } = {},
): string {
  const expertList = draft.experts
  const skills = draft.skills.length === 0
    ? '（未选）'
    : draft.skills.map((skill) => `\`${cell(skill)}\``).join('、')
  const settingsRows: string[][] = [
    ['会议名称', cellOr(draft.name, '（未命名）')],
    ['协作模式', modeLabel(draft.mode)],
    ['轮数上限', `${draft.maxRounds} 轮（超限自动闭麦）`],
    ['Token 预算', `${draft.maxTokens} tokens（超限自动闭麦）`],
    ['知识库', cellOr(draft.kbPath, '（未设置：专家需要资料时由主持人按需读取转交）')],
    ['选中 skill', cell(skills)],
    ['skill 传递方式', deliveryLabel(draft.skillDelivery)],
    ['专家数量', `${expertList.length} 位`],
  ]
  const rosterTable = markdownTable(['#', '专家 key', '角色', '模型', '提示词'], expertRows(expertList, options.inheritedRoute))
  const roster = expertList.length === 0
    ? `${rosterTable}\n\n（暂无专家——建议至少 1 位；可在「${PLAN_REVISE_LABEL}」里补上）`
    : rosterTable
  const revised = options.revised === true
  const header = `# 会议设置确认 · ${cellOr(draft.name, '（未命名）')}${revised ? '（已按你的意见更新）' : ''}`
  const intro = revised
    ? formatChanges(options.changes ?? [])
    : '> 以下是主持人推导的会议草案。**确认后才会真正创建会议。**'
  return [
    header,
    '',
    intro,
    '',
    '## 会议设置',
    '',
    markdownTable(['项', '值'], settingsRows),
    '',
    '## 专家名单',
    '',
    roster,
    '',
    '## 议题 / 目标',
    '',
    draft.goal.trim() === '' ? '（未提供，以主持人现场说明为准）' : draft.goal.trim(),
    '',
    `## 可选 skill 清单（写进「${PLAN_REVISE_LABEL}」的说明里即可增删）`,
    formatAvailableSkills(options.availableSkills ?? []),
    '',
    '---',
    `选「${PLAN_REVISE_LABEL}」时，请在输入框里写清改什么（例：把 reviewer 换成 zai-coding-cn/glm-5.2、预算降到 5 轮、加上 skill \`pdf-fill\`）。主持人据此更新草案后**会再弹一次**这张卡片。`,
  ].join('\n')
}

/** 渲染"当前可选 skill"清单（空清单给出可操作提示）。 */
function formatAvailableSkills(available: readonly SkillListEntry[]): string {
  if (available.length === 0) {
    return '（本机当前没有可选 skill：把 skill 放进 `<工作区>/.dsh/skills/`、`<工作区>/.agents/skills/` 或 `<DSH_HOME>/skills/` 即会出现）'
  }
  const lines = available.slice(0, SKILL_LIST_LIMIT).map((skill) => {
    const description = skill.description === undefined || skill.description.trim() === '' ? '' : ` — ${skill.description.trim()}`
    return `  - \`${skill.name}\`${description}`
  })
  if (available.length > SKILL_LIST_LIMIT) {
    lines.push(`  - …另有 ${available.length - SKILL_LIST_LIMIT} 个`)
  }
  return lines.join('\n')
}

/**
 * 解析用户的卡片回答。
 *
 * 协议与 `intent.kind: 'plan-review'` 的语义一致：`selected` 含
 * `PLAN_APPROVE_LABEL` 即视为批准，其余选项（或只有 custom 文本）视为
 * 要求修改。不识别 intent 的 UI 会退回普通选项列表，答复编码完全相同。
 */
export function resolvePlanConfirmation(
  answer: { selected: string[]; custom?: string } | undefined,
  approveLabel: string = PLAN_APPROVE_LABEL,
): PlanConfirmation {
  if (answer === undefined) return { kind: 'unavailable', note: '' }
  const selected = Array.isArray(answer.selected) ? answer.selected : []
  const note = answer.custom === undefined ? '' : answer.custom.trim()
  if (selected.includes(approveLabel)) return { kind: 'approved' }
  if (note !== '') return { kind: 'revise', note }
  return { kind: 'unavailable', note: '' }
}
