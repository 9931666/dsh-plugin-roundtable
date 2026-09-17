/**
 * 预设装配链回归测试（R-A）。
 *
 * 缺陷背景：v0.2.35 的 `rolePresets` 只被**浏览器表单**消费
 * （RoundTableView 选中即填充 role/provider/model 后写 user-actions.jsonl），
 * agent 侧 `tools.ts` 全文没有 rolePresets 引用 —— 主持人在结构上拿不到
 * 用户自建的预设，只能自己临场编一个 role。于是「预设库 → 会议节点」
 * 这条边**在程序里根本不存在**，任何机检都验证不到它，属隐蔽的假绿。
 *
 * 本文件把这条边钉住：预设引用必须能解析、能填充未显式给出的字段、
 * 解析失败必须显式报错而不是静默降级成临时角色。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePreset } from '../src/tools.ts'

const PRESETS = [
  { id: 'arch', name: '架构主审 · V4.1', role: '只审结构，不审实现细节。', provider: 'dshapi', model: 'deepseek-v4.1-flash' },
  { id: 'edge', name: '边界与异常 · GLM-5.3F', role: '只构造极端与非法输入，不谈正常路径。', provider: 'dshapi', model: 'glm-5.3-flash' },
  { id: 'local-only', name: '无路由预设', role: '不挂路由的角色。' },
]

test('resolvePreset：按 id 精确解析', () => {
  const got = resolvePreset(PRESETS, 'arch')
  assert.equal(got?.id, 'arch')
  assert.equal(got?.role, '只审结构，不审实现细节。')
})

test('resolvePreset：按显示名解析（用户常直接抄名字）', () => {
  assert.equal(resolvePreset(PRESETS, '边界与异常 · GLM-5.3F')?.id, 'edge')
})

test('resolvePreset：id 优先于同串的 name', () => {
  const tricky = [
    { id: 'dup', name: '另一条', role: 'r1' },
    { id: 'other', name: 'dup', role: 'r2' },
  ]
  assert.equal(resolvePreset(tricky, 'dup')?.role, 'r1')
})

test('resolvePreset：带空白的引用按 trim 后匹配', () => {
  assert.equal(resolvePreset(PRESETS, '  arch  ')?.id, 'arch')
})

test('resolvePreset：空串与纯空白返回 undefined（不误配第一条）', () => {
  assert.equal(resolvePreset(PRESETS, ''), undefined)
  assert.equal(resolvePreset(PRESETS, '   '), undefined)
})

test('resolvePreset：不存在的引用返回 undefined（由调用方显式报错）', () => {
  assert.equal(resolvePreset(PRESETS, 'no-such-preset'), undefined)
})

test('resolvePreset：空预设库返回 undefined（不抛错，由调用方提示去建预设）', () => {
  assert.equal(resolvePreset([], 'arch'), undefined)
})

test('预设可只带 role 不带路由（应视为"继承主持人"，而非解析失败）', () => {
  const got = resolvePreset(PRESETS, 'local-only')
  assert.equal(got?.id, 'local-only')
  assert.equal(got?.provider, undefined)
  assert.equal(got?.model, undefined)
})
