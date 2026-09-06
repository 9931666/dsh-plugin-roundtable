/**
 * RoundTable durable state: atomic file persistence under
 * `<workspace>/<stateDir>/<meetingId>/` with per-meeting process-local locks.
 *
 * - `meeting.json`     — the Meeting record (nodes, edges, decisions, budget).
 * - `charter.md`       — the injected《全局协作总纲》(informational copy).
 * - `transcript.jsonl` — append-only utterance log (torn-tail tolerant on read).
 * - `review.json`      — 针锋相对评审记录（议题/方案/观点/支持标记）。
 * - `user-actions.jsonl` — UI 行为记录（主持人下轮执行）。
 * @module dsh-plugin-roundtable/state
 */

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { FeedbackEntry, Meeting, MeetingUtterance, ReviewRecord, UserAction } from './types.ts'

/** Stable directory id from a display name (keeps CJK, lowercases latin). */
export function sanitizeKey(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'meeting' : cleaned
}

/** Process-local mutex chain keyed by an arbitrary lock key. */
const locks = new Map<string, Promise<unknown>>()

/** Serialize async operations sharing one key inside this process. */
export async function withMeetingLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  locks.set(key, current.then(() => undefined, () => undefined))
  return current
}

/** Absolute state root under a workspace. */
export function stateRootOf(workspace: string, stateDir: string): string {
  return join(workspace, stateDir)
}

/** Absolute directory of one meeting. */
export function meetingDirOf(stateRoot: string, meetingId: string): string {
  return join(stateRoot, meetingId)
}

/** Atomically publish a JSON file (same-directory tmp + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    await rename(tmp, file)
  } catch (error: unknown) {
    await rename(tmp, `${file}.stale-${randomUUID()}`).catch(() => undefined)
    throw error
  }
}

/** Read one meeting record; undefined when absent. */
export async function readMeeting(stateRoot: string, meetingId: string): Promise<Meeting | undefined> {
  try {
    const raw = await readFile(join(stateRoot, meetingId, 'meeting.json'), 'utf8')
    return JSON.parse(raw) as Meeting
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Persist one meeting record (atomic). */
export async function writeMeeting(stateRoot: string, meeting: Meeting): Promise<void> {
  const dir = meetingDirOf(stateRoot, meeting.id)
  await mkdir(dir, { recursive: true })
  meeting.updatedAt = Date.now()
  await writeJsonAtomic(join(dir, 'meeting.json'), meeting)
}

/** Persist the charter text copy. */
export async function writeCharter(stateRoot: string, meeting: Meeting): Promise<void> {
  const dir = meetingDirOf(stateRoot, meeting.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'charter.md'), meeting.charter, 'utf8')
}

/** Append one utterance to the meeting transcript (JSONL). */
export async function appendUtterance(stateRoot: string, meetingId: string, utterance: MeetingUtterance): Promise<void> {
  const dir = meetingDirOf(stateRoot, meetingId)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, 'transcript.jsonl'), JSON.stringify(utterance) + '\n', 'utf8')
}

/** Read the full transcript, skipping torn tails and malformed lines. */
export async function readTranscript(stateRoot: string, meetingId: string): Promise<MeetingUtterance[]> {
  try {
    const raw = await readFile(join(stateRoot, meetingId, 'transcript.jsonl'), 'utf8')
    const out: MeetingUtterance[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as MeetingUtterance)
      } catch {
        // Torn or malformed tail line: ignore and keep reading.
      }
    }
    return out
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** List every meeting id under a state root (missing root = empty). */
export async function listMeetings(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(stateRoot, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Append one user action to the meeting's `user-actions.jsonl` (JSONL). */
export async function appendUserAction(stateRoot: string, meetingId: string, action: UserAction): Promise<void> {
  const dir = meetingDirOf(stateRoot, meetingId)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, 'user-actions.jsonl'), JSON.stringify(action) + '\n', 'utf8')
}

/** Read every pending user action, skipping torn tails and malformed lines. */
export async function readUserActions(stateRoot: string, meetingId: string): Promise<UserAction[]> {
  try {
    const raw = await readFile(join(stateRoot, meetingId, 'user-actions.jsonl'), 'utf8')
    const out: UserAction[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as UserAction)
      } catch {
        // Torn or malformed tail line: ignore and keep reading.
      }
    }
    return out
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Clear every pending user action; returns how many were dropped. */
export async function clearUserActions(stateRoot: string, meetingId: string): Promise<number> {
  const dir = meetingDirOf(stateRoot, meetingId)
  await mkdir(dir, { recursive: true })
  const before = await readUserActions(stateRoot, meetingId)
  await writeFile(join(dir, 'user-actions.jsonl'), '', 'utf8')
  return before.length
}

/** Read the 针锋相对 review record; undefined when absent. Migrates old
 *  schemaVersion-1 records (endorsed boolean, whole-utterance viewpoints) to
 *  the current shape in memory — idempotent, no write-back (next writeReview
 *  persists the upgraded shape). */
export async function readReview(stateRoot: string, meetingId: string): Promise<ReviewRecord | undefined> {
  try {
    const raw = await readFile(join(meetingDirOf(stateRoot, meetingId), 'review.json'), 'utf8')
    return normalizeReview(JSON.parse(raw) as ReviewRecord)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Idempotently upgrade a review record to schemaVersion 2 (in-memory only).
 *  v1: viewpoint = {id(utterance id), nodeKey, content, endorsed, ts} →
 *  v2: {id: `${utteranceId}#${seq}`, utteranceId, nodeKey, content,
 *       status, quote?, dimension, ts, seq}. v2 records created before the
 *  C3 复审轮次 fields existed are given reviewPass=1 / maxReviewPass=3. */
export function normalizeReview(review: ReviewRecord): ReviewRecord {
  const base = (review.schemaVersion ?? 1) === 2 ? review : undefined
  if (base !== undefined) {
    if (typeof review.reviewPass !== 'number' || review.reviewPass < 1) review.reviewPass = 1
    if (typeof review.maxReviewPass !== 'number' || review.maxReviewPass < 1) review.maxReviewPass = 3
    if (!Array.isArray(review.history)) review.history = []
    return review
  }
  const migrated: ReviewRecord = {
    meetingId: review.meetingId,
    question: review.question,
    plan: review.plan,
    status: review.status,
    reviewPass: 1,
    maxReviewPass: 3,
    history: [],
    schemaVersion: 2,
    viewpoints: review.viewpoints.map((viewpoint) => {
      const legacy = viewpoint as unknown as {
        id?: unknown
        nodeKey?: unknown
        content?: unknown
        endorsed?: unknown
        ts?: unknown
      }
      const utteranceId = typeof legacy.id === 'string' ? legacy.id : ''
      const content = typeof legacy.content === 'string' ? legacy.content : ''
      return {
        id: `${utteranceId}#0`,
        utteranceId,
        nodeKey: typeof legacy.nodeKey === 'string' ? legacy.nodeKey : '',
        content,
        status: legacy.endorsed === true ? 'endorsed' : 'pending',
        dimension: '其他',
        ts: typeof legacy.ts === 'number' ? legacy.ts : Date.now(),
        seq: 0,
      }
    }),
    startedAt: review.startedAt,
    updatedAt: review.updatedAt,
  }
  return migrated
}

/** Persist the review record (atomic). */
export async function writeReview(stateRoot: string, meetingId: string, review: ReviewRecord): Promise<void> {
  const dir = meetingDirOf(stateRoot, meetingId)
  await mkdir(dir, { recursive: true })
  review.updatedAt = Date.now()
  await writeJsonAtomic(join(dir, 'review.json'), review)
}

/** Set one viewpoint's three-state status (pending/endorsed/rejected);
 *  when rejecting, the caller must supply a non-empty reason (C2).
 *  Returns true when the value changed. */
export async function setViewpointStatus(
  stateRoot: string,
  meetingId: string,
  viewpointId: string,
  status: 'pending' | 'endorsed' | 'rejected',
  rejectReason?: string,
): Promise<boolean> {
  const review = await readReview(stateRoot, meetingId)
  if (review === undefined) return false
  const viewpoint = review.viewpoints.find((candidate) => candidate.id === viewpointId)
  if (viewpoint === undefined || viewpoint.status === status) return false
  if (status === 'rejected') {
    const reason = rejectReason?.trim() ?? ''
    if (reason === '') throw new Error('rejecting a viewpoint requires a non-empty reject_reason (驳回必填理由)')
    viewpoint.rejectReason = reason.slice(0, 500)
  }
  viewpoint.status = status
  await writeReview(stateRoot, meetingId, review)
  return true
}

/* ------------------------------------------------------------------ *
 * 工作区级匿名反馈（E1/E3）：feedback.jsonl 放在 stateRoot 下（跨会议聚合）。
 * 只记录结构化使用事实 + 用户主动填写的一句说明，绝不记录对话内容。
 * ------------------------------------------------------------------ */

/** Append one feedback entry to `<stateRoot>/feedback.jsonl`. */
export async function appendFeedback(stateRoot: string, entry: FeedbackEntry): Promise<void> {
  await mkdir(stateRoot, { recursive: true })
  await appendFile(join(stateRoot, 'feedback.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
}

/** Read every feedback entry (newest last), skipping torn tails. */
export async function readFeedback(stateRoot: string): Promise<FeedbackEntry[]> {
  try {
    const raw = await readFile(join(stateRoot, 'feedback.jsonl'), 'utf8')
    const out: FeedbackEntry[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as FeedbackEntry)
      } catch {
        // Torn or malformed tail line: ignore and keep reading.
      }
    }
    return out
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Remove every feedback entry for one meeting id (dedupe); returns count removed. */
export async function clearFeedbackForMeeting(stateRoot: string, meetingId: string): Promise<number> {
  const before = await readFeedback(stateRoot)
  const remaining = before.filter((entry) => entry.meetingId !== meetingId)
  await writeFile(join(stateRoot, 'feedback.jsonl'), remaining.map((entry) => JSON.stringify(entry)).join('\n') + (remaining.length > 0 ? '\n' : ''), 'utf8')
  return before.length - remaining.length
}

/** Remove every feedback entry; returns how many were dropped. */
export async function clearFeedback(stateRoot: string): Promise<number> {
  const before = await readFeedback(stateRoot)
  await writeFile(join(stateRoot, 'feedback.jsonl'), '', 'utf8')
  return before.length
}
