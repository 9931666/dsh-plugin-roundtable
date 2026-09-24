/**
 * 提示词资产（第 4 步：各 AI 之间的提示词与限定）。
 *
 * 本模块**只生成纯文本**，零运行时依赖（仅 type-only import）。这样
 * `test/prompt-budget.test.mjs` 可以直接 import 它做体积护栏 —— 提示词
 * 会随时间自然膨胀，护栏是唯一能阻止它涨回去的手段。
 *
 * 三条设计原则（压缩而不丢信息）：
 *   1. **常驻的极简**：usage 段只讲"什么时候用哪件工具"，操作规程留在各
 *      工具自己的 description 里（两处都常驻，所以同一规则绝不写两遍）；
 *   2. **按需的详尽**：细节在真正用到它的那一刻才进上下文；
 *   3. **跨边界的结构化**：转发用引用（`R{n}[{speaker}]`）而不是复述全文。
 *
 * @module dsh-plugin-roundtable/prompt
 */

import type { Meeting, MeetingNode, SkillDelivery } from './types.ts'

/** 任务信封（主持人 → 专家）：固定四段，可机械转发，不粘贴全文。 */
export const TASK_ENVELOPE
  = '[TASK R{轮} → {key}] 目标｜输入（引用 R{n}[{发言人}] 或文件路径）｜约束｜期望产出'

/** 报告信封（专家 → 网关/主持人）：`[核心产出]` 就是网关抓取的段落。 */
export const REPORT_ENVELOPE
  = '[REPORT R{轮} {key}] 结论（≤3 条）｜证据｜待决策'

/**
 * 主持人（DeepSeek 本体）的常驻 usage 段。
 *
 * **它每一次请求都要付费**，包括完全不开会的日常对话。因此这里只保留
 * "何时触发、按什么顺序、红线在哪"，把流程细节交给各工具的 description。
 * 也**不再逐个列出工具名**：工具 schema 本来就在请求里，列一遍是纯冗余。
 */
export function usageSectionText(): string {
  return `When the user asks to run a round-table meeting (圆桌会议) you are the captain (主持人). This section only fixes WHEN each tool applies; each tool's own description carries its details.

1. Never create a meeting directly: call roundtable_plan_meeting first (name, goal, intended experts, parameters) — it shows the human a SETTINGS CARD and blocks. Create only with the confirmed values, and always show the card, even for a single expert.
2. Then roundtable_add_node once per expert and roundtable_connect to wire the topology. A node inherits your provider/model unless the user explicitly asked for another route.
3. Delegate, do not duplicate: hand work to nodes, watch with roundtable_status, pull roundtable_summarize. Two channels — never both for the same content: roundtable_speak is the durable record and gateway input (nobody is woken); roundtable_send_message wakes the recipient and is only for something they must act on now.
4. Relay compactly. Forward with ${TASK_ENVELOPE} — quote the transcript reference instead of pasting the full text, since an expert can read the transcript itself. Experts answer as ${REPORT_ENVELOPE}, and [核心产出] is exactly the segment the gateway captures.
5. Open every round with roundtable_status: execute each pending_actions line with the matching tool, and call roundtable_actions_clear only after every one succeeded. Pass back its next_since cursor so each poll returns only new lines.
6. Real forks go to the human via roundtable_request_decision. Never decide for the user.
7. Budget honesty: the token figure is an ESTIMATE OF SPOKEN TEXT (≈0.6 token/CJK char), NOT the real spend — say so when you report it. Provider-reported real usage is shown when measurable. A muted (闭麦) meeting is topped up with roundtable_set_budget.
8. Knowledge base and skills are relayed by you, never copied wholesale: read the one file or skill, hand over only what the expert needs, and cache the distilled points with roundtable_kb_digest — a later HIT then costs nothing.
9. 针锋相对: when a plan is settled, ASK the user first, then roundtable_start_review; red-team experts only attack the plan, and a re-review may only re-check the previous pass's endorsed flaws. Close the meeting with roundtable_export_meeting (or roundtable_export_review for the review record alone).
10. Handing work to a black-box worker model (image/video) goes through roundtable_proxy_think so the reasoning chain stays visible.`
}

/** Per-expert answer limits resolved from settings at spawn time. */
export interface ExpertLimits {
  /** Per-request output token cap (model max_tokens); 0 = unlimited. */
  maxTokens?: number
  /** Max opinions per round (prompt-level constraint); 0 = unlimited. */
  maxOpinions?: number
}

/** 节点 persona 需要的 skill 上下文（R2：会议选中的 skill 与传递方式）。 */
export interface NodeSkillContext {
  /** 选择随 persona 注入的 skill 名称（缺省取 meeting.skills）。 */
  names?: readonly string[]
  /** 缺省取 meeting.skillDelivery。 */
  delivery?: SkillDelivery
  /** host 是否真的注册了 `skill` 工具（未注册时不得让专家去调它）。 */
  skillToolAvailable?: boolean
}

/**
 * skill 段落：把"选了哪些 skill / 用哪种方式"写进 persona。
 *
 * direct 模式下这是**必须**的：`skill` 工具本身不带白名单参数，专家只有
 * 在 persona 里被告知可用清单，才知道能调什么（R2.3）。
 */
function skillSection(meeting: Meeting, skill: NodeSkillContext): string {
  const names = (skill.names ?? meeting.skills ?? []).filter((name) => name !== '')
  const delivery = skill.delivery ?? meeting.skillDelivery ?? 'relay'
  if (names.length === 0 && delivery !== 'direct') return ''
  const list = names.length === 0 ? '（本次会议未选中任何 skill）' : names.map((name) => `\`${name}\``).join('、')
  if (delivery === 'direct') {
    const usable = names.length > 0 && skill.skillToolAvailable === true
    return `skill：${list}。传递方式为「专家直接调用」：${usable
      ? '需要完整说明时自己调用 `skill` 工具（name 传上方清单里的名字）加载全文，并严格按其约束工作。'
      : '当前 `skill` 工具不可用或未选中 skill，不要尝试调用，用你自己的通用能力完成任务。'}`
  }
  return `skill：${list}。传递方式为「主持人中转」：主持人会把要点转交给你，你不要也不应该自己调用 \`skill\` 工具；把这些 skill 的约束当作既定工作前提。`
}

/** The node's system prompt (persona): the charter plus node working rules.
 *
 *  与 charter 严格分工：**总纲写共同红线（格式、编造、拍板），这里只写
 *  "你这个节点具体怎么做"**。同一约束绝不在这两处各写一遍 —— persona 会
 *  跟着专家的每一次请求付费。 */
export function nodePersona(
  meeting: Meeting,
  node: MeetingNode,
  stateDir: string,
  limits: ExpertLimits = {},
  skill: NodeSkillContext = {},
): string {
  const modeRule = meeting.mode === 'egalitarian'
    ? '- 协作模式为"多模型平等"：你可以用 roundtable_send_message 直接与其他节点交换意见，无需主持人中转。'
    : '- 协作模式为"主持人统筹"：你只向主持人汇报，其他节点的观点由主持人转达。'
  const opinionRule = limits.maxOpinions !== undefined && limits.maxOpinions > 0
    ? ` 每轮最多 ${limits.maxOpinions} 条意见，宁缺毋滥。`
    : ''
  return `${meeting.charter}

你是会议"${meeting.name}"中的专家节点 ${node.key}${node.role !== undefined && node.role !== '' ? `，角色：${node.role}` : ''}。

工作规则：
1. 收到任务后执行一整轮工作，再用 roundtable_speak 汇报（to 留空 = 交网关）；只有需要某人**立刻行动**时才用 roundtable_send_message。
2. 按总纲第三节的格式发言，并采用报告信封 ${REPORT_ENVELOPE}：结论 ≤3 条，其余内容一律省略（[核心产出] 即网关抓取的段落）。
3. 主持人转来的引用不足以判断时，自己读 ${stateDir}/${meeting.id}/transcript.jsonl 取原文（只读，严禁直接修改；一切状态变更走 roundtable_* 工具）。
4. 你是专家不是主持人：不创建/移除节点、不修改连线、不发起人类决策、不结束会议。
${skillSection(meeting, skill)}
${modeRule}

回答限制（省 token，务必遵守）：
- 只回答与议题直接相关的内容；无关问题直接说明"与议题无关"。
- 不用假设代替事实；不确定就明确说"不确定"。
- 不举无关的例子；举例必须直接服务于论点。
- 语言简洁明了，不用华丽修辞与空话套话。${opinionRule}`
}

/** The initial user message delivered when the node is created. */
export function nodeWelcome(meeting: Meeting, node: MeetingNode): string {
  return `你已加入圆桌会议"${meeting.name}"（会议 id ${meeting.id}）作为专家节点 ${node.key}。主持人会通过消息布置任务或转达其他节点的观点；收到后执行一整轮工作并用 roundtable_speak 汇报。现在等待主持人的指令。`
}
