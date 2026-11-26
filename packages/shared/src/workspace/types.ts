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
  /**
   * The part of the tree at `wsPath` (workspace-relative, as `readFile` takes
   * it): the folder's subtree, with the same entries, order and paths the
   * whole tree has for it, built by walking that folder alone. A caller that
   * needs one folder asks for it here instead of building every folder of
   * the branch. A file answers its own entry; `null` when nothing is there,
   * or when a `.bevelignore` above hides it as the whole tree would.
   */
  listFilesUnder(workspaceId: string, wsPath: string): Promise<FileTreeEntry | null>;
  readFile(workspaceId: string, relativePath: string): Promise<string>;
  writeFile(workspaceId: string, relativePath: string, content: string): Promise<void>;
  createDirectory(workspaceId: string, relativePath: string): Promise<void>;
  writeFileBinary(workspaceId: string, relativePath: string, data: Uint8Array): Promise<void>;
  deleteFile(workspaceId: string, relativePath: string): Promise<void>;
  moveEntry(workspaceId: string, oldRelativePath: string, newRelativePath: string): Promise<void>;
  getWorkspacePath(workspaceId: string): Promise<string>;
  /** Remove the workspace's transient `tmp/` dir (staged docs, tool-chain spills). */
  clearTmp(workspaceId: string): Promise<void>;
}
