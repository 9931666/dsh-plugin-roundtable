#!/usr/bin/env node
/**
 * 提示词预算报告（第 4 步「各 AI 之间的提示词与限定」的度量工具）。
 *
 * 回答一个具体问题：**每跑一次请求，模型要白读多少字？** 分三笔账：
 *
 *   1. 常驻·主持人 —— usage 段，每一次请求都付（包括完全不开会的日常对话）；
 *   2. 常驻·工具   —— 全部 tool description，同样每一次请求都付；
 *   3. 常驻·专家   —— charter + persona，跟着**每位专家**的每一次请求付。
 *
 * 它只读源码、不连接任何服务，因此可以随时跑：
 *     node scripts/prompt-budget.mjs
 * 体积上限由 test/prompt-budget.test.mjs 断言 —— 本脚本负责"看见"，测试负责"拦住"。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildCharter } from '../src/charter.ts'
import { nodePersona, usageSectionText } from '../src/prompt.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 基准场景：5 位专家的 orchestrated 会议。 */
function sampleMeeting(mode = 'orchestrated') {
  const nodes = [1, 2, 3, 4, 5].map((i) => ({
    id: `s${i}`,
    key: `expert${i}`,
    role: `角色${i}`,
    status: 'idle',
    joinedAt: i,
  }))
  const edges = nodes.map((node, i) => ({
    id: `e${i}`,
    from: 'captain',
    to: node.key,
    direction: 'bidirectional',
    createdAt: i,
  }))
  return {
    id: 'budget-sample',
    name: '架构评审',
    goal: '在 A/B 两个方案里选一个',
    mode,
    captainSessionId: 'session',
    charter: '',
    nodes,
    edges,
    decisions: [],
    budget: { maxRounds: 8, maxTokens: 160_000, usedRounds: 0, usedTokens: 0 },
    round: 1,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
  }
}

/** tools.ts 里所有 description 字面量的字符总量（工具 schema 也常驻）。 */
function toolDescriptionChars() {
  const source = readFileSync(join(root, 'src', 'tools.ts'), 'utf8')
  const re = /description:\s*(?:'((?:\\.|[^'])*)'|"((?:\\.|[^"])*)"|`((?:\\[\s\S]|[^`])*)`)/g
  let total = 0
  let count = 0
  let match
  while ((match = re.exec(source)) !== null) {
    total += (match[1] ?? match[2] ?? match[3] ?? '').length
    count += 1
  }
  return { total, count }
}

const meeting = sampleMeeting()
const charter = buildCharter(meeting)
const redteam = buildCharter(sampleMeeting('redteam'))
const persona = nodePersona(
  { ...meeting, charter },
  meeting.nodes[0],
  '.roundtable',
  { maxOpinions: 3 },
  { names: ['review-checklist'], delivery: 'relay' },
)
const tools = toolDescriptionChars()

const rows = [
  ['常驻·主持人 usage 段', usageSectionText().length, '每一次请求，含不开会的日常对话'],
  ['常驻·工具 description', tools.total, `${tools.count} 条，工具 schema 随每次请求下发`],
  ['常驻·charter（5 人）', charter.length, '进入每一位专家的 persona'],
  ['常驻·charter（redteam）', redteam.length, '针锋相对模式追加第五节'],
  ['常驻·persona（单专家）', persona.length, 'charter + 该节点规则，随其每次请求'],
  ['常驻·persona（5 专家合计）', persona.length * 5, '专家越多，这份越贵'],
]

const width = Math.max(...rows.map((row) => row[0].length))
console.log('\nRoundTable 提示词预算（字符数，1 汉字≈1 字符）\n')
for (const [label, value, note] of rows) {
  console.log(`  ${label.padEnd(width)}  ${String(value).padStart(6)}   ${note}`)
}
console.log('\n  单次 roundtable_status 最坏渲染:')
console.log('    旧口径 10×800(KB 全文) + 10×400(发言开头) = 12000')
console.log('    新口径 10×180(KB 首行) + 10×240(核心产出)  ≈  4200')
console.log('    加上 since=<next_since> 只需回增量，而不是每轮重发同一批尾巴。\n')
