<p align="center">
  <h1 align="center">dsh-plugin-roundtable 圆桌会议</h1>
  <p align="center">把一个 DeepSeek Harness 会话，变成一场可视化、可辩论、可拍板的圆桌会议。</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness 插件">
  <img src="https://img.shields.io/badge/version-v0.2.0-blue" alt="v0.2.0">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license">
</p>

<!-- 主图占位：把「圆桌会议」Tab 截图放到 docs/screenshot.png 后启用下面这行 -->
<!-- <p align="center"><img src="docs/screenshot.png" alt="圆桌会议拓扑图" width="720"></p> -->

## 一句话

> 你只负责抛出议题。DeepSeek 成为主持人，在拓扑图上拉起一圈专家节点，用带箭头的连线组织协作，经过汇聚网关汇总，遇到分歧时把决策权交还给你。

## 特性

| 能力 | 说明 |
| --- | --- |
| **左主持 + 右圆桌拓扑** | 会话视图新增「圆桌会议」Tab：左侧主持人锚点、右侧环形专家节点、中央汇聚网关，连线带方向箭头。 |
| **双协作模式** | 「主持人统筹」一切经由主持人转达；「多模型平等」专家直达互辩，超预算自动闭麦。设置里切换，模式 B 强制要求安全限制。 |
| **可视化连线** | 悬停节点拖拽「+」即可拉出连线；右键连线可切换单向/双向通道、删除连线；双向通道两端各有一个箭头。 |
| **状态呼吸灯** | 专家工作时节点边缘呼吸灯闪烁——纯 CSS 状态反馈，不消耗任何 Token。 |
| **汇聚网关** | 所有发言经过确定性结构化归并，主持人一键拉取摘要，上下文不被十份报告淹没。 |
| **代理思考** | 黑盒干活模型（视频/图片生成等）也有透明思考链：导演模型先写 `[DeepSeek 代理思考]` 再翻译参数，UI 全程标注 `[渲染中]`。 |
| **人类决策卡片** | 专家分歧或需要拍板时，主持人发起决策、会议暂停，你来选方案 A / B 或自定义输入。 |
| **预算熔断** | 轮数与 Token 双预算，超限自动「闭麦」，可补预算继续或汇总收场。 |
| **全局协作总纲** | 会议启动即注入四段式《全局协作总纲》（目标 / 角色边界 / 协作协议 / 安全红线）到每个专家节点。 |
| **持久化** | 会议状态落盘于 `<workspace>/.roundtable/`，重启后可恢复拓扑与历史。 |
| **厂商 Logo 头像**（v0.2.0） | 专家头像显示 DeepSeek / GLM / Gemini / Claude / Kimi / MiniMax 真实 Logo（base64 内联、离线可用），未收录厂商自动回退缩写。 |
| **专家管理界面**（v0.2.0） | 右栏「＋」直接加/删专家、从模型下拉选厂商（DeepSeek / GLM / 千问 / Kimi / MiniMax…）；改动记入 `user-actions.jsonl`，主持人下一轮自动执行，UI 与主持人认知同步。 |
| **知识库（阅览版）**（v0.2.0） | 填一个文件夹路径即列出文件与格式；专家需要资料时由主持人按需读取转交，不整库搬运，避免 Token 双倍消耗。 |
| **回答限制**（v0.2.0） | 专家每轮输出上限（模型 `max_tokens`）+ 每轮最多意见数；专家 prompt 内置简洁约束（只答相关 / 不用假设 / 不举无关例子 / 无修辞）。 |
| **会议删除**（v0.2.0） | 右栏一键删除会议（确认弹窗 + 磁盘彻底删除 + 连带清理专家子代理）。 |
| **互通开关**（v0.2.0） | 设置里可只显示当前对话开的会议，或查看工作区全部会议。 |
| **针锋相对评审**（v0.2.1） | 用户与主持人定下方案后，主持人可发起「针锋相对」：红队专家只对方案挑毛病，弹窗左=问题+方案、右=观点列表，你点「支持」认定真实缺陷，缺陷进入下一轮方案修改。 |
| **观点拆分 + 三态表态**（v0.2.2） | 专家发言自动拆成独立观点行（LLM 拆分、失败整条兜底、引用原文 quote）；每个观点支持/驳回/取消三态互切，已认定数只计「支持」。 |
| **「针锋相对」协作模式**（v0.2.2） | 设置「默认协作模式」新增第三项：以红队评审为主线的会议，charter 自动附加针锋相对协议。 |

## 安装

> [!NOTE]
> 需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（0.1.1-rc.2+）。

### 从源码构建

```sh
git clone <你的仓库地址> dsh-plugin-roundtable
cd dsh-plugin-roundtable
pnpm install
pnpm build
dsh plugin --profile web add .
```

修改源码后重新执行 `pnpm build`，本地安装会继续链接当前目录。

### npm

```sh
dsh plugin --profile web add @huanlin/dsh-plugin-roundtable
```

安装后重启 DSH、刷新 Web UI。然后在对话里直接用自然语言开会：

> 开个圆桌会议，评审 v0.5 的架构方案，从性能、安全、成本三个角度各安排一位专家，最后给我一份汇总报告。

或指定平等辩论模式：

> 用多模型平等模式开一场辩论会，议题是「单体 vs 微服务」，每位专家可以互相反驳，最多 3 轮，最后让我拍板。

## 使用界面

- **聊天**：`/roundtable 议题…` 或自然语言直接触发（详见下节命令）。
- **「圆桌会议」Tab**：会话视图顶部切换，实时拓扑图 + 预算进度 + 网关摘要；拖拽连线、右键改通道方向。
- **设置页**：设置 → 圆桌会议，配置默认协作模式与预算默认值。

## 协作模式

| | 主持人统筹 `orchestrated` | 多模型平等 `egalitarian` | 针锋相对 `redteam` |
| --- | --- | --- | --- |
| 主持人角色 | 决定谁发言、转达观点、语义仲裁 | 退居发牌 + 计时 + 裁判 | 记录议题与方案、收集红队观点 |
| 专家之间 | 都经由主持人 | 直达消息互相辩论 | 都经由主持人 |
| 连线含义 | 协作关系声明 | 允许互发消息的通道 | 协作关系声明 |
| 终止方式 | 主持人判断完成 | 轮数 / Token 预算超限自动闭麦 | 主持人判断完成 |

选择「多模型平等」时，界面会弹出安全限制设置（最大轮数、最大 Token 量），超限即闭麦暂停。选择「针锋相对」时，charter 自动附加红队评审协议（只挑毛病、不给替代方案）。

## 配置

默认配置开箱即用。Profile 可覆盖：

```yaml
- id: roundtable
  config:
    stateDir: .roundtable        # 会议状态目录（工作区下）
    memberProvider: spawn        # 专家节点子代理后端（spawn / fork）
    maxNodes: 8                  # 单场会议专家上限
    defaultMode: orchestrated    # 默认协作模式
    memberMaxDepth: 1            # 专家再委派深度上限
    promptSectionOrder: 116      # 使用策略提示段顺序
```

运行时偏好（默认模式与预算默认值、专家回答限制）在「设置 → 圆桌会议」中修改，持久化到 `settings.yaml`：

| 偏好 | 默认 | 说明 |
| --- | --- | --- |
| 默认协作模式 | `orchestrated` | 主持人统筹 / 多模型平等 / 针锋相对 |
| 最大轮数 / 最大 Token | 10 / 200000 | 会议预算，超限闭麦 |
| 互通开关 | 开 | 只看当前对话会议 / 看全部 |
| **专家每轮输出上限（token）** | 0（不限制） | 专家组模型 `max_tokens` |
| **专家每轮最多意见数** | 0（不限制） | 专家 prompt 约束 |

## 工具一览（模型可见协议）

| 工具 | 作用 |
| --- | --- |
| `roundtable_create` | 建会，调用者成为主持人 |
| `roundtable_add_node` / `remove_node` | 增删专家节点（可续聊子代理 + 总纲 persona） |
| `roundtable_connect` / `disconnect` | 建/删连线（单向 / 双向） |
| `roundtable_speak` | 发言写入会议记录（可定向，不填交网关） |
| `roundtable_send_message` | 直达消息（模式 B 专家互辩） |
| `roundtable_summarize` | 拉取汇聚网关结构化摘要 |
| `roundtable_request_decision` | 暂停会议、请求人类决策 |
| `roundtable_status` | 会议全景（节点活动、连线、预算、待决策、待办行为记录） |
| `roundtable_actions_clear` | 清空用户的待办行为记录（UI 改专家后主持人执行完清空） |
| `roundtable_set_budget` | 调整预算 / 闭麦恢复 |
| `roundtable_proxy_think` | 代理思考：导演为黑盒模型做思考铺垫 + 参数翻译 |
| `roundtable_start_review` | 发起针锋相对评审：记录用户问题与主持人方案 |
| `roundtable_collect_review` | 收集红队专家发言为观点（LLM 拆分，失败整条兜底），打开评审弹窗 |
| `roundtable_close` | 结束会议（记录保留） |

## 使用边界

- 一个主持人同一时间只能带一场活动会议。
- 专家是回合制子代理：消息唤醒 → 干一整轮 → 空闲；「辩论」是消息驱动的异步轮流对话。
- 子代理的最终回复不可被程序直接读取：专家必须通过 `roundtable_speak` 把产出写入会议记录，汇聚网关与主持人从记录读取。
- 状态为文件级持久化，单 DSH 进程内串行操作；多进程同时改同一会议不保证一致。
- 人类决策依赖 `userQuestions` 服务（标准 Web profile 自带）。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
```

## 许可证

[MIT](./LICENSE)
