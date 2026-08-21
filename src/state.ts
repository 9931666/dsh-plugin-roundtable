/**
 * RoundTable durable state: atomic file persistence under
 * `<workspace>/<stateDir>/<meetingId>/` with per-meeting process-local locks.
 *
 * - `meeting.json`     — the Meeting record (nodes, edges, decisions, budget).
 * - `charter.md`       — the injected《全局协作总纲》(informational copy).
 * - `transcript.jsonl` — append-only utterance log (torn-tail tolerant on read).
 * @module dsh-plugin-roundtable/state
 */

import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { Meeting, MeetingUtterance } from './types.ts'

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
