import type { ValidationReport } from '@bevel-software/platform-shared';

/**
 * Workflow lifecycle hooks — the generic seam that replaced the
 * constructor-injected KB validator (and the core-owned ontology write block).
 * Core code invokes the hooks at fixed lifecycle points; the modules that OWN
 * the behavior (the enterprise kb/kb-graph modules today) register handlers in
 * the composition root, right after `createCoreServices` returns. Core
 * registers none, so a core-only deployment runs every hook point as a no-op.
 *
 * Two hook kinds with deliberately different failure semantics:
 *
 *   - `commitValidation` — ADVISORY. Runs at commit time in `GitService`
 *     (`commit` / `commitFile`), exactly where the injected `IKbValidator`
 *     used to run. A returned report with `mustFix` entries is logged/surfaced
 *     but NEVER blocks the commit, and a hook that throws is caught and logged
 *     (see AGENTS.md "Validation is advisory"). The signature mirrors the old
 *     `runValidation(workspaceId)` shape so `KbValidatorService` registers
 *     with a one-line adapter.
 *
 *   - `preWrite` — BLOCKING. Runs before a gated agent write (file-write
 *     tools) or a write-capable shell command; a hook that throws REJECTS the
 *     operation (the error propagates to the tool caller). This is where the
 *     enterprise ontology-session block registers; core registers nothing, so
 *     core never blocks (touch TRACKING stays core — see
 *     `session-ontology.gate.ts`).
 */

/** What `GitService` knows at the advisory commit-validation point. */
export interface CommitValidationContext {
  workspaceId: string;
  branch: string;
  /**
   * Repo-relative paths the commit will include — the full touched set for
   * `commit()`, a single element for the one-file `commitFile()` path.
   */
  paths: string[];
}

/**
 * Advisory commit-time validation. Return a report to have the caller log /
 * surface it (or `void` for "nothing to say"). Throwing is tolerated — the
 * caller catches and logs, never blocks the commit.
 */
export type CommitValidationHook = (
  ctx: CommitValidationContext,
) => Promise<ValidationReport | void>;

/**
 * What the pre-write gate knows when it consults the blocking hooks. The core
 * gate has already resolved all skip conditions (boundary flag off, neutral
 * path, non-agent caller, recovery bot, missing session id — see
 * `resolveGatedSession`), so by hook time there is always a session id.
 */
export type PreWriteContext =
  /** A path-addressed content write (write_file/edit_file/mkdir/move/copy/unzip…). */
  | { kind: 'file-write'; sessionId: string; wsPath: string }
  /** A write-capable operation with no resolvable target path (execute_command). */
  | { kind: 'shell'; sessionId: string };

/** Blocking pre-write hook: throw to reject the write; return to allow. */
export type PreWriteHook = (ctx: PreWriteContext) => Promise<void>;

/**
 * The registry instance. ONE per composition (created in
 * `createCoreServices`, shared by `GitService` and exposed as
 * `WorkflowService.hooks` for the composition root to register against).
 */
export class WorkflowHooks {
  private readonly commitValidation: CommitValidationHook[] = [];
  private readonly preWrite: PreWriteHook[] = [];

  /** Register an advisory commit-time validation hook. */
  onCommitValidation(hook: CommitValidationHook): void {
    this.commitValidation.push(hook);
  }

  /** Register a blocking pre-write hook. */
  onPreWrite(hook: PreWriteHook): void {
    this.preWrite.push(hook);
  }

  /**
   * The registered commit-validation hooks, for the caller (`GitService`) to
   * iterate with its own advisory catch-and-log semantics.
   */
  commitValidationHooks(): readonly CommitValidationHook[] {
    return this.commitValidation;
  }

  /**
   * Run every blocking pre-write hook in registration order. The first throw
   * propagates and rejects the write; with no hooks registered (core-only)
   * this resolves immediately.
   */
  async runPreWrite(ctx: PreWriteContext): Promise<void> {
    for (const hook of this.preWrite) {
      await hook(ctx);
    }
  }
}
