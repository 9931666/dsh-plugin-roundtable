/**
 * state.ts 持久化测试（P3）：复用同名会议目录前必须彻底清空旧记录。
 *
 * 背景：roundtable_create 允许复用「已结束会议」的同名 id（id 就是 sanitize
 * 后的会议名）。meeting.json 会被重写，但 transcript.jsonl 是 append-only，
 * review.json / user-actions.jsonl / export.md / kb-digest.json 也都留在原目录
 * ——于是新会议会原样继承上一场的发言与评审结论，用户可能对着另一个议题的
 * 方案点「支持 / 驳回」，而且没有任何提示。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendUtterance,
  readMeeting,
  readReview,
  readTranscript,
  resetMeetingDirectory,
  stateRootOf,
  writeMeeting,
  writeReview,
} from '../src/state.ts'

/** 每个用例一个独立临时目录，避免相互污染。 */
async function tempStateRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'roundtable-state-'))
  return {
    stateRoot: stateRootOf(dir, '.roundtable'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function meetingRecord(overrides = {}) {
  return {
    id: 'same-name-meeting',
    name: '同名会议',
    goal: '议题',
    mode: 'redteam',
    captainSessionId: 'captain-1',
    charter: '',
    nodes: [],
    edges: [],
    decisions: [],
    budget: { maxRounds: 6, maxTokens: 100000, usedRounds: 0, usedTokens: 0 },
    round: 0,
    status: 'ended',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function reviewRecord(meetingId) {
  return {
    meetingId,
    question: '上一场的议题',
    plan: '上一场的方案',
    status: 'done',
    reviewPass: 1,
    maxReviewPass: 3,
    history: [],
    schemaVersion: 2,
    viewpoints: [{
      id: 'u1#0',
      utteranceId: 'u1',
      nodeKey: 'red',
      content: '上一场的缺陷',
      status: 'endorsed',
      dimension: '安全',
      ts: 1,
      seq: 0,
    }],
    startedAt: 1,
    updatedAt: 1,
  }
}

test('P3 回归：resetMeetingDirectory 清空同名会议的既有记录', async () => {
  const { stateRoot, cleanup } = await tempStateRoot()
  try {
    const old = meetingRecord()
    await writeMeeting(stateRoot, old)
    await appendUtterance(stateRoot, old.id, {
      id: 'u1', nodeKey: 'red', kind: 'speech', content: '上一场的发言', round: 0, ts: 1,
    })
    await writeReview(stateRoot, old.id, reviewRecord(old.id))

    // 前置：旧记录确实存在，否则这条断言就是空的。
    assert.equal((await readMeeting(stateRoot, old.id))?.id, old.id)
    assert.equal((await readTranscript(stateRoot, old.id)).length, 1)
    assert.ok((await readReview(stateRoot, old.id)) !== undefined)

    await resetMeetingDirectory(stateRoot, old.id)

    assert.equal(await readMeeting(stateRoot, old.id), undefined, 'meeting.json 必须消失')
    assert.deepEqual(await readTranscript(stateRoot, old.id), [], '上一场的发言不得被继承')
    assert.equal(await readReview(stateRoot, old.id), undefined, '上一场的评审不得被继承')
  } finally {
    await cleanup()
  }
})

test('P3：按 create 的真实顺序（清目录 → 写新 meeting）后，新会议是干净的', async () => {
  const { stateRoot, cleanup } = await tempStateRoot()
  try {
    const first = meetingRecord()
    await writeMeeting(stateRoot, first)
    await appendUtterance(stateRoot, first.id, {
      id: 'u-old', nodeKey: 'red', kind: 'speech', content: '旧发言', round: 0, ts: 1,
    })
    await writeReview(stateRoot, first.id, reviewRecord(first.id))

    // roundtable_create 的顺序：读到已结束的同名会议 → 先清目录 → 再写新记录。
    await resetMeetingDirectory(stateRoot, first.id)
    await writeMeeting(stateRoot, meetingRecord({ goal: '新议题', createdAt: 2, updatedAt: 2 }))

    const fresh = await readMeeting(stateRoot, first.id)
    assert.equal(fresh?.goal, '新议题')
    assert.deepEqual(await readTranscript(stateRoot, first.id), [], '新会议必须是空 transcript')
    assert.equal(await readReview(stateRoot, first.id), undefined, '新会议不得继承旧评审')
  } finally {
    await cleanup()
  }
})

test('P3：对不存在的会议目录是幂等的（不抛错）', async () => {
  const { stateRoot, cleanup } = await tempStateRoot()
  try {
    await resetMeetingDirectory(stateRoot, 'never-existed')
    await resetMeetingDirectory(stateRoot, 'never-existed')
  } finally {
    await cleanup()
  }
})
