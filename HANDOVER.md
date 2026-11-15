# 交接文档 · RoundTable 插件

> **给“下一个对话/下一位接手者”的入口。** 读完这一份就够，不需要回看之前的对话记录。
>
> 最后更新：2026-11-15 · 插件版本 `1.0.0-rc.10` · 宿主基线 `DeepSeek Harness 0.2.2-rc.1`
> 仓库：`F:\AI\DSH\1changyong\dsh-plugin-roundtable`（origin: `github.com/9931666/dsh-plugin-roundtable`）

---

## 0. 一句话现状

插件功能齐备、五道工程门禁全绿、宿主 0.2.2-rc.1 适配完成，**并刚做完一轮全面只读审查的整改**
（发布链路修复 + 高/中/低优先级的实质缺陷修复）。

下一步只剩**结构拆分**这类不改行为、只降维护成本的活（见 §5）：`tools.ts` 2012 行、
`RoundTableView.tsx` 2044 行、`rpc.ts` 里 350 行的 dispatch switch。它们都能跑、都有测试，
拆是为了下一版好改，而不是因为坏。

---

## 1. 最近这一轮做了什么（2026-11-15 审查整改）

起因是一次全面只读审查（6 个维度、4 路并行）。整改分三批落地，**没有新增功能**。

### 1.1 发布链路（原来是断的）

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| `pnpm-lock.yaml` 停在 `0.1.5-rc.3` 时代，还残留已删除的 `dsh-settings` | CI 的 `pnpm install --frozen-lockfile` 直接失败 → **官方发布通道是死的**，且四道门禁一个都不报 | 新增 `scripts/check-lockfile.mjs`，挂进 `publish:guard` 第一位 |
| CI `npm publish` 缺 `--tag` | npm 11 起不再按 `-rc.N` 推断渠道，直接失败；或在旧 npm 上把预发布错误推进 `latest` | 按版本后缀显式计算 tag（`-` → next，否则 latest），与 `release.mjs` 一致 |
| `latest` 停在旧版无人提示 | 默认安装与插件市场长期拿到旧版本 | `release.mjs` 增加“latest 停滞”检查（不阻断，只提示 + 给出 `dist-tag add` 命令） |
| 产物级测试硬依赖 `lib/`，干净 clone 上必挂 | 6 个测试红，看着像代码坏了；而 `verify-package` 非 strict 又静默跳过 | 缺 `lib/` 时显式 skip 并写明原因；`verify-package` 记 skip 而非 ok |
| README 版本徽章长期漂移 | 第一眼信息就错 | `verify-package` 新增“徽章 == package.json / compatibility.json”两项检查 |

### 1.2 高优先级缺陷

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| H1 | `create` 是全仓唯一“captain 锁 → meeting 锁”嵌套，无顺序约定 | 抽 `withCaptainMeetingLock()`，把方向钉在一处 |
| H2 | `collect_review` **在会议锁内**串行跑 N 次 LLM（最坏 20 分钟） | 拆三段：持锁取快照 → **锁外**调 LLM → 持锁合并 |
| H3 | 观点拆分两层 `catch {}` 全静默 | 记日志 + `splitFailures` 计数并在输出显示 |
| H4 | 导出物“真实用量”把“没测到”渲染成 0，且不含主持人 | 三态（不可测 / 覆盖 N/M 位专家 / 不含主持人） |
| H5 | `kb.list` 缺 `requireActive`，其余 5 个变更端点都有 | 补齐（根因是“闸门靠每个 case 手抄”，见 §5 的 H9） |
| H6 | 快照 `viewpoints` 类型只声明 5 字段、实现写 13 个，`tsc` 不报错 | 补全，多写少写都编译失败 |
| H7 | `subagent/end` 回调里两行在 try 外 + `void` → **unhandled rejection 会杀进程** | 移进 try，回调补 `.catch` |
| H8 | 反馈条关掉后 1s 内被重新打开 | 加 `feedbackAutoShown` ref，一会议只弹一次 |

### 1.3 中/低优先级

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| M1 | 切会话后选中回落到**别的对话的会议**，删除按钮直接作用于它 | 监听 `sessionId` 变化清空选中 |
| M2 | 错误原因被 `catch {}` 吞光，失败条 render 在 `return` 之后**永不显示** | 保留并显示原因 + 退避 5s/15s |
| M3 | 全局面板“2s 全量 + 1s 全量”双轮询 | 面板单点轮询，`providedMeetings` 下传 |
| M4 | `as` 强转枚举，非法 `kind` 进 transcript 后被网关**静默丢弃** | `normalizeUtteranceKind` / `normalizeEdgeDirection` |
| M5 | 设置页三个写入口整份提交，并发互相覆盖 | 串行写队列 + `prefsRef` 单一基准 |
| M7 | `kb.path.set` 用 `join` 不折叠 `..`；错误回显服务端绝对路径 | 改 `resolve()`；错误只回显用户输入。**绝对路径仍允许**（产品决定） |
| M8 | RPC 靠“遍历工作区猜归属”，与工具的 `session.cwd` 是两套 → 同名会议改错对象 | 前端回传 `workspace`，服务端只认它 |
| M9 | 评审弹窗 15 处 `meeting.review!` | 局部别名收窄，断言清零 |
| M10 | 入口布尔锁插件重载后不复位 → 服务热替换后路由不再注册 | 改存 disposer，服务替换时先撤销再重挂 |
| M12 | 快照内联的 `live ? status : 'ready'` 与 `reconcileNodeLiveness` 分叉，死节点永远显示“就绪” | 快照接入 `reconcileNodeLiveness`（含 `missing`） |
| L7 | `set_budget` 收 0/负数/NaN，**`NaN` 会让预算永不熔断** | 校验轮数 ≥1、token ≥1000 |
| M6 | 快照每 1s 对每场会议全量读盘+解析 | `stat(size+mtimeMs)` 缓存。实测 1.5ms → 0.4ms/轮 |

**有意的行为变更**：`test/export.test.mjs` 里“没有真实用量时给 0”这条断言被改成“不可测”——
旧语义正是 H4 要修的错误。改测试是因为**需求变了**，不是为了凑绿。

---

## 2. 当前状态与固定验证流程

### 2.1 基线（2026-11-15 实测，宿主 0.2.2-rc.1）

| 门禁 | 命令 | 当前结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | **0 错误**（host + client 双端） |
| 测试 | `node --test --test-isolation=none "test/*.test.mjs"` | **174/174** |
| 构建 | `pnpm build` | 通过（`lib/index.js` ≈198 kB / `lib/client.js` ≈699 kB） |
| 矩阵 | `pnpm compatibility` | **43/43** |
| 产物 | `pnpm verify:package --strict` | **21/21**（含 README 徽章两项） |
| 锁定 | `pnpm guard:lockfile` | ⚠️ **当前不通过**：lock 仍是旧的，需在能连 npm 的终端跑一次 `pnpm install` |
| 发布 | `pnpm release` | 11 项，0 阻断 |
| 诊断 | `pnpm doctor` | 依赖本机 npx 缓存路径，非作者机器需显式传 |

### 2.2 改完任何东西后的验证顺序

```sh
pnpm typecheck && node --test --test-isolation=none "test/*.test.mjs"
pnpm build          # 改源码必须重建，否则界面跑的还是旧 lib/
pnpm doctor         # 若报混装或 cordis 不同副本，先解决环境再怀疑代码
```

> **宿主半体的改动（`inject` / 事件 / RPC 通道 / script）需要重启 DSH**；
> 浏览器半体重建后刷新页面即可。

> ⚠️ 在 DSH 的文件沙箱里跑 `pnpm build` / `pnpm release` 会被拒（写 `lib/`、写临时目录）。
> 提权运行一次即可；只读门禁（typecheck / test / compatibility / verify）不受影响。

---

## 3. 关键约定（改代码前必读）

1. **`inject` 是加载门禁**。写进去的服务缺一个，整个插件静默不加载（界面直接消失、无报错）。
   可选能力一律走 `ctx.get(...)`。清单在 `src/harness-compat.ts` 的
   `REQUIRED_CAPABILITIES` / `OPTIONAL_CAPABILITIES`，`test/inject.test.mjs` 守着。
2. **改宿主基线时四处一起改**：`compatibility.json.recommendedHost`、
   `package.json.roundtable.hostBaseline`、devDependencies、`src/version.ts.HARNESS_RANGE`。
   `pnpm compatibility` 会验证。
3. **cordis 必须是同一个物理副本**：否则 `declare module` 合并失效，编译期一片
   `Property 'subagents' does not exist on type 'Context'`。这不是 API 破坏，`pnpm doctor` 会告诉你。
4. **锁顺序**：全仓只有 `create` 需要同时持有 captain 锁与 meeting 锁，方向固定为
   `captain → meeting`，由 `withCaptainMeetingLock()` 唯一承载。**别处只取一把锁**；
   新增嵌套必须沿用这个方向，否则进程内单链锁互等 = host 挂死且无法自愈。
5. **锁内不做外呼**：LLM 调用、网络请求、大文件扫描都不能占着会议锁（H2 的教训）。
6. **RPC 闸门**：写入类端点必须 `{ requireActive: true }`；会议级端点建议带上
   前端传回的 `workspace`，否则同名会议跨工作区时会定位错对象（M8）。
7. **偏好不再是宿主的 settings 命名空间**（0.2.0-rc.2 起）。住在
   `src/preferences.ts` → `<DSH_HOME>/roundtable/preferences.json`。
   `prefs.get` / `prefs.set` 是客户端设置页的唯一契约，改动必须两端同步。
8. **数据格式改动有固定动作**：递增 `CURRENT_MEETING_SCHEMA_VERSION` → 在
   `MEETING_MIGRATIONS` 加一条 → 补测试。`meeting.json` 有 schemaVersion 与迁移通道。
9. **产物级测试读 `lib/`**：干净 clone 上没有 `lib/`，这些测试会 skip 并打印原因。
   要强制校验，先 `pnpm build` 再跑，或跑 `publish:guard`（`--strict`）。

---

## 4. 提示词与限定：三层结构

改 AI 行为时先看这一节，别直接改 `persona`。

| 层 | 位置 | 谁看到 | 改它的代价 |
| --- | --- | --- | --- |
| 主持人 usage 段 | `src/prompt.ts::usageSectionText()` | **每个会话、每次请求**（包括不开会时） | 最高。体积极限由 `test/prompt-budget.test.mjs` 断言 |
| 会议总纲 | `src/charter.ts::buildCharter()` | 每位专家 | 中。跟着专家的每次请求付费 |
| 节点 persona | `src/prompt.ts::nodePersona()` | 单个专家 | 低 |
| 工具 description | `src/tools.ts` 各 `defineTool` | 模型按需读 | 低，但**是模型判断"什么时候用"的唯一依据** |
| 专家补充定位 | `MeetingNode.expertPrompt` → persona 段 | 单个专家 | 用户/模型可填，**只放宽专长不放宽红线** |

两条硬规矩：
- 同一条约束**只写一处**。总纲写共同红线，persona 写"你这个节点怎么做"。
- `expertPrompt` 进入 persona 时必须带不可覆盖声明（"只放宽专长，不放宽总纲红线/拍板边界"），
  否则确认卡就成了绕过红线的后门。

---

## 5. 下一步：结构拆分（唯一剩下的大活）

这几处**都能正常工作、都有测试**，拆是为了下一版好改。风险从低到高：

### 5.1 `tools.ts`（2012 行 / 21 个工具）

建议按域拆成 5–6 个模块，**先搬不改逻辑**：

| 新模块 | 内容 |
| --- | --- |
| `tools/lifecycle.ts` | create / plan_meeting / add_node / remove_node / close |
| `tools/topology.ts` | connect / disconnect |
| `tools/speech.ts` | speak / send_message / summarize / proxy_think |
| `tools/status.ts` | status / set_budget / actions_clear |
| `tools/review.ts` | start / collect / finish / export ×2 |
| `tools/render.ts` | renderStatus / renderMeetingMarkdown / renderReviewMarkdown |
| `tools/guard.ts` | **唯一的共享层**：`requireCaptain` + `stateRootOf` + `locate*` + `withCaptainLock` + `withCaptainMeetingLock` + `assertUsablePersisting` + `requireNode` |

那 7 个守卫函数已经是天然抽象层，只是还没被收敛到一个文件。搬完 `tools.ts` 应从 2012 行降到
200 行以内的注册骨架。

### 5.2 `rpc.ts` 的 dispatch（约 350 行 switch）

拆成按域分组的 handler 表，**`requireActive` 变成描述符字段而不是每个 case 里手抄一句**。
H5 的漏项就是这么来的；表结构能让"同域端点要不要闸门"一眼横向比对。

### 5.3 `RoundTableView.tsx`（2044 行）

沿"自包含 UI 块 + 显式 props"拆——props 只有 4 个**并没有膨胀**，膨胀的是 31 个 useState：

| 可拆块 | 行号区间（拆分前） |
| --- | --- |
| 拓扑画布 | `1012-1200` + `1291-1372` |
| 评审弹窗 | `1816-1985` |
| 右栏 Sidebar | `1379-1582`（已按 section 分好，拆解成本最低） |

### 5.4 拆分时的护栏

- 每搬一个模块跑一次 `pnpm typecheck && node --test`；
- 产物级测试（`inject.test.mjs` / `client-entries.test.mjs`）依赖 `lib/`，搬完记得 `pnpm build`；
- **不要在同一个提交里既搬文件又改逻辑**——那样出问题时无法区分是搬家还是改错了。

---

## 6. 已知坑

- **`internal/service` 监听器**（`src/index.ts`）：作用是弥补 `inject` 只含
  tools/subagents/agents/systemPrompt、不含 `webServer`/`workspaceRegistry` ——
  宿主晚挂载 webServer 时靠它补注册。它**不是死代码**，别删。
- **`NODE_ALLOWED_TOOLS`（`members.ts`）在 0.2.2 上走不到**：宿主的 `startActivation` 契约去掉了
  per-child `toolFilter`，专家工具边界退化为 persona 里的文字约束。清单保留给旧宿主与将来的落点。
- **测试假失败**：`node --test ... | Select-Object -Last N` 在 PowerShell 里可能因管道提前关闭
  让退出码变 1。把输出重定向到文件再读。
- **`repair-links.mjs`** 会写 `node_modules/` 并硬编码上游私有路径。它只在"手工接线"的机器上
  有意义，正常 `pnpm install` 的机器不需要。
- **`doctor.mjs` 硬编码作者本机 npx 缓存路径**，非作者机器需显式传参数。
- **prerelease 的 `^`**：`^0.2.0-rc.2` 不覆盖 `0.2.1-rc.2`。跨 minor 升级必须改 peer 区间。

---

## 7. 快速索引

| 想做什么 | 看哪里 |
| --- | --- |
| 了解用户怎么用 | `README.md` |
| 改宿主版本基线 | `compatibility.json` + `src/harness-compat.ts` 文末「宿主契约变更实录」 |
| 改 AI 行为/措辞 | 本文 §4 |
| 改数据格式 | §3 第 8 条 + `src/state.ts` 的 `MEETING_MIGRATIONS` |
| 发布 | `README.md` 的「发布」节 + `pnpm publish:guard` |
| 排查"界面不见了" | §3 第 1 条 + `pnpm doctor` + 浏览器控制台的 `[roundtable]` 日志 |
