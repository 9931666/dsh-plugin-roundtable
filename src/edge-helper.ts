/**
 * Locate the workspace directory owning a meeting directory (used by the RPC
 * paths, which arrive without a session context).
 * @module dsh-plugin-roundtable/edge-helper
 */

import { join } from 'node:path'
import { readMeeting } from './state.ts'
import { workspaceCandidates } from './workspace-candidates.ts'

/**
 * Find the workspace path that contains the given meeting.
 *
 * @param stateDir - state directory name (`.roundtable`)
 * @param meetingId - meeting id
 * @param preferredWorkspace - **the workspace title the browser already knows**
 *   (the snapshot carries `workspace` on every meeting). 给定时只在那个工作区里
 *   找，找不到就返回 undefined —— **绝不静默回退到别的候选**。
 *
 * ## 为什么需要 `preferredWorkspace`
 *
 * 会议 id 由会议名派生（`sanitizeKey(name)`），所以「两个工作区有同名会议」是
 * 完全正常的。早先这个函数只做"按候选顺序遍历、返回第一个命中"：于是 RPC
 * 端点（改拓扑 / 改知识库 / 表态…）可能改的是**另一个工作区的同名会议**，而
 * 工具侧按 `session.cwd` 读的是当前工作区的那个 —— 用户看到"连线改了但拓扑
 * 没变，刷新一下又变回去了"，没有任何报错（M8）。
 *
 * 给了 `preferredWorkspace` 就只认它：指错了就该失败，而不是猜一个。
 */
export async function workspaceOfMeeting(
  stateDir: string,
  meetingId: string,
  preferredWorkspace?: string,
): Promise<string | undefined> {
  const candidates = preferredWorkspace === undefined || preferredWorkspace === ''
    ? workspaceCandidates()
    : workspaceCandidates().filter((candidate) => candidate.title === preferredWorkspace)
  for (const candidate of candidates) {
    const meeting = await readMeeting(join(candidate.path, stateDir), meetingId)
    if (meeting !== undefined) return candidate.path
  }
  return undefined
}
