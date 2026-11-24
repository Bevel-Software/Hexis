export interface WorkspaceInfo {
  /**
   * Workspace id = `encodeURIComponent(branch)`. Stable across users — a
   * branch's workspace is shared by everyone editing it (PLAN §3).
   * Decoding rule: callers can derive the branch via
   * `decodeURIComponent(id)` without a backend round-trip.
   */
  id: string;
  /** Display name. Currently the branch name verbatim. */
  name: string;
  /** Absolute path on the backend's filesystem (debug / log surface only). */
  absolutePath: string;
  /** ISO timestamp. Per-branch workspaces have no meaningful creation time; epoch is fine. */
  createdAt: string;
  /**
   * Directory name (relative to `absolutePath`) where the KB clone lives.
   * Configured via `KB_DIR_NAME` on the backend; surfaced to the frontend
   * so renderers and chat cards can build correct KB-relative paths
   * without hardcoding the repo name.
   */
  kbDirName: string;
}

export interface FileTreeEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  children?: FileTreeEntry[];
  /**
   * Set on a DIRECTORY of a read-filtered listing, and only when non-zero:
   * how many entries the caller's read rules kept out of that directory's
   * subtree — on the root, out of the whole listing. A number, never names —
   * it lets the explorer tell "nothing is shared with you" apart from "this
   * folder is empty" without saying what exists.
   */
  withheld?: number;
}

import type { AuthUser } from '../auth/types.js';

export interface IWorkspaceService {
  /**
   * Get-or-create the workspace for a branch. Workspaces are per-branch
   * (PLAN §3) — every user editing `branch` shares the same on-disk clone,
   * coordinated by the file-lock service.
   */
  getOrCreateForBranch(branch: string): Promise<WorkspaceInfo>;
  /**
   * Convenience wrapper that defaults to the configured default branch
   * (`DEFAULT_BRANCH`) when no branch is provided. Kept on the interface so route handlers that
   * receive a logged-in user but no explicit branch can still bootstrap a
   * workspace.
   */
  getOrCreateForUser(user: AuthUser, branch?: string): Promise<WorkspaceInfo>;
  getMetadata(workspaceId: string): Promise<WorkspaceInfo | null>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  listFiles(workspaceId: string): Promise<FileTreeEntry>;
  readFile(workspaceId: string, relativePath: string): Promise<string>;
  writeFile(workspaceId: string, relativePath: string, content: string): Promise<void>;
  createDirectory(workspaceId: string, relativePath: string): Promise<void>;
  writeFileBinary(workspaceId: string, relativePath: string, data: Uint8Array): Promise<void>;
  deleteFile(workspaceId: string, relativePath: string): Promise<void>;
  moveEntry(workspaceId: string, oldRelativePath: string, newRelativePath: string): Promise<void>;
  getWorkspacePath(workspaceId: string): Promise<string>;
  /**
   * Where `workspaceId`'s working copy can still be on disk, without
   * bootstrapping it: `'live'` when its working copy is in place, and
   * `'live-and-set-aside'` when a copy of it was also set aside (a replaced
   * or moved repository; that copy may hold what was never pushed);
   * `'set-aside'` when only the set-aside copy is left, `'gone'` only when
   * its folder is shown absent and nothing was set aside.
   * Throws when it cannot tell (an invalid id, a failed read, a folder with
   * no working copy), so a caller acting on `'gone'` never acts on a guess.
   */
  workingCopyOf(workspaceId: string): Promise<'live' | 'live-and-set-aside' | 'set-aside' | 'gone'>;
  /** Remove the workspace's transient `tmp/` dir (staged docs, tool-chain spills). */
  clearTmp(workspaceId: string): Promise<void>;
}
