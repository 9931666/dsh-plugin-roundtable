/**
 * web-guard.ts 测试（第 2 批 / P5）：Web 路由认证栅栏的判定逻辑。
 *
 * 栅栏本身由宿主提供，这里锁死的是插件的三处决策：
 * 有栅栏就必须用、没有栅栏不能瘫痪、栅栏抛错时**不能 fail-open**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionFenceOf, MAX_RPC_BODY_BYTES, rejectWebRequest } from '../src/web-guard.ts'

const HEADERS = { host: '127.0.0.1:3080', cookie: 'x=1' }

test('rejectWebRequest：栅栏放行时返回 undefined', () => {
  const fence = { requestRejection: () => undefined }
  assert.equal(rejectWebRequest(fence, HEADERS), undefined)
})

test('rejectWebRequest：透传栅栏的 401 / 403', () => {
  assert.equal(rejectWebRequest({ requestRejection: () => 401 }, HEADERS), 401)
  assert.equal(rejectWebRequest({ requestRejection: () => 403 }, HEADERS), 403)
})

test('rejectWebRequest：没有栅栏（最小 profile）时放行，插件不能因此瘫痪', () => {
  assert.equal(rejectWebRequest(undefined, HEADERS), undefined)
})

test('rejectWebRequest：栅栏抛错时一律拒绝，绝不 fail-open', () => {
  const broken = {
    requestRejection: () => {
      throw new Error('browser auth exploded')
    },
  }
  assert.equal(rejectWebRequest(broken, HEADERS), 403, '这是安全边界，异常必须按拒绝处理')
})

test('rejectWebRequest：把请求头原样交给栅栏（Host/Origin 检查依赖它）', () => {
  let seen
  const fence = {
    requestRejection: (request) => {
      seen = request.headers
      return undefined
    },
  }
  rejectWebRequest(fence, HEADERS)
  assert.deepEqual(seen, HEADERS)
})

test('connectionFenceOf：缺失 / 形状不对的服务都返回 undefined', () => {
  assert.equal(connectionFenceOf(undefined), undefined)
  assert.equal(connectionFenceOf(null), undefined)
  assert.equal(connectionFenceOf({}), undefined, '没有 requestRejection 的服务不算栅栏')
  assert.equal(connectionFenceOf({ requestRejection: 'not-a-function' }), undefined)
})

test('connectionFenceOf：形状正确时返回同一个服务对象', () => {
  const fence = { requestRejection: () => undefined }
  assert.equal(connectionFenceOf(fence), fence)
})

test('MAX_RPC_BODY_BYTES：有明确上限且为 1 MiB 量级', () => {
  assert.equal(MAX_RPC_BODY_BYTES, 1_048_576)
})
