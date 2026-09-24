/**
 * Web 路由的认证栅栏（第 2 批 / P5）。
 *
 * 插件自建的两条 Web 路由（`/plugins/dsh-plugin-roundtable/rpc` 与 `.../state`）
 * 注册在宿主 `webServer` 上，而宿主 webserver 自述 "knows no harness concepts"、
 * handler 只有裸 `(req, res)` —— 栅栏**不会自动施加**。宿主为此专门暴露了
 * `connection.requestRejection()`，其文档原文就是："Apply Connection's
 * Host/Origin checks and browser authentication to another Web route"。
 *
 * 不接它的后果是真实的：本机任意网页（DNS rebinding 后同源，或 `text/plain`
 * 简单 POST 免预检）都能命中插件路由 —— 删会议、改连线、读走全部评审内容与
 * 发言。宿主自己的 `/api` 有栅栏，插件这两条路由曾是缺口。
 *
 * @module dsh-plugin-roundtable/web-guard
 */

import type { IncomingMessage } from 'node:http'

/** The single Connection ability this guard needs. */
export interface ConnectionFence {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Request-body cap for the plugin RPC route (1 MiB — same order as the host's own API). */
export const MAX_RPC_BODY_BYTES = 1_048_576

/** Pick the fence out of a possibly-absent service (never load-gating). */
export function connectionFenceOf(service: unknown): ConnectionFence | undefined {
  if (service === null || service === undefined) return undefined
  const candidate = service as { requestRejection?: unknown }
  if (typeof candidate.requestRejection !== 'function') return undefined
  return candidate as ConnectionFence
}

/**
 * Decide whether one inbound request may proceed.
 *
 * @returns the HTTP status to reject with, or `undefined` to proceed.
 *
 * A composition without the Connection service has no fence to apply and is let
 * through — the plugin must stay usable in minimal profiles. A fence that
 * *throws* is treated as a rejection: this is a security boundary, and failing
 * open would silently undo it.
 */
export function rejectWebRequest(
  fence: ConnectionFence | undefined,
  headers: IncomingMessage['headers'],
): 401 | 403 | undefined {
  if (fence === undefined) return undefined
  try {
    return fence.requestRejection({ headers })
  } catch {
    return 403
  }
}
