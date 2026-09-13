/**
 * kb-digest.ts 纯函数测试（R6/C2）：失效判定、合并淘汰、失效标注。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  digestIsFresh,
  evaluateKbDigests,
  KB_DIGEST_MAX_CHARS,
  KB_DIGEST_MAX_ENTRIES,
  mergeKbDigestEntry,
} from '../src/kb-digest.ts'

test('digestIsFresh：失效键完全一致才算命中', () => {
  const entry = { size: 10, mtimeMs: 100 }
  assert.equal(digestIsFresh(entry, { size: 10, mtimeMs: 100 }), true)
  assert.equal(digestIsFresh(entry, { size: 11, mtimeMs: 100 }), false, 'size 变化应失效')
  assert.equal(digestIsFresh(entry, { size: 10, mtimeMs: 101 }), false, 'mtime 变化应失效')
})

test('digestIsFresh：文件读不到（undefined）一律视为失效', () => {
  assert.equal(digestIsFresh({ size: 1, mtimeMs: 1 }, undefined), false)
})

test('mergeKbDigestEntry：同一 path 覆盖，不产生重复条目', () => {
  const first = { path: '/kb/a.md', size: 1, mtimeMs: 1, digest: '旧摘要', ts: 1 }
  const second = { path: '/kb/a.md', size: 2, mtimeMs: 2, digest: '新摘要', ts: 2 }
  const merged = mergeKbDigestEntry([first], second)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].digest, '新摘要')
  assert.equal(merged[0].size, 2)
})

test('mergeKbDigestEntry：按 ts 从新到旧排序', () => {
  const stale = { path: '/kb/old.md', size: 1, mtimeMs: 1, digest: 'd', ts: 1 }
  const fresh = { path: '/kb/new.md', size: 1, mtimeMs: 1, digest: 'd', ts: 2 }
  const merged = mergeKbDigestEntry([stale], fresh)
  assert.deepEqual(merged.map((entry) => entry.path), ['/kb/new.md', '/kb/old.md'])
})

test('mergeKbDigestEntry：超出条数上限时淘汰最旧的一条', () => {
  const many = Array.from({ length: KB_DIGEST_MAX_ENTRIES }, (_, index) => ({
    path: `/kb/${index}.md`,
    size: 1,
    mtimeMs: 1,
    digest: 'd',
    ts: index,
  }))
  const merged = mergeKbDigestEntry(many, { path: '/kb/newest.md', size: 1, mtimeMs: 1, digest: 'd', ts: 9999 })
  assert.equal(merged.length, KB_DIGEST_MAX_ENTRIES)
  assert.equal(merged[0].path, '/kb/newest.md', '最新写入的排最前')
  assert.ok(!merged.some((entry) => entry.path === '/kb/0.md'), 'ts 最小的条目应被淘汰')
})

test('mergeKbDigestEntry：超长摘要被截断，且不改动入参数组', () => {
  const input = [{ path: '/kb/a.md', size: 1, mtimeMs: 1, digest: 'x', ts: 1 }]
  const merged = mergeKbDigestEntry(input, {
    path: '/kb/b.md',
    size: 1,
    mtimeMs: 1,
    digest: 'y'.repeat(KB_DIGEST_MAX_CHARS + 500),
    ts: 2,
  })
  assert.equal(merged.find((entry) => entry.path === '/kb/b.md').digest.length, KB_DIGEST_MAX_CHARS)
  assert.equal(input.length, 1, '不应改动入参数组')
})

test('evaluateKbDigests：磁盘上不存在的文件一律标注为失效', async () => {
  const out = await evaluateKbDigests([
    { path: '/definitely/not/here.md', size: 1, mtimeMs: 1, digest: 'd', ts: 1 },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].valid, false)
  assert.equal(out[0].digest, 'd', '失效不意味着丢弃摘要内容')
})

test('evaluateKbDigests：空缓存返回空数组', async () => {
  assert.deepEqual(await evaluateKbDigests([]), [])
})
