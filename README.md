<p align="center">
  <h1 align="center">dsh-plugin-roundtable 圆桌会议</h1>
  <p align="center">把一个 DeepSeek Harness 会话，变成一场可视化、可辩论、可拍板的圆桌会议。</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness 插件">
  <img src="https://img.shields.io/badge/version-v0.2.2-blue" alt="v0.2.2">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license">
</p>

<!-- 主图占位：把「圆桌会议」Tab 截图放到 docs/screenshot.png 后启用下面这行 -->
<!-- <p align="center"><img src="docs/screenshot.png" alt="圆桌会议拓扑图" width="720"></p> -->

## 一句话

> 你只负责抛出议题。DeepSeek 成为主持人，在拓扑图上拉起一圈专家节点，用带箭头的连线组织协作，经过汇聚网关汇总，遇到分歧时把决策权交还给你。

## 特性

### 会议组织
| 能力 | 说明 |
| --- | --- |
| **左主持 + 右圆桌拓扑** | 会话视图新增「圆桌会议」Tab：左侧主持人锚点、右侧环形专家节点、中央汇聚网关，连线带方向箭头，开会过程全程可视化。 |
| **持久子代理专家** | 每位专家都是独立可续聊的子代理，带着《全局协作总纲》（目标 / 角色边界 / 协作协议 / 安全红线）入会，可指定不同厂商模型。 |
| **可视化连线** | 悬停节点拖拽「＋」拉出连线；右键连线切换单向/双向通道或删除；双向通道两端各有一个箭头。 |
| **厂商 Logo 头像** | 专家头像显示真实厂商 Logo（DeepSeek / GLM / z.ai / Gemini / Claude / Kimi / MiniMax / 千问），未收录厂商自动回退为"品牌色块 + 缩写"。logo 图片可自行替换 `src/client/assets/logos/` 后重跑 `node scripts/generate-logos.mjs` 再构建。 |
| **状态呼吸灯** | 专家工作时节点边缘呼吸灯闪烁——纯 CSS 状态反馈，不消耗任何 Token。 |

### 协作与辩论
| 能力 | 说明 |
| --- | --- |
| **双协作模式 + 红队模式** | 「主持人统筹」一切经由主持人转达；「多模型平等」专家直达互辩，超预算自动闭麦；「针锋相对」专家只对定稿方案挑毛病。设置里切换，平等模式强制要求安全限制。 |
| **汇聚网关** | 所有发言经过确定性结构化归并，主持人一键拉取摘要，上下文不被十份报告淹没。 |
| **代理思考** | 黑盒干活模型（视频/图片生成等）也有透明思考链：导演模型先写 `[DeepSeek 代理思考]` 再翻译参数，UI 全程标注 `[渲染中]`。 |
| **人类决策卡片** | 专家分歧或需要拍板时，主持人发起决策、会议暂停，你来选方案 A / B 或自定义输入。 |

### 针锋相对评审
| 能力 | 说明 |
| --- | --- |
| **评审全流程** | 定稿方案 → `roundtable_start_review` 记录"问题 + 方案"（首轮 reviewPass=1）→ 拉红队专家（只挑毛病、不给替代方案）→ `roundtable_collect_review` 收集观点 → Web 评审弹窗自动打开。 |
| **逐条三态表态** | 每个观点独立一张卡片，可单独「支持 / 驳回 / 取消」（三态互切，支持可取消）；**驳回必填理由**（C2，无理由拒绝提交，理由计入 user-action 供主持人修订对照）；已认定数只计「支持」，缺陷进入下一轮方案修改。 |
| **观点证据分级** | 拆分时按观点给出证据（C1）：代码/bug 类附**可复现步骤**（`repro`），设计类缺陷附**论证链**（`argument`，不强制伪复现）；观点卡按类型展示证据徽标。 |
| **闭环复审（最多 3 轮）** | 用户表态 + 主持人修订后，`roundtable_finish_review` 结束本轮（落 `done` 并附修订说明）；再开下一轮复审（reviewPass+1，只核对旧缺陷是否修复）。`maxReviewPass=3`（首轮 + 最多复审 2 次），超上限继续须用户显式批准（C3，杜绝无限循环）。 |
| **影响概览** | 评审弹窗顶部显示已认定/已驳回/未表态计数；认定数 ≥ 3 提示"建议重新协商方案"（C4）。 |
| **Markdown 导出** | `roundtable_export_review` 把全部轮次/观点/表态/驳回理由/修订对照导出为一份交付物（C5），可留存或贴入 GitHub issue。 |
| **观点自动拆分** | 专家一条发言自动拆成多条独立观点，每条带维度标签 + 原文引用 + 观点序号 + 证据；拆分 LLM 优先，失败自动降级为本地按「观点 N」段落结构切分（零 token，不会整段糊在一起）。 |

### 成本与状态
| 能力 | 说明 |
| --- | --- |
| **预算熔断** | 轮数与 Token 双预算，超限自动「闭麦」，可补预算继续或汇总收场。 |
| **回答限制** | 专家每轮输出上限（模型 `max_tokens`）+ 每轮最多意见数；专家 prompt 内置简洁约束（只答相关 / 不用假设 / 不举无关例子 / 无修辞）。 |
| **匿名反馈回路** | 会议结束后 1 键有用度询问 + 可选一句"最卡的点"（E1）；匿名聚合到工作区级 `feedback.jsonl`（E3，只记模式/模型/轮数/Token/时间戳 + 用户主动填写内容，绝不记对话），设置页可查看/一键清空/关闭（E4）。 |
| **持久化** | 会议状态落盘于 `<workspace>/.roundtable/<meetingId>/`（meeting.json + transcript.jsonl + review.json + user-actions.jsonl），重启后可恢复拓扑与历史。 |

### 界面操作
| 能力 | 说明 |
| --- | --- |
| **专家管理界面** | 右栏「＋」直接加/删专家、从模型下拉选厂商；改动记入 `user-actions.jsonl`，主持人下一轮自动执行，UI 与主持人认知同步。 |
| **知识库（阅览版）** | 填一个文件夹路径即列出文件与格式；专家需要资料时由主持人按需读取转交，不整库搬运，避免 Token 双倍消耗。 |
| **会议删除** | 右栏一键删除会议（确认弹窗 + 磁盘彻底删除 + 连带清理专家子代理）。 |
| **互通开关** | 设置里可只显示当前对话开的会议，或查看工作区全部会议。 |

## 安装（一分钟）

> [!NOTE]
> 需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**0.1.2-rc.1+**；v0.2.1 起适配 0.1.2-rc.1 的 Cordis 4.0.2 / dsh 客户端架构，不再兼容 0.1.1-rc.2）。

**最快（npm，需要已 `npm login`）**：

```sh
dsh plugin --profile web add @huanlin/dsh-plugin-roundtable
```

或**从源码构建**（修改源码后重新 `pnpm build`，本地安装继续链接当前目录）：

```sh
git clone https://github.com/9931666/dsh-plugin-roundtable
cd dsh-plugin-roundtable
pnpm install
pnpm build
dsh plugin --profile web add .
```

装完**重启 DSH**（关窗口 → 重新启动）→ 刷新 Web UI → 设置 → 圆桌会议能读出默认值即可。

**从 0.1.1-rc.2 / 旧版升级**：宿主必须先升到 0.1.2-rc.1+；直接装 v0.2.2 覆盖旧插件，重启 DSH。历史会议记录（`.roundtable/`）跨大版本兼容性不保证，重要会议先导出。

### npm 安装方式（等价，供脚本化）

```sh
dsh plugin --profile web add @huanlin/dsh-plugin-roundtable
```

安装后重启 DSH、刷新 Web UI。然后在对话里直接用自然语言开会：

> 开个圆桌会议，评审 v0.5 的架构方案，从性能、安全、成本三个角度各安排一位专家，最后给我一份汇总报告。

或指定平等辩论模式：

> 用多模型平等模式开一场辩论会，议题是「单体 vs 微服务」，每位专家可以互相反驳，最多 3 轮，最后让我拍板。

或发起红队评审：

> 方案已定稿，开个针锋相对评审，拉两位红队专家专门挑毛病。

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
| **反馈开关** | 开 | 会议结束后是否询问 1 键有用度（关闭即永久不再弹） |

## 工具一览（模型可见协议）

| 工具 | 作用 |
| --- | --- |
| `roundtable_create` | 建会，调用者成为主持人 |
| `roundtable_add_node` / `remove_node` | 增删专家节点（可续聊子代理 + 总纲 persona） |
| `roundtable_connect` / `disconnect` | 建/删连线（单向 / 双向） |
| `roundtable_speak` | 发言写入会议记录（可定向，不填交网关） |
| `roundtable_send_message` | 直达消息（平等模式专家互辩） |
| `roundtable_summarize` | 拉取汇聚网关结构化摘要 |
| `roundtable_request_decision` | 暂停会议、请求人类决策 |
| `roundtable_status` | 会议全景（节点活动、连线、预算、待决策、待办行为记录） |
| `roundtable_actions_clear` | 清空用户的待办行为记录（UI 改专家后主持人执行完清空） |
| `roundtable_set_budget` | 调整预算 / 闭麦恢复 |
| `roundtable_proxy_think` | 代理思考：导演为黑盒模型做思考铺垫 + 参数翻译 |
| `roundtable_start_review` | 发起针锋相对评审：记录用户问题与主持人方案（首轮 reviewPass=1；上一轮 done 后再调 = 新一轮复审，需不超过 maxReviewPass=3，超上限须 `user_approved_extra_pass=true`） |
| `roundtable_collect_review` | 收集红队专家发言为观点（LLM 拆分含证据分级，失败本地兜底），打开评审弹窗 |
| `roundtable_finish_review` | 结束本轮评审（→ done），附修订说明；闭环复审由此进入下一轮 |
| `roundtable_export_review` | 导出完整评审记录（多轮/观点/表态/驳回理由/修订对照）为 Markdown 交付物 |
| `roundtable_close` | 结束会议（记录保留） |

## 使用边界与注意事项

- **一个主持人同一时间只能带一场活动会议**：新开会前先 `roundtable_close`。
- **专家是回合制子代理**：消息唤醒 → 干一整轮 → 空闲；「辩论」是消息驱动的异步轮流对话，不是实时并发。
- **子代理的最终回复不可被程序直接读取**：专家必须通过 `roundtable_speak` 把产出写入会议记录，汇聚网关与主持人从记录读取。这是协议约束，不是 bug。
- **人类决策依赖 `userQuestions` 服务**（标准 Web profile 自带）；其他 profile 若无此服务，决策功能不可用。
- **状态为文件级持久化**：单 DSH 进程内串行操作；**多进程同时改同一会议不保证一致**，请勿在多个 DSH 实例中开同一场会。
- **删会议 = 删整个 `.roundtable/<id>/` 目录**：不可恢复，删除前确认。
- **第三方模型要显式指定**：拉取 zai / GLM 等厂商专家时，在 UI 下拉或消息中说明 provider/model（如 `zai/glm-5.2`），否则可能路由失败或模型不符。

### 已知限制（迭代中）

| 限制 | 影响 | 现状 |
| --- | --- | --- |
| 评审 RPC 权限为「状态机 + 会议归属」校验 | 同进程内其他 Session 理论上可持会议 id 调用评审写接口，跨 Session 越权防护不完整 | 已记录为安全项，待 connection 能力扩展后补 session 校验；单人使用无感 |
| `user-actions` 清空操作非原子 | 进程恰好在清空时崩溃，可能残留半行 JSON，导致下轮待办解析异常 | 低成本修复已提前排期 |
| Host 侧并发写竞态 | 插件生命周期事件（stop/dispose）与会议文件写操作并发时，理论上可能交错写入/丢行 | 已知风险暂缓；正常使用基本不会触发 |

## 评审与反馈设计（v0.2.2）

- **闭环复审**：`maxReviewPass=3`（首轮 + 最多 2 次复审）。每轮用户表态后主持人修订方案并 `roundtable_finish_review`（附修订说明）；复审只核对上一轮已认定缺陷是否修复。想突破 3 轮上限，必须用户显式同意（工具参数 `user_approved_extra_pass=true`），否则拒绝——防无限循环。
- **驳回必填理由**：前端驳回会先要求填理由；留空会失败。理由随 user-action 回传给主持人，修订方案时可逐条回应"为何驳回"。
- **反馈隐私边界**：`feedback.jsonl` 仅含协作模式、专家 provider/模型、轮数/Token、时间戳与用户主动填写的说明，**不含任何对话/发言内容**；建议把该文件加入工作区 `.gitignore`；设置页可随时一键清空或关闭询问。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
node scripts/generate-logos.mjs   # 替换 src/client/assets/logos/ 下图片后重跑，再 pnpm build
```

## 许可证

[MIT](./LICENSE)
