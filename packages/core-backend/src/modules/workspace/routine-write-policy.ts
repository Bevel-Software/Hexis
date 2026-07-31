/**
 * Per-run write restriction for background/routine agents.
 *
 * The ontology-session gate ({@link ../workflow/session-ontology.service}) bounds
 * WHICH ontology a run may write; this narrower gate bounds WHAT KIND of file a
 * run may write, by extension. It exists for the `watchlist_check` routine, which is
 * allowed to refresh dashboard views (`.html`) but must never touch the
 * knowledge-graph nodes (`.md`) or any other file — a hard, code-level guarantee
 * rather than a prompt request (a prompt-only rule has already proven insufficient).
 *
 * Keyed by the agent run's `sessionId` (the background agent passes its run id as
 * the session id, which the internal token then carries onto every loopback tool
 * call as `ctx.sessionId`). A restriction lives only for the duration of one
 * in-process run, so the store is a plain in-memory map — no durability needed,
 * unlike the ontology touched-set which must survive restarts and span the MCP
 * proxy. The executor sets the restriction before streaming and clears it after.
 */

import { ToolError } from '../tool-helpers/tool.contract.js';

export interface IRoutineWritePolicy {
  /**
   * Confine a session's writes to the given file extensions (each including the
   * leading dot, e.g. `['.html', '.htm']`). Overwrites any prior restriction for
   * the session. A session with no restriction is unrestricted (the default for
   * chat + `ontology_ingest` runs).
   */
  restrictToExtensions(sessionId: string, extensions: readonly string[]): void;
  /** Drop a session's restriction (called at run end). */
  clear(sessionId: string): void;
  /**
   * Throw a 403 `ToolError` when the session is restricted and `wsPath`'s
   * extension is not on its allow-list. No session id, or no active restriction,
   * always passes — so this is a no-op for every non-restricted caller.
   */
  assertPathWritable(sessionId: string | undefined, wsPath: string): void;
  /**
   * Throw a 403 `ToolError` when the session is restricted at all — for write
   * tools with no single target path to check (arbitrary shell), which a
   * restricted run must not be able to use as a write bypass.
   */
  assertUnrestricted(sessionId: string | undefined): void;
}

export class RoutineWritePolicyService implements IRoutineWritePolicy {
  /** sessionId → allowed lowercased extensions. Absent = unrestricted. */
  private readonly restrictions = new Map<string, Set<string>>();

  restrictToExtensions(sessionId: string, extensions: readonly string[]): void {
    this.restrictions.set(sessionId, new Set(extensions.map((e) => e.toLowerCase())));
  }

  clear(sessionId: string): void {
    this.restrictions.delete(sessionId);
  }

  assertPathWritable(sessionId: string | undefined, wsPath: string): void {
    const allowed = sessionId ? this.restrictions.get(sessionId) : undefined;
    if (!allowed) return;
    const lower = wsPath.toLowerCase();
    for (const ext of allowed) {
      if (lower.endsWith(ext)) return;
    }
    throw new ToolError(
      `This run may only write ${[...allowed].join(', ')} files (dashboard views); "${wsPath}" is blocked. ` +
        'Knowledge-graph nodes and other files are read-only for this routine.',
      403,
    );
  }

  assertUnrestricted(sessionId: string | undefined): void {
    if (sessionId && this.restrictions.has(sessionId)) {
      throw new ToolError(
        'This run is restricted to writing dashboard views only, so shell commands (which could write any file) are disabled.',
        403,
      );
    }
  }
}
