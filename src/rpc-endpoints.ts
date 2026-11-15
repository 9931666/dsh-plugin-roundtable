/**
 * RPC 端点的闸门声明表（H9 的落地部分）。
 *
 * ## 为什么单独一个文件
 *
 * `rpc.ts` 里的 dispatch 是一个约 350 行的 switch：每个 case 自己决定要不要写
 * `{ requireActive: true }`。这个模式出过一次真实事故 —— `kb.list` 漏了闸门，
 * 而**漏写不会有任何报错**，只有人工比对才能发现（H5）。
 *
 * 完整重写成 handler 表风险太大（改动面覆盖全部 19 个端点、且中途出过错），
 * 所以这里先只做**声明 + 校验**这一层，收益已经确定：
 *
 *   1. 「哪些端点要求会议进行中」从散落的手抄变成一张可横向比对的表；
 *   2. `dispatch` 在调用前做一次断言 —— 声明为写入类但忘了真加闸门时，**直接报错**
 *      而不是静默放行；
 *   3. 新增端点若没在这张表里登记，同样会被拦下。
 *
 * 等将来把 switch 真正拆成 handler 表时，这张表就是现成的骨架。
 *
 * @module dsh-plugin-roundtable/rpc-endpoints
 */

/**
 * 端点分类。
 *
 * - `meeting-write`：改动某场会议的状态，**必须**要求会议仍在进行中；
 * - `meeting-read`：读取某场会议（也可能加闸门，例如 kb.list 与 kb.path.set 对称）；
 * - `global`：与会话/会议状态无关（偏好、模型目录、反馈汇总）。
 */
export type EndpointClass = 'meeting-write' | 'meeting-read' | 'global'

/** 一个端点的声明。 */
export interface EndpointSpec {
  readonly endpoint: string
  readonly kind: EndpointClass
  /** 运行时是否真的传了 `{ requireActive: true }`。由 `dispatch` 回填校验。 */
  readonly requireActive: boolean
  /** 一句话说明这个端点做什么（用于报错与将来的文档生成）。 */
  readonly purpose: string
}

/**
 * 全部端点声明。
 *
 * **新增端点必须在这里登记**：`dispatch` 会用 `ENDPOINTS` 反查，未登记的端点
 * 一律拒绝，避免"加了端点忘了分类"。
 */
export const ENDPOINTS: readonly EndpointSpec[] = [
  // ---- 全局（无需会议状态） ----
  { endpoint: 'roundtable/prefs.get', kind: 'global', requireActive: false, purpose: '读偏好' },
  { endpoint: 'roundtable/prefs.set', kind: 'global', requireActive: false, purpose: '写偏好' },
  { endpoint: 'roundtable/models.list', kind: 'global', requireActive: false, purpose: '模型目录（专家下拉）' },
  { endpoint: 'roundtable/feedback.list', kind: 'global', requireActive: false, purpose: '反馈列表' },
  { endpoint: 'roundtable/feedback.clear', kind: 'global', requireActive: false, purpose: '清空反馈' },

  // ---- 会议写入（必须 active） ----
  { endpoint: 'roundtable/edge.add', kind: 'meeting-write', requireActive: true, purpose: '加连线' },
  { endpoint: 'roundtable/edge.set', kind: 'meeting-write', requireActive: true, purpose: '改连线方向' },
  { endpoint: 'roundtable/edge.remove', kind: 'meeting-write', requireActive: true, purpose: '删连线' },
  { endpoint: 'roundtable/user-actions.append', kind: 'meeting-write', requireActive: true, purpose: '记录用户待办行为' },
  { endpoint: 'roundtable/kb.path.set', kind: 'meeting-write', requireActive: true, purpose: '设置知识库路径' },
  { endpoint: 'roundtable/feedback.append', kind: 'meeting-write', requireActive: false, purpose: '提交反馈（不要求 active：会议结束后才问）' },

  // ---- 会议读取 ----
  { endpoint: 'roundtable/kb.list', kind: 'meeting-read', requireActive: true, purpose: '列知识库目录（与 kb.path.set 对称）' },
  { endpoint: 'roundtable/user-actions.list', kind: 'meeting-read', requireActive: false, purpose: '读用户待办行为' },
  { endpoint: 'roundtable/review.get', kind: 'meeting-read', requireActive: false, purpose: '读评审（旧端点）' },

  // ---- 评审表态（不要求 active：定稿后仍可改表态） ----
  { endpoint: 'roundtable/review.setStatus', kind: 'meeting-write', requireActive: false, purpose: '观点三态' },
  { endpoint: 'roundtable/review.endorse', kind: 'meeting-write', requireActive: false, purpose: '观点认定（旧别名）' },

  // ---- 会议删除（不要求 active：已结束的会议正是最该能删的） ----
  { endpoint: 'roundtable/meeting.delete', kind: 'meeting-write', requireActive: false, purpose: '删除会议' },
]

/** 按 endpoint 名字反查声明。 */
export const ENDPOINT_INDEX: ReadonlyMap<string, EndpointSpec> = new Map(
  ENDPOINTS.map((spec) => [spec.endpoint, spec]),
)

/**
 * 校验一次调用是否符合声明。
 *
 * @param endpoint - 实际被调用的端点
 * @param passedRequireActive - 该端点实现里是否真的传了 `requireActive: true`
 * @returns 错误信息；`undefined` = 合规。
 */
export function checkEndpointGate(endpoint: string, passedRequireActive: boolean): string | undefined {
  const spec = ENDPOINT_INDEX.get(endpoint)
  if (spec === undefined) {
    return `endpoint "${endpoint}" is not declared in rpc-endpoints.ts — add it there before using it`
  }
  if (spec.kind === 'meeting-write' && spec.requireActive && !passedRequireActive) {
    return `endpoint "${endpoint}" is declared as a meeting write that requires an active meeting, but its implementation did not pass { requireActive: true }`
  }
  return undefined
}

/**
 * 声明表自检：写入类端点必须明确表态要不要闸门，避免"忘了想"。
 *
 * 由 `scripts/compatibility.mjs` 的同类检查（或测试）调用；返回问题列表。
 */
export function auditEndpointDeclarations(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const spec of ENDPOINTS) {
    if (seen.has(spec.endpoint)) problems.push(`duplicate endpoint declaration: ${spec.endpoint}`)
    seen.add(spec.endpoint)
    if (spec.purpose.trim() === '') problems.push(`endpoint ${spec.endpoint} has no purpose`)
    if (spec.kind === 'global' && spec.requireActive) {
      problems.push(`endpoint ${spec.endpoint} is global but declares requireActive`)
    }
  }
  return problems
}
