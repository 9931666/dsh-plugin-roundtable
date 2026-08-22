/**
 * The aggregation gateway (V1): a deterministic structured merge of the
 * transcript — no extra model. It groups utterances by speaker, keeps the
 * most recent lines per speaker, and emits a compact canonical view for the
 * captain. A model-side summary can later be layered on top by the captain.
 * @module dsh-plugin-roundtable/aggregator
 */

import type { MeetingUtterance } from './types.ts'

const MAX_LENGTH = 4000
const MAX_PER_UTTERANCE = 160

/** Pull the "core output" / stance out of a formatted contribution, else compact the whole text. */
function extractCore(text: string): string {
  const core = text.match(/\[核心产出\]\s*([\s\S]*?)(?=\n\s*\[|$)/)?.[1]?.trim()
  if (core) return core
  const stance = text.match(/(?:立场|主张|观点|结论)[：:]\s*([\s\S]*?)(?=\n|$)/)?.[1]?.trim()
  if (stance) return stance
  return text.replace(/\s+/g, ' ').trim()
}

function compact(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit)}…` : single
}

/** Merge utterances into a compact, chronological exchange (who → whom: core point). */
export function aggregateUtterances(utterances: readonly MeetingUtterance[], maxLength = MAX_LENGTH): string {
  const lines: string[] = []
  for (const utterance of utterances) {
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    const from = utterance.nodeKey
    const to = utterance.to ?? '网关'
    const body = compact(extractCore(utterance.summary ?? utterance.content), MAX_PER_UTTERANCE)
    lines.push(`[R${utterance.round}] ${from} → ${to}\n${body}`)
  }
  const text = `[汇聚网关·交锋摘要]\n${lines.join('\n\n') || '（暂无发言）'}`
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…(截断)` : text
}

/** Count utterances accepted into the digest (speech-like only). */
export function speechCount(utterances: readonly MeetingUtterance[]): number {
  return utterances.filter((utterance) => utterance.kind === 'speech' || utterance.kind === 'proxy-thinking').length
}
