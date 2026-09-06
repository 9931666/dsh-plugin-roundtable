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
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the conversation SlotMap merge ('conversation.view').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the settings SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RoundTableView, type RoundTableViewInjected } from './RoundTableView.tsx'
import { RoundTableSettings, type RoundTableSettingsInjected } from './RoundTableSettings.tsx'
import { en, NS, zh } from './locales.ts'
import type { RpcCaller } from './wire.ts'

/** Required services: view/settings slots, locale, connection. */
export const inject = ['slots', 'locale', 'connection']

/** Client connection shape: generic RPC caller over the host `/api` channel. */
interface ConnectionHandle {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<RpcResult<unknown>>
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'roundtable: dictionaries')

  const connection = (ctx as unknown as { connection?: ConnectionHandle }).connection
  const rpc: RpcCaller = <T,>(endpoint: string, payload: unknown): Promise<RpcResult<T>> => {
    if (connection === undefined) {
      return Promise.reject(new Error('roundtable: connection service unavailable'))
    }
    // This plugin owns the `/roundtable` channel (its own prefix-routed RPC
    // channel), NOT the shared `/api` channel — that one is a single
    // interceptor owned by dsh-api-gateway, and claiming it here would throw
    // and drop every roundtable call (the "cannot connect" drag-to-connect
    // bug). Mirrors the ya-subagent plugin's own `/ya-subagent` channel.
    return connection.rpc.call('/roundtable', endpoint, payload) as unknown as Promise<RpcResult<T>>
  }

  // ---- Topology tab (conversation.view) --------------------------------
  const viewInjected = (): RoundTableViewInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'roundtable',
    order: 30,
    label: () => ctx.locale.bind(NS)('tab'),
    locale: NS,
    inject: viewInjected,
  }, RoundTableView))

  // ---- Settings page (settings.section) --------------------------------
  const settingsInjected = (): RoundTableSettingsInjected => ({
    rpc,
    t: ctx.locale.bind(NS) as (key: string) => string,
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'roundtable',
    order: 40,
    label: () => ctx.locale.bind(NS)('settingsNav'),
    locale: NS,
    inject: settingsInjected,
  }, RoundTableSettings))
}
