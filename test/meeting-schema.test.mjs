/**
 * meeting.json 的 schema 版本与迁移通道。
 *
 * 背景：`meeting.json` 是本插件最核心的持久化文件，却在 v0.2.36 之前是全插件
 * 唯一「裸 `JSON.parse(...) as Meeting`」——形状一变就静默读坏，而且没有任何
 * 版本号可供分支。本组测试把「读老文件必须仍然可用」钉成回归。
 *
 * 与 review.json 的 normalizeReview 同款契约，三条重点：
 *   1. 缺失 schemaVersion 的旧文件按 v1 处理并升级；
 *   2. 来自「未来版本」的文件原样可读，不做降级猜测；
 *   3. 迁移失败/版本非法都**不得让读会议抛错**——读不出来比读得不完美严重
 *      得多，那会让整场会议从界面上消失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CURRENT_MEETING_SCHEMA_VERSION,
  meetingDirOf,
  normalizeMeeting,
  readMeeting,
  stateRootOf,
  writeMeeting,
} from '../src/state.ts'

async function tempStateRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'roundtable-schema-'))
  return {
    stateRoot: stateRootOf(dir, '.roundtable'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** 一份「v0.2.36 之前」形状的会议记录：完全没有 schemaVersion。 */
function legacyMeeting(overrides = {}) {
  return {
    id: 'legacy-meeting',
    name: '旧会议',
    goal: '议题',
    mode: 'redteam',
    captainSessionId: 'captain-1',
    charter: '旧的《全局协作总纲》',
    nodes: [],
    edges: [],
    decisions: [],
    budget: { maxRounds: 10, maxTokens: 200000, usedRounds: 0, usedTokens: 0 },
    round: 0,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

test('缺失 schemaVersion 的旧文件按 v1 处理并升级到当前版本', () => {
  const out = normalizeMeeting(legacyMeeting())
  assert.equal(out.schemaVersion, CURRENT_MEETING_SCHEMA_VERSION)
  // 新增字段不产生 undefined，全部由缺省值补齐
  assert.deepEqual(out.nodes, [])
  assert.deepEqual(out.edges, [])
  assert.deepEqual(out.decisions, [])
  assert.equal(out.charter, '旧的《全局协作总纲》')
})

test('normalizeMeeting 幂等：重复调用结果一致', () => {
  const once = normalizeMeeting(legacyMeeting())
  const twice = normalizeMeeting(once)
  assert.deepEqual(twice, once)
})

test('已是当前版本时不改写任何业务字段', () => {
  const meeting = legacyMeeting({ schemaVersion: CURRENT_MEETING_SCHEMA_VERSION, round: 3 })
  const out = normalizeMeeting(meeting)
  assert.equal(out.round, 3)
  assert.equal(out.schemaVersion, CURRENT_MEETING_SCHEMA_VERSION)
  assert.equal(out.charter, '旧的《全局协作总纲》')
})

test('来自未来版本的文件原样可读，不做降级猜测', () => {
  const future = legacyMeeting({ schemaVersion: CURRENT_MEETING_SCHEMA_VERSION + 3, round: 7 })
  const out = normalizeMeeting(future)
  assert.equal(out.round, 7)
  // 关键：不把版本号改小，否则会把「它其实更新」这一事实抹掉
  assert.equal(out.schemaVersion, CURRENT_MEETING_SCHEMA_VERSION + 3)
})

test('版本号非法（0 / 负数 / 小数 / 字符串 / null）一律归一到 v1', () => {
  for (const bad of [0, -5, 1.5, '2', null, undefined]) {
    const out = normalizeMeeting(legacyMeeting({ schemaVersion: bad }))
    assert.equal(
      out.schemaVersion,
      CURRENT_MEETING_SCHEMA_VERSION,
      `schemaVersion=${JSON.stringify(bad)} 应归一到当前版本`,
    )
  }
})

test('字段缺失/类型不符时补齐缺省值，不让 undefined 混进后续计算', () => {
  const broken = legacyMeeting({
    nodes: undefined,
    edges: null,
    decisions: 'not-an-array',
    round: undefined,
    charter: undefined,
    budget: { maxRounds: 5 },
  })
  const out = normalizeMeeting(broken)
  assert.deepEqual(out.nodes, [])
  assert.deepEqual(out.edges, [])
  assert.deepEqual(out.decisions, [])
  assert.equal(out.round, 0)
  assert.equal(out.charter, '')
  assert.equal(out.budget.maxRounds, 5, '已有的值必须保住')
  assert.equal(out.budget.maxTokens, 200000, '缺失的值补缺省')
  assert.equal(out.budget.usedRounds, 0)
})

test('readMeeting 能读没有 schemaVersion 的旧文件（不抛错）', async () => {
  const { stateRoot, cleanup } = await tempStateRoot()
  try {
    const dir = meetingDirOf(stateRoot, 'legacy-meeting')
    await mkdir(dir, { recursive: true })
    // 直接落一份旧形状的文件，绕过 writeMeeting（它会自动补版本号）
    await writeFile(join(dir, 'meeting.json'), JSON.stringify(legacyMeeting()), 'utf8')

    const read = await readMeeting(stateRoot, 'legacy-meeting')
    assert.notEqual(read, undefined)
    assert.equal(read.schemaVersion, CURRENT_MEETING_SCHEMA_VERSION)
    assert.equal(read.charter, '旧的《全局协作总纲》')
  } finally {
    await cleanup()
  }
})

test('读写闭环：旧文件被 writeMeeting 落盘时自动升到当前版本', async () => {
  const { stateRoot, cleanup } = await tempStateRoot()
  try {
    const dir = meetingDirOf(stateRoot, 'legacy-meeting')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meeting.json'), JSON.stringify(legacyMeeting()), 'utf8')

    const read = await readMeeting(stateRoot, 'legacy-meeting')
    await writeMeeting(stateRoot, read)

    const onDisk = JSON.parse(await readFile(join(dir, 'meeting.json'), 'utf8'))
    assert.equal(onDisk.schemaVersion, CURRENT_MEETING_SCHEMA_VERSION, '落盘后必须带上版本号')
    assert.equal(onDisk.charter, '旧的《全局协作总纲》', '升级不得丢失原有内容')
  } finally {
    await cleanup()
  }
})
