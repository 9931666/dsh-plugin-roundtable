/**
 * 知识库摘要缓存（C2）：让主持人不必为同一个文件重复读两遍。
 *
 * 分工刻意划清——本模块**不调用任何 LLM**，只做三件事：
 *   1. 失效判定：`path + size + mtimeMs` 任一变化即失效（宿主
 *      `listKbDirectory()` 本来就在 stat 每个条目，比对不额外产生 IO）；
 *   2. 合并与淘汰：同 path 覆盖；超条数 / 超长度按最旧淘汰；
 *   3. 把缓存条目与磁盘现状比对，供 `roundtable_status` 直接展示
 *      "哪条还能用、哪条得重读"。
 *
 * digest 正文由主持人读过文件后写下（`roundtable_kb_digest` 工具）。
 * 缓存**不参与预算计数**：它不消耗模型 token。
 *
 * @module dsh-plugin-roundtable/kb-digest
 */

import { stat } from 'node:fs/promises'
import type { KbDigestEntry } from './types.ts'

/** 缓存条目数上限；超出按 `ts` 最旧淘汰。 */
export const KB_DIGEST_MAX_ENTRIES = 50

/** 单条摘要字符上限；超出截断（缓存是"要点"，不是全文副本）。 */
export const KB_DIGEST_MAX_CHARS = 2000

/** 一条缓存条目，外加它相对磁盘现状是否仍然有效。 */
export interface KbDigestStatusEntry extends KbDigestEntry {
  /** true = 失效键未变，摘要可直接使用；false = 文件变了/读不到，必须重读。 */
  valid: boolean
}

/**
 * 失效判定（纯函数）：失效键完全一致才算命中。
 *
 * `current === undefined`（文件已不存在 / 读不到）一律视为失效——宁可让
 * 主持人多读一次，也不要拿一份可能过期的摘要去回答专家。
 */
export function digestIsFresh(
  entry: Pick<KbDigestEntry, 'size' | 'mtimeMs'>,
  current: { size: number; mtimeMs: number } | undefined,
): boolean {
  if (current === undefined) return false
  return entry.size === current.size && entry.mtimeMs === current.mtimeMs
}

/**
 * 合并一条摘要（纯函数）：同 `path` 覆盖，其余按 `ts` 从新到旧保留，
 * 超出 `maxEntries` 的部分淘汰最旧。返回新数组，不改动入参。
 */
export function mergeKbDigestEntry(
  entries: readonly KbDigestEntry[],
  next: KbDigestEntry,
  maxEntries: number = KB_DIGEST_MAX_ENTRIES,
): KbDigestEntry[] {
  const kept = entries.filter((entry) => entry.path !== next.path)
  kept.push({ ...next, digest: next.digest.slice(0, KB_DIGEST_MAX_CHARS) })
  kept.sort((a, b) => b.ts - a.ts)
  return kept.slice(0, Math.max(1, maxEntries))
}

/**
 * 用磁盘现状标注每条缓存的 `valid`。
 *
 * 每条一次 `stat`：条目上限是 {@link KB_DIGEST_MAX_ENTRIES}（50），
 * 而且只在 `roundtable_status` 里调用，成本可忽略。
 */
export async function evaluateKbDigests(
  entries: readonly KbDigestEntry[],
): Promise<KbDigestStatusEntry[]> {
  const out: KbDigestStatusEntry[] = []
  for (const entry of entries) {
    let valid = false
    try {
      const info = await stat(entry.path)
      valid = info.isFile() && digestIsFresh(entry, { size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 文件被删/改名/无权限：缓存失效，让主持人重读。
      valid = false
    }
    out.push({ ...entry, valid })
  }
  return out
}
