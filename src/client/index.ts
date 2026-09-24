/**
 * dsh-plugin-roundtable — browser half.
 *
 * Two registrations:
 *   1. `conversation.view` slot, id `roundtable` — the "圆桌会议" topology tab
 *      (left captain anchor, ring of expert nodes, directed edges with arrows,
 *      breathing-light activity, right-click edge menu, drag-to-connect).
 *   2. `settings.section` slot, id `roundtable` — the preference page
 *      (default collaboration mode + budget defaults).
 *
 * @module @huanlin/dsh-plugin-roundtable/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'// Type-only: pulls the conversation SlotMap merge ('conversation.view').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the settings SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the tool SlotMap merge ('tool.call.toolview').
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: pulls the locale Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RoundTableView, type RoundTableViewInjected } from './RoundTableView.tsx'
import { RoundTableSettings, type RoundTableSettingsInjected } from './RoundTableSettings.tsx'
import { RoundTableStatusView } from './tool-views.tsx'
import { withSlotBoundary } from './slot-boundary.tsx'
import { en, NS, zh } from './locales.ts'
import { callRpc, type RpcCaller, type RpcEnvelope } from './wire.ts'

/**
 * Required services: the two slots registries plus locale. `connection` is NOT
 * listed — cordis `inject` is load-gating (a name here keeps the whole client
 * plugin PENDING until that service exists), so listing the OPTIONAL fallback
 * transport meant a composition without it silently registered neither the
 * 圆桌会议 tab nor the settings page. It is read live via `ctx.get('connection')`
 * instead, which is what the RPC fallback below actually needs.
 */
export const inject = ['slots', 'locale']

/** Client connection shape: generic RPC caller over the host `/api` channel. */
interface ConnectionHandle {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>
  }
}

/**
 * `ctx.slots` is the host's real SlotRegistry face, mirrored member-for-member
 * in `ui-slots-anchor.d.ts` (it cannot be imported: the anchor must stay a
 * global script so the `@deepseek-ai/dsh-client-ui-slots` ambient module keeps
 * existing for this file's and `locales.ts`'s augmentations).
 */
type Slots = Context['slots']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'roundtable: dictionaries')

  // `ctx.slots` is the host's real SlotRegistry face (see ui-slots-anchor.d.ts).
  const slots: Slots = ctx.slots

  // Optional transport: read lazily so this plugin loads whether or not the
  // host's generic connection channel is mounted in the current profile.
  // `ctx.get` is core cordis (non-strict: `undefined` when unavailable) but the
  // consumer build's Context type drops it, hence the structural read.
  const connection = (ctx as unknown as { get?: (name: string) => unknown })
    .get?.('connection') as ConnectionHandle | undefined
  // Preferred transport: the plugin's own web route (same registration as the
  // snapshot route). The host connection channel stays as a fallback for older
  // or non-web profiles, so an unreachable route degrades instead of breaking.
  const rpc: RpcCaller = async <T,>(endpoint: string, payload: unknown): Promise<RpcEnvelope<T>> => {
    const direct = await callRpc<T>(endpoint, payload)
    if (direct.ok || connection === undefined) return direct
    try {
      return await connection.rpc.call('/roundtable', endpoint, payload) as unknown as RpcEnvelope<T>
    } catch {
      return direct
    }
  }

  // ---- Topology tab (conversation.view) --------------------------------
  const viewInjected = (): RoundTableViewInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  // Both entries are wrapped in a render-failure boundary: DSH retires a slot
  // entry that throws, which used to make a plugin bug look like "这个 Tab 根本
  // 不存在" with no message. See slot-boundary.tsx.
  slots.inject('conversation.view', () => slots.register({
    name: 'conversation.view',
    id: 'roundtable',
    order: 30,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: viewInjected,
  }, withSlotBoundary(RoundTableView)))

  // ---- Settings page (settings.section) --------------------------------
  const settingsInjected = (): RoundTableSettingsInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'roundtable',
    order: 40,
    label: () => ctx.locale.bind(NS)('settingsNav'),
    locale: NS,
    inject: settingsInjected,
  }, withSlotBoundary(RoundTableSettings)))

  // ---- Tool view (tool.call.toolview, keyed by tool name) ---------------
  // 只认领本插件自己的工具名：宿主的 key 域是开放的，且"注册自己的工具是
  // additive"——未认领的 key 才回退到通用 tool 行，所以这不会影响任何其他工具。
  // 槽不存在时 inject 回调不执行，属安全降级。
  slots.inject('tool.call.toolview', () => slots.register({
    name: 'tool.call.toolview',
    key: 'roundtable_status',
  }, withSlotBoundary(RoundTableStatusView)))

// ---- 已移除：rightbar.session 常驻（v0.2.36 批次遗留，实测会把宿主顶崩）----
//
// 实测报错（DSH 启动横幅 "Failed to load plugins"）：
//
//   failed to apply loader entry 187e555d (@deepseek-ai/dsh-client-ui-sidebar-right):
//   single slot "rightbar.session" already has a registration at priority 0
//   (registered by Ba) — register at a different priority to shadow it (lowest renders)
//
// 为什么会必然发生：`rightbar.session` 是 **single** 槽，而宿主
// `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` 的注册是「先声明、
// 后注册」两条语句 —— `slots.inject('rightbar', …)` 内先
// `register({ name:'rightbar', children:{ 'rightbar.session': {kind:'single'} } })`
// 提交声明，下一条语句才注册它自己的条目。按宿主 registry.d.ts 的 inject 契约，
// 「声明已提交」这一刻就会同步跑所有等待该键的回调，于是本插件恰好落在这个
// 空档里：读 `entries()` 还是 0（守门失效）→ 抢先用 priority 0 占位 →
// 宿主随后注册同优先级条目被 SlotCore 直接拒绝，**整个宿主右侧栏插件 apply 失败**。
//
// 而且 `priority: -1` 是无效的：宿主 runner（dsh-cordis-client-runner）对非 chain
// 槽会覆盖 options.priority 自行分配。更致命的是被遮蔽的那条宿主条目同时声明了
// `sidebar.right.pane.tab` / `.title` / `.tab.menu.item` 三条子槽，一旦被顶掉，
// 右侧栏整套 tab 体系就失去声明者。宿主 registry.d.ts 对 single 槽的说明本身就是
// 「DO NOT register here」。
//
// 结论：single 槽第三方插件一律不碰。会议面板继续由 `conversation.view`
// 标签页承载（上面第一条注册），能力不减。
}
