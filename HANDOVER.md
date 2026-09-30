# 交接文档 · RoundTable 插件

> **给下一个对话/下一位接手者的入口。**
> 读这一份就够，不需要回看之前的对话记录。
>
> 最后更新：2026-09-30 · 插件版本 `1.0.0-rc.2` · 宿主基线 `DeepSeek Harness 0.2.0-rc.2`
> 仓库：`F:\AI\DSH\1changyong\dsh-plugin-roundtable`（origin: `github.com/9931666/dsh-plugin-roundtable`）

---

## 0. 一句话现状

插件已具备 1.0 候选形态：**功能齐备、五道工程门禁全绿、支持矩阵可校验**。

**当前焦点：宿主跨大版本适配。** 宿主已从 `0.1.5-rc.3` 升到 **`0.2.0-rc.2`**，
该版本动了两处真正破坏兼容的地方（`settings` 服务重构成 `SettingsForms`、
`MessageSourceMap` 移除 catch-all 的 `plugin` kind），本轮已全部适配完毕，
静态门禁全绿 —— 但 **活体冒烟还没做**，那是接手后的第一件事（见 §7）。

其他欠账：提示词第一轮去重已完成（见 §4）；`RoundTableView.tsx` 仍是零测试覆盖。

---

## 1. 刚刚完成的这一轮（宿主适配 → `1.0.0-rc.2`）

本轮**没有加任何功能**，只有一件事：把插件抬到宿主 `0.2.0-rc.2`。

| 宿主改了什么 | 编译期症状 | 本轮的改法 |
| --- | --- | --- |
| `settings` 服务重构成 `SettingsForms`，`SettingsScope` 类型消失，插件**不再能注册自己的配置命名空间** | `Property 'register' does not exist on type 'SettingsForms'` / `has no exported member 'SettingsScope'` | 新增 **`src/preferences.ts`**：偏好改为自持久化（`<DSH_HOME>/roundtable/preferences.json`）；`settings` 从三处能力清单移除 |
| `MessageSourceMap` 移除 catch-all 的 `plugin` kind（改为「每个生产者在自己的模块里声明」） | `Type '"plugin"' is not assignable to type '"user" \| "model" \| …'` | `src/members.ts` **自声明 `roundtable` kind** |

**破坏面比预期小得多**：宿主侧 `tsc` 只有 **4 个错误**、浏览器侧 **0 个**。
`inject` 的四个必需服务、子代理派发/中断、两个生命周期事件、`webServer.register`、
`rpc.handle`、四个界面槽位 —— **全部原样可用**。逐项复核记录在
`src/harness-compat.ts` 文末「6. 宿主契约变更实录」。

改动文件一览：

| 文件 | 改动 |
| --- | --- |
| `src/preferences.ts` | **新增**：偏好形状 + 净化规则 + 自持久化 store（复用 `state.ts` 的原子写） |
| `src/index.ts` | 删除 `ctx.inject(['settings'])` 段与 `PreferenceSchema`；`RoundTableRuntime` 收敛为 `{ prefs, stateDir }` |
| `src/rpc.ts` | 净化函数与上限常量搬去 `preferences.ts` 并 re-export；**`prefs.get` / `prefs.set` 两个端点对外一字未变** |
| `src/members.ts` | 自声明 `roundtable` message source kind |
| `src/harness-compat.ts` | 移除 `settings` 能力 + 追加「宿主契约变更实录」 |
| `compatibility.json` / `package.json` / `src/version.ts` | 基线、依赖、版本、能力清单同步 |
| `README.md` / `docs/host-contract.md` / `release-notes/v1.0.0-rc.2.md` | 文档回写 |

### 1.1 工程资产（`1.0.0-rc.1` 那轮建立，本轮沿用并更新了门禁项数）

| 文件 | 作用 |
| --- | --- |
| `compatibility.json` | **宿主支持矩阵的唯一来源**（recommendedHost / 能力清单 / 基线包） |
| `src/harness-compat.ts` | **所有版本相关的宿主差异集中于此**（11 个探测点，各带"失效时用户看到什么"；文末追加了「宿主契约变更实录」） |
| `src/preferences.ts` | **（本轮新增）偏好形状 + 净化规则 + 自持久化 store** |
| `scripts/compatibility.mjs` | 校验矩阵 / devDeps / peer / 源码能力清单四者一致（43 项） |
| `scripts/verify-package.mjs` | 发布门禁：files、入口文件、`.ts` 残留、模块在产物里有痕迹（19 项） |
| `scripts/release.mjs` | 发布护栏：渠道判定、防 latest 倒退、产物 SHA-256（10 项，**不自动发布**） |
| `scripts/doctor.mjs` | 只读诊断：版本、混装、**cordis 实例同一性**、能力清单 |
| `scripts/repair-links.mjs` | 一次性修链接工具（正常机器用不到，见 §6） |
| `docs/host-contract.md` | 宿主契约清单（触点表 + 失效征兆 + 升级固定动作 + 每轮体检结论） |
| `release-notes/v1.0.0-rc.2.md` | 本版发布说明（宿主适配） |

### 1.2 历史：`1.0.0-rc.1` 那轮顺带修掉的三个真问题

| 问题 | 真相 |
| --- | --- |
| 对 rc.3 跑 `tsc` 报 60+ 处 `Property 'subagents' does not exist on type 'Context'` | **不是 API 破坏**：宿主与插件各带一份 `@deepseek-ai/cordis@4.0.2`，TS 视为两个模块，`declare module` 声明合并失效。统一副本后 **0 错误**（0.2.0-rc.2 那轮复核仍是通过） |
| 发布包白带 557 kB | `lib/client.js.map` 占解包体积 36%，而浏览器半体是宿主直接加载的 bundle、默认取不到它。改为按需（`RT_SOURCEMAP=1`）→ 包从 695.6 kB 降到 ~405 kB |
| `dsh-client-ui-renderer` 一直没声明 | `dsh.client.inject` 里在用，却不在任何 dependencies 中 |

---

## 2. 当前状态与固定验证流程

### 2.1 基线（2026-09-30 实测，宿主 0.2.0-rc.2）

| 门禁 | 命令 | 当前结果 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | **0 错误**（宿主 + 浏览器，双端） |
| 测试 | `node --test --test-isolation=none "test/*.test.mjs"` | **150/150** |
| 构建 | `npm run build` | 通过（`lib/index.js` 186.7 kB / `lib/client.js` 564.3 kB） |
| 矩阵 | `npm run compatibility` | **43/43**（`settings` 能力移除后少 2 项） |
| 产物 | `npm run verify:package` | **19/19**（24 个模块全部命中） |
| 发布 | `npm run release` | **10/10**，候选产物 425,405 B |
| 诊断 | `npm run doctor` | 宿主 0.2.0-rc.2 / 混装 ✓ / cordis 同一性 ✓ |
| 活体冒烟 | 手动 | ⏳ **本轮未做** |

> ⚠️ 本机 pwsh 处于 DSH 文件沙箱（`workspace-write`）下，**写工作区文件会被拒**
> （`Access to the path … is denied`）。所以 `npm run build` 与 `npm run release`
> 需要**提权运行一次**（`release` 还要写 `.git/pack-preview/`）。
> 只读命令（typecheck / test / compatibility / verify / doctor）不受影响。

一键跑门禁：`npm run publish:guard`（compatibility + verify:package + release）。

### 2.2 改完任何东西后的验证顺序

```sh
npm run typecheck && node --test --test-isolation=none "test/*.test.mjs"
npm run build          # 改源码必须重建，否则界面跑的还是旧 lib/
npm run doctor         # 若报混装或 cordis 不同副本，先解决环境再怀疑代码
```

> **宿主半体的改动（`inject` / 事件 / RPC 通道）需要重启 DSH 才生效**；
> 浏览器半体重建后刷新页面即可。

---

## 3. 关键约定（改代码前必读）

1. **`inject` 是加载门禁**。凡写进 `inject` 的服务缺一个，整个插件静默不加载
   （没有报错，界面直接消失）。可选能力一律走 `ctx.get(...)`。
   清单在 `src/harness-compat.ts` 的 `REQUIRED_CAPABILITIES` / `OPTIONAL_CAPABILITIES`。
2. **改宿主基线时四处一起改**：`compatibility.json` 的 `recommendedHost`、
   `package.json` 的 `roundtable.hostBaseline`、devDependencies、`src/version.ts` 的
   `HARNESS_RANGE`。`npm run compatibility` 会验证。
3. **cordis 必须是同一个物理副本**（否则声明合并失效，类型全红）。
   `npm run doctor` 会直接告诉你。
4. **数据格式改动有固定动作**（见 `docs/host-contract.md` §5）：
   递增 `CURRENT_MEETING_SCHEMA_VERSION` → 在 `MEETING_MIGRATIONS` 加一条 → 补测试。
   `meeting.json` 现在有 `schemaVersion` 与迁移通道，老文件永远可读。
5. **偏好不再是宿主的 settings 命名空间**（0.2.0-rc.2 起）。它住在
   `src/preferences.ts` → `<DSH_HOME>/roundtable/preferences.json`。
   **不要**再写 `ctx.inject(['settings'])` 或 `settings.register(...)` ——
   宿主新模型（`SettingsForms`）根本没有这个能力。`prefs.get` / `prefs.set`
   两个 RPC 端点是客户端设置页的唯一契约，改动必须两端同步。
6. **声明合并依赖物理副本唯一**。除了 cordis，`src/members.ts` 里的
   `declare module '@deepseek-ai/dsh-llm'` 也是同一机制 —— dsh-llm 出现两份
   物理副本时那个声明会静默失效。`pnpm doctor` 目前只查 cordis。

---

## 4. 下一步：各 AI 之间的提示词与限定 ★

**这是接下来的工作重点。** 下面把"所有影响 AI 行为与措辞的位置"列全，
改哪里、影响谁、怎么验，一目了然。

### 4.1 三层提示词结构

```
第 1 层  主持人（DeepSeek 本体）的系统提示词
         └ 只约束"主持人怎么带会"，专家看不到

第 2 层  《全局协作总纲》charter
         └ 每场会议生成一次，注入给**所有**专家（作为 persona 的开头）

第 3 层  专家 persona（总纲 + 身份 + 工作规则 + 回答限制）
         └ 每个专家独有，还带协作模式规则与 skill 段
```

### 4.2 逐层入口表

| # | 位置 | 影响谁 | 内容要点 |
| --- | --- | --- | --- |
| 1 | `src/prompt.ts` 的 `usageSectionText()` | **主持人** | 10 条带会协议（创建 → 编排 → 收尾），**2,493 字符**（原 7,924，且不再逐个列工具名 —— 工具 schema 本来就在请求里）。注册点仍是 `index.ts` 的 `ctx.systemPrompt.section({ order })`，顺序由 config `promptSectionOrder`（默认 116）控制 |
| 2 | `src/charter.ts` 的 `buildCharter()` | **所有专家** | 总纲四节：①会议背景与目标 ②团队与角色边界 ③标准化协作协议（`[当前状态]` / `[核心产出]` / `[下一步建议]` 格式）④全局约束与安全红线；redteam 模式追加第五节。名单与通道压成单行，**548 字符** @5 人 |
| 3 | `src/prompt.ts` 的 `nodePersona()` | **每个专家** | charter + 身份 + **工作规则 4 条** + skill 段 + 协作模式规则 + 回答限制，**1,202 字符**。总纲已写的红线（拍板 / 编造）在这里**不再重复** |
| 4 | `src/prompt.ts` 的 `skillSection()` | 每个专家 | 按 `relay` / `direct` 两种传递方式给出不同约束（relay 时明令不得自己调 `skill` 工具） |
| 5 | `src/prompt.ts` 的 `nodeWelcome()` | 每个专家 | 节点创建时的首条用户消息（"你已加入…等待指令"） |
| 6 | `src/tools.ts` 各工具的 `description` | 主持人 | 工具语义与使用时机（`roundtable_*` 共 21 个） |
| 7 | `src/review-split.ts` | 评审拆分 | 把专家发言拆成独立观点的 LLM 提示词 + 本地兜底切分规则 |
| 8 | `src/proxy-thinking.ts` | 黑盒模型 | `[DeepSeek 代理思考]` 导演模板 |
| 9 | `src/client/locales.ts` | 界面文案 | 中英文案（不是模型提示词，但影响用户读到的措辞） |
| 10 | `src/prompt.ts` 的 `TASK_ENVELOPE` / `REPORT_ENVELOPE` | 主持人 + 专家 | 跨 AI 交接信封：转发只带 `R{n}[{speaker}]` 引用，专家按引用自行读 `transcript.jsonl` 取原文；双通道边界（`roundtable_speak` = 汇报且不唤醒任何人 / `roundtable_send_message` = 需要对方立刻行动）。专家看不到主持人的 usage 段，这两个工具的 description 才是专家侧的唯一指引 |

### 4.3 改动的验证方法

| 风险 | 怎么验 |
| --- | --- |
| 提示词改动不影响编译 | `npm run typecheck`（只保证语法，**不保证效果**） |
| 总纲格式被破坏 | `test/` 里没有直接测 charter 的用例；建议新增一个断言 `buildCharter(meeting)` 含四节标题的测试 |
| 专家行为变化 | **必须实跑一场会**：`roundtable_plan_meeting` → 创建 → 加节点 → 观察专家发言是否遵守新约束。这是唯一有效的验证方式 |
| 回答限制生效与否 | 看 `roundtable_status` 的 recent 与 `roundtable_export_meeting` 的逐轮发言，是否仍出现空话/无关内容 |
| 提示词体积回涨 | `npm run prompt:budget`（`scripts/prompt-budget.mjs`）看三项数字；`test/prompt-budget.test.mjs` 已把上限写死（usage ≤3200 / charter ≤1200 / redteam ≤1700 / persona ≤2400 / 工具描述 ≤11200） |

### 4.4 改提示词时的注意事项

- **别把总纲写进 `inject` 之类的地方**——它是纯文本生成，改 `charter.ts` 即可。
- **`nodePersona()` 里的编号是手写的**（1..5），插入新规则时要顺手重排编号。
- **总纲是全专家共享的**，写进去的约束会作用于每一位专家；
  只针对某一类专家的约束应放 `nodePersona()` 或按 `node.role` 分支。
- **redteam 模式有额外的第五节协议**（`charter.ts` 的 `redteamRules`），改总纲时别漏。
- 措辞改动会影响 **token 用量**：总纲每次都会注入每个专家的上下文，越长越贵。
  **这条现在是硬约束**：上限写在 `test/prompt-budget.test.mjs`，涨过就红。
- **usage 段不要再写回 `index.ts`**：它被抽到 `src/prompt.ts`（纯文本、零运行时依赖），
  正是为了能被测试直接 import 断言体积；`index.ts` 只保留 `ctx.systemPrompt.section()` 注册点。
- **同一约束只写一处**：charter 与 persona 都会被每位专家长期携带，两处各写一遍就是付两遍钱
  （`test/prompt-budget.test.mjs` 里有对应的去重断言）。

---

## 5. 发布与推送（npm 路线已作废）

### 5.1 推送

截至 `ad7d7b3`，本地 `main` 与 `origin/main` 一致（此处原先写的"领先 6 个提交"已过时）。

```sh
cd F:\AI\DSH\1changyong\dsh-plugin-roundtable
git push origin main
```

> ⚠️ **在 DSH 会话里（pwsh 沙箱）推不了**：`git push`、连只读的 `git ls-remote`
> 都会以 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` 失败 ——
> 那是沙箱拦截了 schannel 取系统凭证，**不是凭证缺失**。必须在自己的终端窗口里推。
> 若报找不到 `git-credential-manager`，把 `E:\xia zai\git\Git\mingw64\bin` 加进
> `PATH` 再推（`git-credential-manager.exe` 在那里）。

### 5.2 npm 发布：**已作废，不要再试**

**结论**：作者**个人原因无法注册 npm 账户**，`@huanlin` scope 拿不到，
`npm publish` 必然以 **403** 失败。这条路已放弃——不要再准备发布材料、不要再登录尝试。

- `package.json` 的 `name` / `publishConfig` 保留为仓库内元数据，但 registry 上
  **不存在**这个包；
- 仓库历史文档（`release-notes/*`、README 旧版、`wenjian/roundTable/上架操作教程-npm与awesome.md`）
  里出现的 `dsh plugin --profile web add @huanlin/dsh-plugin-roundtable` **一律不可用**；
- 用户端唯一安装方式是**源码 / GitHub**：
  `git clone https://github.com/9931666/dsh-plugin-roundtable` → `pnpm build` →
  `dsh plugin --profile web add .`

### 5.3 实际发行方式：GitHub

```sh
npm run publish:guard                                # 门禁仍然有效，全绿才算可发
git tag v1.0.0-rc.2 && git push origin v1.0.0-rc.2   # Release 的触发点
```

`scripts/release.mjs` 只做产物快照（渠道判定 / 防 latest 倒退 / 产物 SHA-256 / 候选 `.tgz`
写到 `.git/pack-preview/`）；它**完全不调用 npm，也不会自动发布**。

---

## 6. 环境陷阱记录（踩过的坑）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `pnpm install` 报 `ERR_SQLITE_ERROR / unable to open database file` | 本机默认 store（`F:\AI\.DSH\pnpm-store`）数据库损坏 | 换 store 路径：`pnpm install --store-dir .git/pnpm-store2` |
| `npm pack` 报 `EPERM ... F:\AI\npm-cache\_cacache` | npm 全局缓存在沙箱外不可写 | 设 `npm_config_cache` 到仓库内；**注意 `--cache` 写在子命令后不生效，必须用环境变量** |
| 沙箱里 `execFileSync('npm', ...)` 报 `EINVAL` / `EPERM` | Windows 上无法用管道方式 spawn `.cmd` | `scripts/release.mjs` 因此**完全不调用 npm 命令**（registry 走 HTTPS、打包用内置 ustar） |
| `node --test` 报 `spawn EPERM` | 测试运行器要为每个文件开子进程 | 改用 `--test-isolation=none`（单进程内跑） |
| `ERR_MODULE_NOT_FOUND`：缺 `@rolldown/pluginutils`、`@quansync/fs`… / `Cannot find module '@rolldown/binding-*'` | pnpm 安装中途中断，`.pnpm/` 里包在但**接线不全** | 跑 `node scripts/repair-links.mjs` 补齐（只读 `.pnpm`，不下载） |
| `tsc` 报 `Cannot find type definition file for 'node'` | `@types/node` 没链到顶层 | 从 `.pnpm/@types+node@*` 建链接（或用 repair-links） |
| pwsh 里 `Set-Content` / `node -e` 写工作区报 `Access to the path … is denied` | DSH 文件沙箱（`workspace-write`）**对普通进程拒绝写入**，只有受信任的编辑工具能写 | 只读命令照常跑；需要写盘的（`npm run build`、`npm run release`）**提权运行一次**即可 |
| `release.mjs` 报 `EPERM: rmdir …\.git\pack-preview` | 沙箱把 `.git/` 设成只读 | 同上，提权跑一次 |
| `pnpm-lock.yaml` 仍是 `0.1.5-rc.3` 时代的记录 | 本机无法重新生成（上一条 + pnpm store 损坏） | 直接 `pnpm install`（默认会按新 `package.json` 重新解析并刷新 lockfile）；能用 pnpm 的机器上跑一次后把 lockfile 提交回来。**CI 不跑安装，不受影响** |

> **本机 `node_modules` 现状**：因为中途安装中断，当前是用宿主副本手工接线的
> （`@deepseek-ai/cordis` 是**指向宿主副本的 junction**）。
> **在能正常联网的机器上第一件事应该是 `pnpm install`**，然后 `npm run doctor`
> 确认 cordis 同一性 —— 注意重装会把手接的 junction 换回 store 解析。
> lockfile 目前**未对齐**（见上表最后一行），所以首次安装**不要**加
> `--frozen-lockfile`。

---

## 7. 已知边界与欠账

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **活体冒烟** | ⏳ **本轮未做** | 0.2.0-rc.2 的适配只做了静态核对（双端 `tsc` + 150 项测试 + 五项门禁）。接手后第一件事：跑一遍 `/plugins/dsh-plugin-roundtable/state` 与 `prefs.get/set` 等关键 RPC，并实跑一场短会 |
| **`pnpm-lock.yaml`** | ⏳ **未刷新** | 见 §6；`pnpm install` 会自动刷新，CI 不跑安装 |
| 偏好迁移 | 无自动迁移 | 偏好从宿主 `settings.yaml` 搬到 `<DSH_HOME>/roundtable/preferences.json`，旧值不会自动搬。默认值与旧版一致，重设一次即可 |
| 前端测试 | **零覆盖** | `RoundTableView.tsx` 1,723 行没有测试；需要先把纯逻辑（`layoutPositions`、`edgeCurveGeometry`、`providerBrand`）从组件里抽出来才能测 |
| 宿主覆盖 | **仅 0.2 线** | 矩阵只有 `0.2.0-rc.2` 一条；`0.1.5-rc.3` 不再承诺（peer 区间与类型基线各只能有一个），`0.1.6-alpha.*` 从未纳入 |
| `internal/service` 监听 | 用途未确认 | `src/index.ts` 里那个监听器的实际作用没有查证（行号随本轮改动已变） |
| 跨 session 越权 | 接受现状 | RPC 通道不暴露调用者 session 身份；单人/单工作区无影响，多人共用同一实例时视作同一信任域 |
| 包名 scope | **已作废** | 个人原因无法注册 npm 账户 → 不发 npm，发行渠道改为 GitHub（见 §5.2 / §5.3） |

---

## 8. 快速索引

| 想做什么 | 去哪 |
| --- | --- |
| 改主持人行为 | `src/prompt.ts` → `usageSectionText()`（`index.ts` 只注册） |
| 改所有专家的共同约束 | `src/charter.ts` → `buildCharter()` |
| 改某个专家的规则/限制 | `src/prompt.ts` → `nodePersona()`（`members.ts` 只再导出） |
| 看提示词体积预算 | `npm run prompt:budget` → `scripts/prompt-budget.mjs` |
| 改工具语义 | `src/tools.ts` 各 `description` |
| 改评审拆分逻辑 | `src/review-split.ts` |
| 改界面文案 | `src/client/locales.ts` |
| 改宿主兼容判断 | `src/harness-compat.ts`（**只改这里**）；每轮升级的实测结论追加到文末「6. 宿主契约变更实录」 |
| 改偏好字段 / 净化规则 / 持久化位置 | `src/preferences.ts`（**不要**再碰宿主的 `settings` 服务） |
| 改偏好 RPC 契约 | `src/rpc.ts` 的 `prefs.get` / `prefs.set` **＋** 客户端 `src/client/wire.ts`（两端必须同步） |
| 改支持矩阵 | `compatibility.json` |
| 看宿主触点全貌 | `docs/host-contract.md` |
| 看本版改了什么 | `release-notes/v1.0.0-rc.2.md` |
| 发布/诊断 | `scripts/release.mjs` / `scripts/doctor.mjs` |
