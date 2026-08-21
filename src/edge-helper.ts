/**
 * Locate the workspace directory owning a meeting directory (used by the RPC
 * edge.set path, which arrives without a session context).
 * @module dsh-plugin-roundtable/edge-helper
 */

import { join } from 'node:path'
import { readMeeting } from './state.ts'
import { workspaceCandidates } from './workspace-candidates.ts'

/** Find the first workspace whose state root contains the given meeting. */
export async function workspaceOfMeeting(stateDir: string, meetingId: string): Promise<string | undefined> {
  for (const candidate of workspaceCandidates()) {
    const meeting = await readMeeting(join(candidate.path, stateDir), meetingId)
    if (meeting !== undefined) return candidate.path
  }
  return undefined
}
