export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * A single pending change — the diff between the on-disk backup ledger
 * (the user's last-confirmed state) and the current working tree for one path.
 */
export interface PendingChange {
  /** Current path (for added/modified/renamed) or original path (for deleted). */
  path: string;
  /** Populated only when kind === 'renamed' — the pre-rename path. */
  oldPath?: string;
  kind: ChangeKind;
  isBinary: boolean;
  /**
   * Line counts from an LCS diff. Null in two cases:
   * - the file is binary (no line concept), or
   * - the text diff exceeds the backend's LCS cap and exact counts were
   *   skipped to avoid OOM. Consumers should treat null as "not computed".
   */
  linesAdded: number | null;
  linesRemoved: number | null;
}

/**
 * Pending-changes envelope returned by the review API. Backed by the
 * on-disk backup ledger (a sibling-to-workspaces folder containing each
 * diffable file's last-confirmed contents). `baselineRef` is retained for
 * wire-shape compatibility but is empty under the backup-folder model;
 * the frontend reads `changes` and `branchName` only.
 */
export interface ReviewSession {
  branchName: string;
  /** Always empty in the backup-folder model — kept for wire compatibility. */
  baselineRef: string;
  createdAt: string;
  changes: PendingChange[];
}

/**
 * Full before/after content for one path in an active session. The UI renders
 * this through a line-level LCS diff.
 */
export interface FileDiffPayload {
  path: string;
  kind: ChangeKind;
  /** Content at the baseline. Null for `added` or binary files. */
  baseline: string | null;
  /** Current working-tree content. Null for `deleted` or binary files. */
  current: string | null;
  isBinary: boolean;
}
