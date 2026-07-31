/**
 * One in-process notification fired AFTER a set of file changes is committed +
 * pushed (post-lock-release), so backend services can react to KB writes without
 * the per-file TTL wait. Distinct from the SSE `WorkflowEventBus`, which fans
 * scoped events to browser sessions; this is an unscoped, server-side domain hook.
 *
 * BATCHED by design: a single-file save emits `paths: [p]`, a batch write
 * (`LockingFilesystem.writeFiles`, e.g. a bulk node upload) emits ONE event with
 * every path it committed. Subscribers that do expensive per-event work (the
 * id-repair rebuilds the id index) handle a whole batch off one rebuild instead
 * of N back-to-back ones.
 *
 * Emitted from the two post-commit chokepoints (`WorkflowService.runPendingCommit`
 * for single-file writes, `LockingFilesystem.writeFiles` for batches).
 *
 * Every listener is invoked inside try/catch — a throwing subscriber must never
 * fail the commit that triggered it (mirrors the SSE bus's per-subscriber
 * isolation). Firing is fire-and-forget; a listener that needs to write files
 * (id-repair) does so on its own, after the locks have already been released.
 */
import type { AuthUser } from '@bevel-software/shared';

export interface FilesChange {
  workspaceId: string;
  branch: string;
  /** Workspace-relative paths committed in this change (≥1; sorted for batches). */
  paths: string[];
  /** Who the change was committed as — a reacting write (id-repair) acts as the same user. */
  byUser: AuthUser;
}

export type FilesChangedListener = (change: FilesChange) => void;

export class FileChangeNotifier {
  private readonly listeners = new Set<FilesChangedListener>();

  /** Register a listener. Returns an unsubscribe fn. */
  onFilesChanged(listener: FilesChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fan a change out to every listener; isolate + log each so one can't break the commit. */
  emit(change: FilesChange): void {
    if (change.paths.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error('[file-change] listener threw:', err instanceof Error ? err.message : err);
      }
    }
  }
}
