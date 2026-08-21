/**
 * Process-local registry of workspace candidate paths, bound by index.ts when
 * the workspace registry becomes available. Kept in its own module so both
 * the RPC helper and the snapshot route read one source without importing the
 * web-server types.
 * @module dsh-plugin-roundtable/workspace-candidates
 */

let candidates: { title: string; path: string }[] = []

/** Bind the candidate list (call once from index.ts). */
export function setWorkspaceCandidates(next: { title: string; path: string }[]): void {
  candidates = next
}

/** Current workspace candidates. */
export function workspaceCandidates(): readonly { title: string; path: string }[] {
  return candidates
}
