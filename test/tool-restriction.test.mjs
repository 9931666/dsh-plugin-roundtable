/**
 * 节点工具面过滤的回归测试。
 *
 * 缺陷背景：`ToolRuntime.restrict()` 对**宿主未注册的工具名**会直接抛错
 * （"unknown global tools"），而 `NODE_ALLOWED_TOOLS` 是一份与宿主无关的
 * 愿望清单——本机宿主实名是 `pwsh` / `edit` / `list_agents`，没有
 * `bash` / `str_replace_editor` / `list_subagent_models`。因此在
 * `skill_delivery=direct` 下，节点 spawn 会在传 restrict 的那一刻整体失败，
 * 且报错指向的是一个本环境根本不存在的工具名，难以归因。
 *
 * 修法是把愿望清单按宿主真实注册表过滤后再传（`isRegistered` 回调）。
 * 这份测试用**主持人视角的注册表**（CAPTAIN_TOOLS）驱动它，因为过滤查询
 * 就是 `ctx.tools.get(name, captain)`：主持人专属的 deny 名单工具在主持人
 * 视角下是存在的，必须保留在 deny 里才能真正挡住节点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeToolRestriction } from '../src/members.ts'

/**
 * 模拟「主持人可见」的工具注册表：本机宿主实名 + 全部圆桌工具
 * （含主持人专属的 create / add_node / request_decision …，它们正是 deny 的标的）。
 */
const CAPTAIN_TOOLS = new Set([
  // 通用实名（本机无 bash / str_replace_editor / list_subagent_models）
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh',
  'todo_write', 'web_search', 'web_fetch',
  'send_message', 'interrupt_agent', 'list_agents',
  'job_list', 'job_output', 'job_kill',
  // 圆桌工具：专家可用的
  'roundtable_speak', 'roundtable_send_message', 'roundtable_summarize',
  'roundtable_status', 'roundtable_actions_clear', 'roundtable_start_review',
  'roundtable_proxy_think',
  // 圆桌工具：主持人专属（deny 标的）
  'roundtable_create', 'roundtable_plan_meeting', 'roundtable_add_node',
  'roundtable_remove_node', 'roundtable_connect', 'roundtable_disconnect',
  'roundtable_request_decision', 'roundtable_set_budget', 'roundtable_close',
  'roundtable_collect_review', 'roundtable_finish_review',
  'roundtable_export_review', 'roundtable_export_meeting', 'roundtable_kb_digest',
  // direct 模式下专家自行加载 skill
  'skill',
])
const isRegistered = (name) => CAPTAIN_TOOLS.has(name)

test('relay 模式只发 deny，不发 allow', () => {
  const r = nodeToolRestriction('relay', isRegistered)
  assert.equal(r.allow, undefined)
  assert.ok(Array.isArray(r.deny) && r.deny.length > 0, 'deny 不应为空')
})

test('direct 模式发 allow + deny', () => {
  const r = nodeToolRestriction('direct', isRegistered)
  assert.ok(Array.isArray(r.allow))
  assert.ok(Array.isArray(r.deny))
})

test('过滤后不含宿主未注册的工具名（这正是旧版 spawn 失败的原因）', () => {
  const r = nodeToolRestriction('direct', isRegistered)
  for (const name of [...r.allow, ...r.deny]) {
    assert.ok(CAPTAIN_TOOLS.has(name), `过滤后仍残留未注册工具名：${name}`)
  }
})

test('本机没有 bash / str_replace_editor / list_subagent_models 时，它们被剔除', () => {
  const r = nodeToolRestriction('direct', isRegistered)
  for (const name of ['bash', 'str_replace_editor', 'list_subagent_models']) {
    assert.ok(!r.allow.includes(name), `${name} 应从 allow 中剔除`)
    assert.ok(!r.deny.includes(name), `${name} 应从 deny 中剔除`)
  }
})

test('宿主确实注册的工具被保留（过滤不能把清单清空）', () => {
  const r = nodeToolRestriction('direct', isRegistered)
  assert.ok(r.allow.includes('roundtable_speak'), '专家协作工具应保留')
  assert.ok(r.allow.includes('skill'), 'direct 模式下 skill 应保留')
  assert.ok(r.allow.includes('pwsh'), '本机实名 shell 应保留')
})

test('主持人专属工具仍在 deny 里（过滤不能把权限闸门放空）', () => {
  const r = nodeToolRestriction('direct', isRegistered)
  for (const name of ['roundtable_create', 'roundtable_add_node', 'roundtable_close', 'roundtable_kb_digest']) {
    assert.ok(r.deny.includes(name), `${name} 必须在 deny 中`)
    assert.ok(!r.allow.includes(name), `${name} 不应出现在 allow 中`)
  }
})

test('relay 模式下 deny 同样经过过滤，但闸门工具保留', () => {
  const r = nodeToolRestriction('relay', isRegistered)
  assert.ok(r.deny.includes('roundtable_create'))
  assert.ok(r.deny.includes('roundtable_close'))
})

test('未传 isRegistered 时保持旧行为：整份清单原样传入', () => {
  const r = nodeToolRestriction('direct')
  assert.ok(r.allow.includes('bash'), '未过滤时应保留愿望清单原样')
  assert.ok(r.allow.includes('str_replace_editor'))
})

test('isRegistered 全 false 时清单为空（不抛错，交由宿主决定）', () => {
  const r = nodeToolRestriction('direct', () => false)
  assert.deepEqual(r.allow, [])
  assert.deepEqual(r.deny, [])
})

test('默认参数是 relay（不传模式时不启用 allow 白名单）', () => {
  const r = nodeToolRestriction()
  assert.equal(r.allow, undefined)
})
