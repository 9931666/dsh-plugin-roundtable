# 宿主契约清单（Host Contract）

> **这份文档的唯一用途**：DSH 每次更新时，你照着它跑一遍，就知道该补什么。
>
> 它回答一个问题——**「这个插件到底依赖宿主的什么？」**
> 在此之前，这个答案散落在 9000 行源码的旁注里，没人在升级时能一眼看全。

---

## 0. 当前版本坐标（每次升级后必须更新这一节）

| 项 | 值 | 核对日期 |
| --- | --- | --- |
| 本机运行的 DSH | **0.1.5-rc.3** | 2026-09-20 |
| 插件 devDependencies | 0.1.5-**rc.2** | — |
| 插件 peerDependencies | ^0.1.5-rc.1 | — |
| `src/version.ts` 的 `HARNESS_RANGE` | `0.1.5-rc.2+` | — |
| 插件版本 | 0.2.36（+ 未提交批次） | — |

### ⚠️ 已确认的漂移（截至本次体检）

**宿主 8 个核心包全部已是 rc.3，而插件的类型声明来自 rc.2：**

| 包 | 宿主实际 | 插件 node_modules |
| --- | --- | --- |
| dsh-agent | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-subagent | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-tools | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-atomic-write | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-client-connection | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-client-ui-conversation | 0.1.5-rc.3 | 0.1.5-rc.2 |
| dsh-client-ui-tool | 0.1.5-rc.3 | **0.1.5-rc.3**（已升） |
| dsh-client-ui-renderer | 0.1.5-rc.3 | 未安装 |

**含义**：当前 `tsc` 是通过的，但它通过的是**对 rc.2 类型的校验**，不是对运行中的 rc.3 的校验。
**风险等级**：中。宿主自己的编译期不会替你发现插件的问题（插件是运行时 `link:` 挂载，不是宿主的一部分）。

---

## 1. 宿主触点总表

用法：升级后逐行核对。"失效时用户看到什么"一栏是本清单的核心价值——它决定了你能否**从用户反馈反推契约问题**。

### 1.1 宿主服务

| 服务 | 干什么用 | 怎么访问 | 源码证据 | 失效时用户看到什么 | rc.3 |
| --- | --- | --- | --- | --- | --- |
| `subagents` | 派发/中断专家子代理 | `ctx.inject` **必需** | `src/index.ts` | 整个插件消失 → 圆桌会议 tab 与设置页都没了，**且没有任何报错** | ⏳未验 |
| `agents` | 中断子代理（父 Agent 离线时的兜底） | `ctx.inject` **必需** | `src/tools.ts` / `rpc.ts` | 同上（load-gating） | ⏳未验 |
| `tools` | 注册 `roundtable_*` 工具 | `ctx.inject` **必需** | `src/tools.ts` | 同上（load-gating） | ⏳未验 |
| `systemPrompt` | 注入《全局协作总纲》 | `ctx.inject` **必需** | `src/index.ts` | 同上（load-gating） | ⏳未验 |
| `settings` | 偏好持久化（`settings.yaml` 的 roundtable 命名空间） | `ctx.inject` | `src/index.ts:251` | 设置页「读取设置失败」；偏好退回内存态，重启即丢 | ⏳未验 |
| `connection` | ① web 路由认证栅栏 ② RPC 兜底传输 | `ctx.get` **可选** | `src/index.ts:285` / `rpc.ts:653` | 栅栏缺失 → 路由可被本机任意网页命中（安全缺口）；通道缺失 → 主传输仍可用 | ⏳未验 |
| `llm` | 专家管理下拉的 provider/model 清单；评审观点拆分 | `ctx.get` **可选** | `rpc.ts:471` / `tools.ts:1372` | 专家管理里选不了模型（只在派发时继承主持人） | ⏳未验 |
| `skills` | skill 清单与正文（relay 模式） | `ctx.get` **可选** | `src/skills.ts:44` | 会议卡片的「技能」区空白，不报错 | ⏳未验 |
| `sessionProjections` | provider 上报的真实 token 用量 | `ctx.get` **可选** | `src/token-usage.ts:110` | 预算里只显示"发言文本估算"，真实用量恒为 0 | ⏳未验 |
| `userQuestions` | 专家向用户提问 / 人类决策 | `ctx.get` **可选** | `tools.ts:548` / `tools.ts:1029` | 「需人类决策」卡片弹不出来，会议停在那不动 | ⏳未验 |

> **为什么 `inject` 和 `ctx.get` 必须分开看**：`inject` 是**加载门禁**——列进去的服务缺一个，整个插件停在 `PENDING`，界面静默消失。`ctx.get` 是可选的——缺了只降级。
> 这条区别是 v0.2.36 那次事故的根因，**永远不要把可选能力写进 `inject`**。

### 1.2 宿主事件

| 事件 | 干什么用 | 源码证据 | 失效时用户看到什么 | rc.3 |
| --- | --- | --- | --- | --- |
| `subagent/end` | 专家产出自动落盘（即使它没主动 `speak`），并读 `stopReason` 写 `lastError` | `src/node-events.ts:206` | 专家跑完了但会议记录里什么都没有；`review.json` 永久停在 `reviewing` | ⏳未验 |
| `agent/request-error` | 捕获 provider 失败原因（余额/鉴权/模型名写错） | `src/node-events.ts:209` | 专家失败只显示 `removed` 墓碑，没有原因 | ⏳未验 |
| `internal/service` | 探测服务注册（当前逻辑待确认） | `src/index.ts:377` | 待补 | ⏳未验 |

> ⚠️ `agent/request-error` 是 **waterfall** 事件：监听器必须始终 `next()` 委派，否则会吞掉宿主自己的重试/恢复策略。改这个监听器时要格外小心。

### 1.3 前端（浏览器半体）

| 触点 | 干什么用 | 源码证据 | 失效时用户看到什么 | rc.3 |
| --- | --- | --- | --- | --- |
| `slots` | 注册三个界面入口 | `inject = ['slots','locale']` | 三个入口全都不注册 | ⏳未验 |
| `locale` | 中英文案（`ctx.locale.register` / `bind`） | `src/client/index.ts:56` | 界面显示原始 key（如 `roundtable.tab`） | ⏳未验 |
| `connection`（前端） | RPC 兜底传输 | `ctx.get('connection')` | 无影响（主传输是插件自己的 web 路由） | ⏳未验 |
| `conversation.view` 槽 | 「圆桌会议」拓扑页签 | `src/client/index.ts:88` | 页签消失 | ⏳未验 |
| `settings.section` 槽 | 设置页 | `src/client/index.ts:102` | 设置页消失 | ⏳未验 |
| `tool.call.toolview` 槽 | `roundtable_status` 的自定义视图 | `src/client/index.ts:115` | 降级成通用工具行，功能不减 | ⏳未验 |
| `rightbar.session`（**single** 槽） | ❌ **已移除，永不再碰** | `src/client/index.ts:120-144` | 抢占会把**整个宿主右侧栏顶崩**（启动横幅 `Failed to load plugins`） | ✅已确认 |

> **single 槽的铁律**：第三方插件一律不注册。宿主的 `registry.d.ts` 对此槽的说明原文就是「DO NOT register here」。
> 踩坑细节：宿主对 `rightbar.session` 是「先声明、后注册」两条语句，声明提交那一刻就同步跑等待回调，插件恰好落在这个空档里抢先占位，导致宿主自己的同优先级注册被 `SlotCore` 拒绝。
> 且 `priority: -1` **无效**——宿主 runner 会对非 chain 槽覆盖 `options.priority` 自行分配。

### 1.4 传输与路由

| 触点 | 干什么用 | 源码证据 | 失效时用户看到什么 | rc.3 |
| --- | --- | --- | --- | --- |
| `connection.rpc.handle(channel, handler)` | 注册 `/roundtable` RPC 通道 | `src/rpc.ts:653` | 兜底通道失效（主传输是 web 路由，仍可用） | ⏳未验 |
| `webServer` 路由 | `/plugins/dsh-plugin-roundtable/state` 与 `/rpc` | `src/index.ts` | 界面一直转圈、读不到任何会议 | ⏳未验 |
| `connection.requestRejection()` | web 路由认证栅栏 | `src/web-guard.ts` | 安全缺口：本机任意网页可命中插件路由 | ⏳未验 |
| `connection.rpc.handle` 返回值 | 期望 `disposer` | `src/rpc.ts` | 插件卸载时通道不释放（泄漏） | ⏳未验 |

### 1.5 编译期依赖（**本插件最脆的一环**）

| 依赖 | 为什么要 type-only import | 失效时用户看到什么 | rc.3 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-conversation/client` | 拉 `conversation.view` 的 SlotMap 合并 | 类型报错（编译期），或槽名写错导致页签不出现 | ⏳未验 |
| `@deepseek-ai/dsh-client-ui-settings/client` | 拉 `settings.section` 的 SlotMap 合并 | 同上 | ⏳未验 |
| `@deepseek-ai/dsh-client-ui-tool/client` | 拉 `tool.call.toolview` 的 SlotMap 合并 | 同上 | ⏳未验 |
| `@deepseek-ai/dsh-client-locale/client` | 拉 `ctx.locale` 的 Context 合并 | 文案 API 类型报错 | ⏳未验 |
| `src/client/ui-slots-anchor.d.ts` | **手工镜像**宿主 SlotRegistry 的 face | 槽机制行为不一致（**只能靠人工比对**，无自动闸门） | ⏳未验 |

---

## 2. 每次 DSH 更新后的体检流程

按顺序做，前四步不做完不要动代码：

1. **记录坐标**：`dsh --version`，并记录插件 `node_modules\@deepseek-ai\*` 的版本 → 更新本文档第 0 节。
2. **升级依赖**：`package.json` 的 devDependencies 指到新版本 → `pnpm install`。
3. **静态体检**：`pnpm typecheck`（宿主 + 浏览器两条 `tsc`）。
4. **回归**：`node --test --test-isolation=none "test/*.test.mjs"`（应当全绿；当前基线见下）。
5. **逐行核对总表**：重点看 1.1 的 `inject` 列表（load-gating 是静默失败，最危险）与 1.5 的 type-only import 路径。
6. **重建 + 重启**：浏览器半体重建后刷新即可；**宿主半体（`inject`、`ctx.on`、`rpc.handle`）必须重启 DSH** 才生效。
7. **活体冒烟**：跑一遍 `/plugins/dsh-plugin-roundtable/state` + 几个关键 RPC（见下）。
8. **回写**：把这一轮的结论、新发现的触点、新的失效征兆**写回本文件**。这一步不做，文档会在两个版本内失效。

### 基线（2026-09-20 实测）

| 项 | 结果 |
| --- | --- |
| `tsc`（宿主 + 浏览器） | 通过（`npm run typecheck` 退出码 0） |
| `node --test` | **121/121 通过，0 失败**（14 个测试文件） |
| 测试文件数 / 源码行数 | 14 个 / 9,400 行 ≈ 15% |
| `npm run build` | 通过（`lib/index.js` 180.42 kB / `lib/client.js` 535.83 kB） |
| 活体 RPC 冒烟 | `state` 200；`prefs.get`、`models.list`、`kb.list`、`feedback.list`、`user-actions.list`、`edge.add/remove`、`prefs.set` 全部 `ok:true` |

---

## 3. 已知欠账（不是 bug，是"知道但还没做"）

| 项 | 状态 | 影响 |
| --- | --- | --- |
| rc.3 契约未逐项验证 | **进行中** | 见第 0 节漂移表 |
| rc.2 → rc.3 的 `.d.ts` diff | **未做** | 缺 rc.2 包，需先留一份副本才能 diff |
| `internal/service` 监听的实际用途 | **未确认** | `src/index.ts:377` |
| ~~`meeting.json` 无 schema 版本~~ | ✅ **已修复** | 见 §5：已补 `schemaVersion` + 迁移通道 |
| 前端测试覆盖 | 无 | `RoundTableView.tsx` 1,723 行零测试 |
| npm 发布 | 未发布 | registry 上查不到该包，目前只能本地装 |
| 会议记录文件的 schema 版本 | 仅 `review.json` 有 | `transcript.jsonl` 暂不需要（append-only，无形状依赖） |

---

## 5. 数据格式版本与迁移通道（本插件的持久化契约）

**`review.json` 早就有 `schemaVersion`，`meeting.json` 此前没有** —— 它是全插件
唯一「裸 `JSON.parse(...) as Meeting`」。这意味着以后任何字段形状一变，老会议
要么读出 `undefined` 字段、要么静默损坏，而且没有版本号可供分支。

现在两者对齐，机制统一如下：

| 文件 | 版本字段 | 迁移函数 | 缺失版本号视为 |
| --- | --- | --- | --- |
| `meeting.json` | `Meeting.schemaVersion` | `normalizeMeeting()` | **1** |
| `review.json` | `ReviewRecord.schemaVersion` | `normalizeReview()` | **1** |
| `transcript.jsonl` | 无（append-only，不需要） | — | — |
| `kb-digest.json` | 无（缓存，坏了就重建） | — | — |

### 改数据形状时的固定动作

1. `src/state.ts` 的 `CURRENT_MEETING_SCHEMA_VERSION` **递增 1**；
2. 在 `MEETING_MIGRATIONS` 里加一条 `版本号 → 迁移函数`（键 = 源版本，值 = 升到
   源版本 + 1）；
3. 在 `test/meeting-schema.test.mjs` 补一条「旧形状文件能读出来且业务字段不丢」
   的用例。

### 三条不可动摇的防御

| 情形 | 行为 | 为什么 |
| --- | --- | --- |
| 版本号缺失 / 非法（0、负数、小数、字符串） | 归一到 1 再走迁移 | 旧文件必须永远可读 |
| 版本号**高于**当前（用户从新版回退） | **原样返回**并 `console.warn`，不降级猜测 | 猜错会**写坏**用户的真实数据 |
| 迁移函数抛错 | 保留原记录 + 告警，**绝不抛给调用方** | 读不出来比读得不完美严重得多——那会让整场会议从界面上消失 |

> 写入侧同样过一遍 `normalizeMeeting()`，形成「读时升级 → 下次写入顺带落盘」的
> 闭环，老文件不会永远停在旧版本。

---

## 4. 本清单由谁补完

| 部分 | 负责 | 状态 |
| --- | --- | --- |
| 触点提取、证据路径、rc.3 漂移 | 从源码抽取 | ✅ 已完成 |
| **"失效时用户看到什么"** | **作者（只有你知道真实症状）** | ⏳ **待补** |
| 每轮体检结论回写 | 作者 | 每次升级后 |

> 最值钱的不是触点表本身，是**失效征兆**那一栏。
> 有了它，以后用户说"界面不见了"，你能直接定位到是 `inject` 还是槽注册，而不是从 9000 行里重新查一遍。
