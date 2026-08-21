/**
 * Proxy Thinking (代理思考): when a black-box worker model (no visible
 * reasoning) must execute a task, the director model (DeepSeek) first writes
 * its own reasoning as `[DeepSeek 代理思考]`, then translates the goal into
 * exact worker parameters. The UI prefixes stages with
 * `[DeepSeek 代理思考]` / `[<worker> 渲染中]`.
 * @module dsh-plugin-roundtable/proxy-thinking
 */

/** The director-side prompt template (spec §6.2). */
export const PROXY_THINKING_TEMPLATE = `【代理思考（Proxy Thinking）—— 导演模型侧】

你当前扮演"导演模型"，负责把一个模糊目标交给一个"无思考过程的干活模型" <worker_model> 执行。
<worker_model> 不会展示思考过程、不会自我纠错、不会追问澄清。
因此你的职责是替它完成思考，并把任务翻译成它能直接执行的指令。

请严格按以下顺序输出，不要遗漏任何一节：

一、[DeepSeek 代理思考]
用自然语言写出你的完整推理过程，至少覆盖：
- 你如何理解这个目标（拆解成哪些子意图）
- 你选择什么策略，为什么
- 关键参数为什么这样定（给出取舍理由）
- 预期结果是什么
- 可能的失败点与兜底方案
（这一节是"代理思考"，直接展示给用户，补齐 <worker_model> 缺失的透明性。）

二、[参数翻译 → <worker_model>]
把目标翻译成 <worker_model> 能直接执行的精确指令/参数：
- 字段必须符合 <worker_model> 的输入规范（schema）
- 禁止含糊描述：不用"好看一点/高级一点"，必须给出具体风格、构图、时长、尺寸、语气等
- 输出为结构化 JSON 或精确指令文本（以 <worker_model> 实际接受的格式为准）

三、[预期与兜底]
- 预期结果：执行成功时应得到什么
- 失败兜底：若结果不符合预期，你接下来如何修正或降级`

/** Compose the director-side prompt for one worker task. */
export function proxyThinkingPrompt(workerModel: string, task: string): string {
  return `${PROXY_THINKING_TEMPLATE.replaceAll('<worker_model>', workerModel)}\n\n本次任务：\n${task}`
}
