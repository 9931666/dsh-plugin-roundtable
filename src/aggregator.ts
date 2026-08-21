/**
 * The aggregation gateway (V1): a deterministic structured merge of the
 * transcript — no extra model. It groups utterances by speaker, keeps the
 * most recent lines per speaker, and emits a compact canonical view for the
 * captain. A model-side summary can later be layered on top by the captain.
 * @module dsh-plugin-roundtable/aggregator
 */

import type { MeetingUtterance } from './types.ts'

const KEEP_PER_SPEAKER = 3
const MAX_LENGTH = 4000

/** Merge utterances into the gateway's structured digest. */
export function aggregateUtterances(utterances: readonly MeetingUtterance[], maxLength = MAX_LENGTH): string {
  const bySpeaker = new Map<string, MeetingUtterance[]>()
  for (const utterance of utterances) {
    if (utterance.kind !== 'speech' && utterance.kind !== 'proxy-thinking') continue
    const list = bySpeaker.get(utterance.nodeKey) ?? []
    list.push(utterance)
    bySpeaker.set(utterance.nodeKey, list)
  }
  const sections: string[] = []
  for (const [speaker, items] of bySpeaker) {
    const recent = items.slice(-KEEP_PER_SPEAKER)
    const body = recent
      .map((item) => `[R${item.round}] ${item.summary ?? item.content}`)
      .join('\n---\n')
    sections.push(`### ${speaker}\n${body}`)
  }
  const text = `[汇聚网关·结构化摘要]\n${sections.join('\n\n') || '（暂无发言）'}`
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n…(截断)` : text
}

/** Count utterances accepted into the digest (speech-like only). */
export function speechCount(utterances: readonly MeetingUtterance[]): number {
  return utterances.filter((utterance) => utterance.kind === 'speech' || utterance.kind === 'proxy-thinking').length
}
