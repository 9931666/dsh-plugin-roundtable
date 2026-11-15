# 宿主契约清单 · RoundTable

> 这份文档的唯一用途：**宿主升级时照着核对**。每次升级后必须更新 §0 的坐标表。
>
> 最后更新：2026-11-15 · 插件 `1.0.0-rc.10` · 宿主基线 `0.2.2-rc.1` · cordis `4.1.0` · schemastery `3.19.0`

---

## 0. 当前坐标

| 项 | 值 | 来源 |
| --- | --- | --- |
| 插件版本 | `1.0.0-rc.10` | `package.json` / `src/version.ts`（`test/version.test.mjs` 强制一致） |
| 宿主基线 | `0.2.2-rc.1` | `compatibility.json.recommendedHost` |
| 宿主默认模型 | `deepseek-official/deepseek-v4-flash`（观点拆分用） | `src/index.ts` 的 `reviewSplit` |
| 必需服务 | `tools` `subagents` `agents` `systemPrompt` | `src/index.ts` 的 `inject` |
| 可选服务 | `connection` `llm` `skills` `userQuestions` `sessionProjections` `webServer` `workspaceRegistry` | `src/harness-compat.ts` |
| 子代理入口 | `startActivation`（0.2.1+）；保留 `startContinuable` 兼容旧宿主 | `src/members.ts::spawnNode` |
| 状态目录 | `<工作区>/.roundtable/<会议 id>/` | `cordis.patch.yml` 的 `stateDir` |
| 偏好文件 | `<DSH_HOME>/roundtable/preferences.json` | `src/preferences.ts` |

---

## 1. 触点表（宿主升级时逐行核对）

「失效时用户看到什么」这一栏是**排查的起点**：用户报的现象对得上哪一行，就先查那个触点。

### 1.1 必需服务（写进 `inject`，缺一个整个插件不加载）

| 触点 | 用法 | 失效时用户看到什么 |
| --- | --- | --- |
| `ctx.tools.register` | 注册 21 个 `roundtable_*` 工具 | 模型完全不会调用圆桌会议，界面也没有 |
| `ctx.subagents` | 派发/续聊/打断专家子代理 | 建会成功但专家拉不起来 |
| `ctx.agents` | 读取 live 子会话状态 | 节点活动状态永远显示“就绪” |
| `ctx.systemPrompt.section` | 注入主持人 usage 段 | 模型不知道何时该开圆桌会议 |

### 1.2 可选服务（运行时 `ctx.get`，缺失即降级）

| 触点 | 缺失时的降级 | 用户看到什么 |
| --- | --- | --- |
| `connection` | RPC 失去兜底传输；Host/Origin 栅栏无法施加 | 设置页/拓扑操作失败；**安全栅栏缺失**（有 warn 日志） |
| `llm` | 观点拆分退化为本地正则 | 评审观点粒度变粗，但可用 |
| `skills` | skill 清单为空 | 卡片「技能」区空白，不报错 |
| `userQuestions` | 决策卡不可用 | 「需人类决策」不弹，主持人改用文字确认 |
| `sessionProjections` | 测不到真实 token 用量 | 预算只显示文本粗估，真实用量显示「不可测」 |
| `webServer` | 两条 HTTP 路由都不挂 | 界面一直转圈、读不到任何会议（headless profile 属预期） |
| `workspaceRegistry` | 拿不到工作区列表 | snapshot 路由不挂载 |

### 1.3 其它关键触点

| 触点 | 用法 | 失效时用户看到什么 |
| --- | --- | --- |
| `ctx.subagents.startActivation` | 0.2.1+ 的派发入口（persona 并入首条 prompt） | 两个入口都缺时报明确的错误，不会静默 |
| `subagent/end` 事件 | 自动补捕专家产出到 transcript | 专家不调 `roundtable_speak` 时发言丢失 |
| `agent/request-error` 事件（waterfall） | 记录每节点最后一次 provider 失败 | 节点失败无 `lastError` 说明 |
| `webServer.register` | `/plugins/dsh-plugin-roundtable/state` + `/rpc` | 界面空白/转圈 |
| `connection.requestRejection` | RPC 与快照路由的访问栅栏 | 见 §0 上文：缺失时放行（有 warn） |

---

## 2. 升级固定动作

1. 改 `compatibility.json.recommendedHost` 与 `package.json.roundtable.hostBaseline`；
2. 同步 `devDependencies` 到该版本（**精确钉版**，不用 `^`），`pnpm install`；
3. `pnpm typecheck && pnpm test`；
4. `pnpm doctor` —— **先看混装与 cordis 同一性**，再怀疑 API 破坏；
5. `pnpm compatibility && pnpm verify:package --strict`；
6. 重建 `lib/`；**宿主半体改动需重启 DSH**；
7. 更新本文件 §0 与 §3 的记录。

> ⚠️ `^0.2.0-rc.2` **不覆盖** `0.2.1-rc.2`。npm 的 prerelease 语义只在同一 base version 内
> 接受更高的 prerelease，所以跨 minor 升级必须显式改 peer 区间。

---

## 3. 宿主契约变更实录

| 宿主版本 | 变更 | 本插件的应对 |
| --- | --- | --- |
| `0.2.0-rc.2` | `settings` 服务重构成 `SettingsForms`，`SettingsScope` 类型消失，插件**不再能注册自己的配置命名空间** | 新增 `src/preferences.ts` 自持久化；`settings` 从三处能力清单移除 |
| `0.2.0-rc.2` | `MessageSourceMap` 移除 catch-all 的 `plugin` kind（改为每个生产者自己声明） | `src/members.ts` 自声明 `roundtable` kind |
| `0.2.1-rc.2` | 子代理契约：`startContinuable` → `startActivation(spec)`；per-child `persona` / `toolFilter` 被移除（persona 归 system-prompt / agent preset，工具面由 preset 拥有） | `spawnNode` 走**双路径**：新宿主把 persona 并入首条 prompt（`delivery: 'parent'`），旧宿主保留 `startContinuable` + `toolFilter`。见 `test/members.test.mjs` |
| `0.2.2-rc.1` | 本插件范围内无破坏性变更 | 只跟基线 |

### 3.1 `startActivation` 带来的能力退化（**已知且未解决**）

`toolFilter` 移除后，**专家节点的工具白名单在 0.2.2 上不再生效**：

- `NODE_ALLOWED_TOOLS` / `NODE_DENIED_TOOLS` 只在 `startContinuable` 分支使用；
- 新宿主下边界退化为 `src/prompt.ts` 里「你是专家不是主持人」那一段文字约束；
- 专家理论上可以调用 `roundtable_create` 等主持人工具，但会被工具侧的 `requireCaptain` 拒绝，
  所以不是安全问题，是**防御层少了一层**。

要恢复硬边界，只能在 profile 里静态声明一个只读 agent preset，再通过 `agentPreset` 选择 ——
0.2.1+ 的 preset registry 只读，插件不能在运行时注册。**这是产品决策，做之前先问用户。**

---

## 4. 数据格式与迁移

- `meeting.json` 有 `schemaVersion` 与 `MEETING_MIGRATIONS` 迁移通道；老文件永远可读。
- `transcript.jsonl` 是 append-only，只追加不重写；读取走 `readTranscriptCached`
  （`stat` 的 size+mtimeMs 作失效键），**会议目录被清空时必须 `forgetTranscriptCache`**。
- 改格式的固定动作：递增 `CURRENT_MEETING_SCHEMA_VERSION` → 在 `MEETING_MIGRATIONS`
  加一条 → 补测试 → 更新本节。

---

## 5. 每轮体检结论

| 日期 | 宿主 | 插件 | 结论 |
| --- | --- | --- | --- |
| 2026-11-15 | 0.2.2-rc.1 | 1.0.0-rc.10 | 完成一轮全面审查整改。门禁：typecheck ✓ / 174 tests ✓ / compatibility 43 ✓ / verify-package 21 ✓。**`guard:lockfile` 未通过**（lock 待重新生成） |
