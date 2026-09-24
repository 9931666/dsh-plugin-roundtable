<p align="center">
  <h1 align="center">dsh-plugin-roundtable 圆桌会议</h1>
  <p align="center">把一个 DeepSeek Harness 会话，变成一场可视化、可辩论、可拍板的圆桌会议。</p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness 插件">
  <img src="https://img.shields.io/badge/version-v1.0.0--rc.1-blue" alt="v1.0.0-rc.1">
  <img src="https://img.shields.io/badge/host-0.1.5--rc.3-202724" alt="Harness 0.1.5-rc.3">
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
| **预算熔断** | 轮数与 Token 双预算，超限自动「闭麦」，可补预算继续或汇总收场。⚠️ **Token 数是「发言文本量」的粗估**（中文约 0.6 token/字），**不含** system prompt、专家 persona、历史上下文与工具调用开销，**不等于真实账单**——把它当"说了多少"的刻度，而不是成本表。 |
| **回答限制** | 专家每轮输出上限（模型 `max_tokens`）+ 每轮最多意见数；专家 prompt 内置简洁约束（只答相关 / 不用假设 / 不举无关例子 / 无修辞）。 |
| **匿名反馈回路** | 会议结束后 1 键有用度询问 + 可选一句"最卡的点"（E1）；匿名聚合到工作区级 `feedback.jsonl`（E3，只记模式/模型/轮数/Token/时间戳 + 用户主动填写内容，绝不记对话），设置页可查看/一键清空/关闭（E4）。 |
| **知识库摘要缓存** | 主持人读过的 KB 文件按 `path + size + mtimeMs` 记下要点摘要（`kb-digest.json`）；`roundtable_status` 直接标 `[HIT]` / `[STALE]`，命中的不必重读——省掉"主持人读一遍 + 专家读一遍"的双倍 token。缓存本身不耗模型 token，超 50 条按最旧淘汰。 |
| **持久化** | 会议状态落盘于 `<workspace>/.roundtable/<meetingId>/`（meeting.json + transcript.jsonl + review.json + user-actions.jsonl + kb-digest.json），重启后可恢复拓扑与历史；`roundtable_export_meeting` 另写一份 export.md。 |

### 会议设置确认与 Skill 接入（v0.2.31）
| 能力 | 说明 |
| --- | --- |
| **开会前先确认设置** | 每次开会（哪怕只有一位专家）都会先弹一张**设置卡片**：专家名单 + 协作模式 + 轮数/Token 预算 + 知识库 + 选中 skill。主持人只出草案，**确认后才创建会议**。 |
| **卡片上即可初次修改** | 选「我要修改」并在输入框写明改动（例："把 reviewer 换成 zai-coding-cn/glm-5.2、预算降到 5 轮"），主持人更新草案后**再弹一次**；每轮都标注"已按你的意见更新"。 |
| **skill 选择** | 卡片上的 skill 清单来自 DSH 原生 `ctx.skills`（目录发现，非插件自造）。把 skill 放进 `<工作区>/.dsh/skills/`、`<工作区>/.agents/skills/` 或 `<DSH_HOME>/skills/` 即出现在清单里；会议选中后记录到会议状态，右栏「已选 skill」面板可查。 |
| **两种传递方式** | 设置页可切换：**主持人中转**（主持人读正文、按需转交，省 token、行为可预测）或**专家直接调用**（专家自己用原生 `skill` 工具加载，更自主、但各自读取一遍）。会议创建时固化该选择，专家 persona 会被告知可用 skill 清单与使用方式。 |

### 角色预设、整场导出与摘要缓存（v0.2.35）
| 能力 | 说明 |
| --- | --- |
| **自建角色预设** | 设置 → 圆桌会议 → 「角色预设」自己建模板（名称 + 角色说明必填，模型可选 = 继承主持人），支持新建 / 编辑 / 删除。**插件不预置任何内置角色**；预设是全局偏好，改动不影响已创建的会议。 |
| **整场会议导出** | `roundtable_export_meeting` 把会议整体（元数据头 / 议题 / 专家名单 / 决策记录 / 逐轮发言 / 评审记录 / 用户调整记录）渲染成 Markdown，**同时写入 `<meetingDir>/export.md`**，可直接留存或贴进 issue；进行中的会议也能导（头部标「进行中快照」）。 |
| **版本号单一来源** | 导出头部统一读 `src/version.ts` 的 `PLUGIN_VERSION`——此前评审导出头部硬编码的 `v0.2.21` 已经写进过交付物；`test/version.test.mjs` 会在它与 `package.json` 不一致时直接失败。 |
| **统一原子写** | `user-actions.jsonl` / `feedback.jsonl` 的写入与清空改走同一套"同目录 tmp + rename"原子写，并与 UI 追加共用一把串行锁；清空时若发现坏行会**返回 `malformed` 计数**，主持人必须如实告知用户，不再静默丢操作。 |

### 界面可靠性修复（v0.2.36）
| 修复 | 说明 |
| --- | --- |
| **页签/设置页不再整体消失** | 插件曾把**可选**能力写进 cordis 的 `inject`——而 `inject` 是加载门禁（没有"可选注入"这种形式），缺一个服务就整个插件不加载：工具、数据路由、GUI 页签、设置页一起消失且**不报错**。现已收敛为真正必需的服务，可选能力（skill 目录、用户问答、connection 兜底传输）改为运行时 `ctx.get(...)` 可选读取。**宿主侧改动需重启 DSH 生效。** |
| **崩溃不再无声无息** | DSH 会静默摘掉渲染抛错的 slot 条目（隔离正确，但用户只看到"页签不见了"）。两个界面入口现在都包在错误边界里：崩溃渲染成可读报错面板 + 控制台完整堆栈，可直接贴 issue。**客户端改动刷新页面即生效。** |
| **防回归闸门** | `test/inject.test.mjs` 直接对**构建产物**断言上述两条不变量（含"没有 connection 服务时仍必须注册两个入口"），旧产物必然失败。 |

### 界面操作
| 能力 | 说明 |
| --- | --- |
| **专家管理界面** | 右栏「＋」直接加/删专家、从模型下拉选厂商；改动记入 `user-actions.jsonl`，主持人下一轮自动执行，UI 与主持人认知同步。 |
| **角色预设一键填充** | 专家管理表单顶部多了一个「角色预设」下拉：选中即自动填好角色说明与 provider/model（专家 key 仍由你填）。预设为空时给出"去设置页新建"的指引。 |
| **右栏面板显示开关** | 设置 → 圆桌会议 → 「右栏面板显示」：**点亮的圆圈 = 显示、暗掉的 = 隐藏**（专家 / 分工 / 知识库 / 已选 skill / 发言记录 / 分针记录 / 产出文件）。关掉不常看的面板，右栏立刻变短（拓扑页本身不放提示框，保持工整）。 |
| **知识库（阅览版）** | 填一个文件夹路径即列出文件与格式；专家需要资料时由主持人按需读取转交，不整库搬运，避免 Token 双倍消耗。 |
| **会议删除** | 右栏一键删除会议（确认弹窗 + 磁盘彻底删除 + 连带清理专家子代理）。 |
| **互通开关** | 设置里可只显示当前对话开的会议，或查看工作区全部会议。 |

## 安装（一分钟）

> [!NOTE]
> 需要已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（**0.1.5-rc.2+**；v0.2.36 按 0.1.5-rc.2 宿主复核（对应 `@deepseek-ai/*` 0.1.5-rc.2 包），v0.2.31 起按 0.1.5-rc.1 复核，v0.2.1 起即适配 Cordis 4.0.2 / dsh 客户端架构，不再兼容 0.1.1-rc.2）。宿主 `alpha` 线的 0.1.6-alpha.2 尚未适配。

> [!IMPORTANT]
> **本插件不发布到 npm。** 作者因**个人原因无法注册 npm 账户**（拿不到 `@huanlin` scope），
> registry 上并不存在这个包，`dsh plugin add <包名>` 这条路走不通。
> **从源码安装是唯一方式**（见下）。`package.json` 里的 `name` / `publishConfig` 只是仓库内的元数据。

**从源码构建**（修改源码后重新 `pnpm build`，本地安装继续链接当前目录）：

```sh
git clone https://github.com/9931666/dsh-plugin-roundtable
cd dsh-plugin-roundtable
pnpm install
pnpm build
dsh plugin --profile web add .
```

装完**重启 DSH**（关窗口 → 重新启动）→ 刷新 Web UI → 设置 → 圆桌会议能读出默认值即可。

**从 0.1.1-rc.2 / 旧版升级**：宿主必须先升到 0.1.5-rc.1+；直接装 v0.2.31 覆盖旧插件，重启 DSH。历史会议记录（`.roundtable/`）跨大版本兼容性不保证，重要会议先导出。

### 更新到最新版

```sh
git pull && pnpm build
```

插件以 `link:` 挂在本地目录上，重建后**重启 DSH** 即可。刷新 Web UI 后，直接在对话里用自然语言开会：

> 开个圆桌会议，评审 v0.5 的架构方案，从性能、安全、成本三个角度各安排一位专家，最后给我一份汇总报告。

或指定平等辩论模式：

> 用多模型平等模式开一场辩论会，议题是「单体 vs 微服务」，每位专家可以互相反驳，最多 3 轮，最后让我拍板。

或发起红队评审：

> 方案已定稿，开个针锋相对评审，拉两位红队专家专门挑毛病。

## 使用界面

- **聊天**：自然语言直接触发即可（例：「开个圆桌会议讨论 X」「让几个专家辩论 Y」「用 RoundTable 决定 Z」）。**本插件不提供 `/roundtable` 斜杠命令**——V1 规格书里列过这个入口，但从未实现，本版明确不做，也不再承诺。
- **「圆桌会议」Tab**：会话视图顶部切换，实时拓扑图 + 预算进度 + 网关摘要；拖拽连线、右键改通道方向。
- **设置页**：设置 → 圆桌会议，配置默认协作模式、预算默认值、专家回答限制、skill 传递方式、右栏面板显示与**自建角色预设**。

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
| **skill 传递方式** | 主持人中转 `relay` | skill 由主持人读后转交 / 专家自行用 `skill` 工具加载（`direct`） |

## 工具一览（模型可见协议）

| 工具 | 作用 |
| --- | --- |
| `roundtable_plan_meeting` | **开会第一步**：出会议草案卡片（专家名单 + 全部参数 + 选中 skill），阻塞等用户确认；返回 `approved`（按此创建）/ `revise`（附用户意见，改完再弹）。**不创建会议**。 |
| `roundtable_create` | 建会，调用者成为主持人（v0.2.31 起支持 `kb_path` / `skills` / `skill_delivery`，按卡片确认值创建） |
| `roundtable_add_node` / `remove_node` | 增删专家节点（可续聊子代理 + 总纲 persona）；`add_node` 可选 `reasoning_effort`（取值由模型能力定义，不传即继承主持人） |
| `roundtable_connect` / `disconnect` | 建/删连线（单向 / 双向） |
| `roundtable_speak` | 发言写入会议记录（可定向，不填交网关） |
| `roundtable_send_message` | 直达消息（平等模式专家互辩） |
| `roundtable_summarize` | 拉取汇聚网关结构化摘要 |
| `roundtable_request_decision` | 暂停会议、请求人类决策 |
| `roundtable_status` | 会议全景（节点活动、连线、预算、待决策、待办行为记录、**知识库缓存命中/失效**） |
| `roundtable_actions_clear` | 清空用户的待办行为记录（UI 改专家后主持人执行完清空）；返回 `{cleared, malformed}`，`malformed > 0` 表示有操作因坏行丢失、必须告知用户 |
| `roundtable_set_budget` | 调整预算 / 闭麦恢复 |
| `roundtable_proxy_think` | 代理思考：导演为黑盒模型做思考铺垫 + 参数翻译 |
| `roundtable_start_review` | 发起针锋相对评审：记录用户问题与主持人方案（首轮 reviewPass=1；上一轮 done 后再调 = 新一轮复审，需不超过 maxReviewPass=3，超上限须 `user_approved_extra_pass=true`） |
| `roundtable_collect_review` | 收集红队专家发言为观点（LLM 拆分含证据分级，失败本地兜底），打开评审弹窗 |
| `roundtable_finish_review` | 结束本轮评审（→ done），附修订说明；闭环复审由此进入下一轮 |
| `roundtable_export_review` | 导出完整评审记录（多轮/观点/表态/驳回理由/修订对照）为 Markdown 交付物 |
| `roundtable_export_meeting` | 导出**整场会议**（元数据头/议题/专家/决策/逐轮发言/评审/用户调整）为 Markdown，并写入 `<meetingDir>/export.md`（传 `save: false` 只取文本） |
| `roundtable_kb_digest` | 记下某个知识库文件的要点摘要（插件自己 `stat` 出 `size`/`mtime` 作失效键）；下次 `roundtable_status` 显示 `[HIT]` 即可复用而不重读 |
| `roundtable_close` | 结束会议（记录保留） |

## 使用边界与注意事项

- **一个主持人同一时间只能带一场活动会议**：新开会前先 `roundtable_close`。
- **专家是回合制子代理**：消息唤醒 → 干一整轮 → 空闲；「辩论」是消息驱动的异步轮流对话，不是实时并发。
- **子代理的最终回复不可被程序直接读取**：专家必须通过 `roundtable_speak` 把产出写入会议记录，汇聚网关与主持人从记录读取。这是协议约束，不是 bug。
- **设置卡片没有富表单**：原生 `userQuestions` 只有「选项列表 + 一个自由文本框」，所以"可改全部"是靠**自由文本 + 回流重建**实现的（写明改动 → 主持人重出草案再确认），而不是点选式表单；点选式编辑面板属后续版本。
- **skill 由 DSH 原生发现**：插件不做导入动作，只读 `ctx.skills` 清单与正文；导入 = 把 skill 文件放进官方目录。若宿主未挂载 skill 服务，卡片上的清单为空、`direct` 模式自动降级为"不要调用 `skill` 工具"，插件本身照常工作。
- **会议已选 skill 在创建时固化**：会议中途无法改会议的 skill 清单；需要新资料时走 `relay` 路径由主持人转交。
- **人类决策依赖 `userQuestions` 服务**（标准 Web profile 自带）；其他 profile 若无此服务，决策功能不可用，设置卡片会返回 `decision="unavailable"` 让主持人改用文字确认。
- **状态为文件级持久化**：单 DSH 进程内串行操作；**多进程同时改同一会议不保证一致**，请勿在多个 DSH 实例中开同一场会。
- **删会议 = 删整个 `.roundtable/<id>/` 目录**：不可恢复，删除前确认。
- **第三方模型要显式指定**：拉取 zai / GLM 等厂商专家时，在 UI 下拉或消息中说明 provider/model（如 `zai/glm-5.2`），否则可能路由失败或模型不符。

### 已知限制（迭代中）

| 限制 | 影响 | 现状 |
| --- | --- | --- |
| **跨 Session 越权（A1）** | RPC 通道（`connection` 与插件自有 web 路由）**不暴露调用者的 session 身份**，因此同进程内其他会话只要知道会议 id，理论上就能调用该会议的读写端点（改连线、改知识库路径、评审表态、专家增删队列）。现有防线是「会议归属校验 + 状态机校验」，**不是身份校验**。 | **本版接受现状**：单人 / 单工作区使用无实际影响。多人共用同一 DSH 实例、或不信任同实例其他会话时，请把该实例视为同一信任域。彻底收紧需要宿主 `connection` 暴露调用者身份，属后续版本。 |
| Host 侧并发写竞态 | 插件生命周期事件（stop/dispose）与会议文件写操作并发时，理论上可能交错写入 / 丢行 | 已知风险暂缓；单进程内的会议级写操作已由 `withMeetingLock` 串行化，正常使用基本不会触发 |

> **v0.2.35 已修复**（原「已知限制」条目）：`user-actions` 的清空原先是非原子的直接截断——崩溃或与 UI 追加交错时可能留下半行 JSON，而读取侧**静默跳过**，那条用户操作就永久消失且无人知道。现在追加与清空共用一把串行锁、都走「同目录 tmp + rename」的原子写；清空时若确实读到坏行，会通过返回值 `malformed` 暴露出来，主持人必须如实告知用户。

## 评审与反馈设计（v0.2.2）

- **闭环复审**：`maxReviewPass=3`（首轮 + 最多 2 次复审）。每轮用户表态后主持人修订方案并 `roundtable_finish_review`（附修订说明）；复审只核对上一轮已认定缺陷是否修复。想突破 3 轮上限，必须用户显式同意（工具参数 `user_approved_extra_pass=true`），否则拒绝——防无限循环。
- **驳回必填理由**：前端驳回会先要求填理由；留空会失败。理由随 user-action 回传给主持人，修订方案时可逐条回应"为何驳回"。
- **反馈隐私边界**：`feedback.jsonl` 仅含协作模式、专家 provider/模型、轮数/Token、时间戳与用户主动填写的说明，**不含任何对话/发言内容**；建议把该文件加入工作区 `.gitignore`；设置页可随时一键清空或关闭询问。

## 开发

```sh
pnpm install
pnpm typecheck    # 双端 tsc：host（tsconfig.json）+ client（tsconfig.client.json）
pnpm test         # 零依赖 node --test：Node 24 原生剥离类型，直接 import src/*.ts
pnpm build        # typecheck + tsdown（lib/index.js + lib/client.js）+ 双端 .d.ts
pnpm test:inline  # 同上，但测试在同一进程内跑（不 spawn 子进程 / 不占用管道）
node scripts/generate-logos.mjs   # 替换 src/client/assets/logos/ 下图片后重跑，再 pnpm build
```

> `pnpm test` 用的是 Node 标准测试运行器（每个测试文件一个子进程）。在**禁止子进程管道**的环境里（例如 DSH 自带沙箱）它会以 `spawn EPERM` 失败——那是环境限制，不是测试失败；改用 `pnpm test:inline` 即可（需要 Node ≥ 22.8）。

### 工程门禁（v1.0.0-rc.1 新增）

```sh
pnpm compatibility   # 宿主支持矩阵一致性：矩阵 / devDeps / peer / 源码能力清单
pnpm verify:package  # 发布门禁：files、入口文件、.ts 残留、每个模块在产物里有痕迹
pnpm doctor          # 只读诊断：宿主与插件版本、混装、cordis 实例同一性
pnpm release         # 发布护栏：渠道判定、防 latest 倒退、产物 SHA-256（不自动发布）
pnpm publish:guard   # 上面三项串起来跑一遍，全绿才算可发（渠道是 GitHub，不发 npm）
```

**宿主基线是唯一真话**：`compatibility.json` 的 `recommendedHost` 决定
`package.json` 的 devDependencies 该指向哪一版——它决定使用者 `pnpm install`
之后拿到哪一版**类型**。改基线时四处一起改，`pnpm compatibility` 会替你验证。

**宿主升级后的固定动作**（详见 [`docs/host-contract.md`](docs/host-contract.md)）：

1. 改 `compatibility.json` 的 `recommendedHost` 与 `package.json` 的
   `roundtable.hostBaseline`；
2. 同步 devDependencies 到该版本，`pnpm install`；
3. `pnpm typecheck && pnpm test`；
4. `pnpm doctor` —— **先看混装与 cordis 同一性**，再怀疑 API 破坏；
5. `pnpm compatibility && pnpm verify:package`；
6. 重建 `lib/`；**宿主半体的改动需要重启 DSH**。

> ⚠️ **cordis 必须是同一个物理副本**。宿主与插件各带一份 `@deepseek-ai/cordis`
> 时，TypeScript 会当成两个模块，`declare module` 的 Context 声明合并失效，
> 表现为编译期大片 `Property 'subagents' does not exist on type 'Context'`。
> 这**不是** API 破坏——`pnpm doctor` 会直接告诉你是不是混装。

### 发布（只发 GitHub，不发 npm）

> **本插件的发行渠道是 GitHub，不是 npm。** 作者个人原因无法注册 npm 账户，
> 没有 registry 可发；下面的工程门禁依然全部有效，只是最后一步换成打 tag。

```sh
pnpm build && pnpm publish:guard                     # 全绿才算可发
git tag v<version> && git push origin v<version>     # GitHub Release 的触发点
```

- `scripts/release.mjs` 只做**产物快照**：渠道判定、防 latest 倒退、产物 SHA-256
  与候选 `.tgz`（写到 `.git/pack-preview/`）。它**不调用 npm，也不会替你发布**。
- 用户端安装方式恒为**源码 / GitHub**（见上文「安装」）——
  registry 上不存在 `@huanlin/dsh-plugin-roundtable`，历史文档里出现的该命令一律不可用。
- 本机若 `pnpm install` 报 `ERR_SQLITE_ERROR / unable to open database file`，
  那是 pnpm store 数据库不可用（不是依赖问题）：换一个可写的 store 路径，
  或在能跑 pnpm 的机器上重装后同步 `node_modules`。此状态下也可以直接运行
  `scripts/*.mjs`（它们不依赖 pnpm）。

## 许可证

[MIT](./LICENSE)
