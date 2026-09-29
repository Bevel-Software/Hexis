import type { AuthUser, ValidationReport } from '@bevel-software/platform-shared';

/**
 * Workflow lifecycle hooks — the generic seam that replaced the
 * constructor-injected KB validator. Core code invokes the hooks at fixed
 * lifecycle points; the modules that OWN the behavior register handlers in the
 * composition root, right after `createCoreServices` returns. Core registers
 * none, so a core-only deployment runs every hook point as a no-op.
 *
 * Three hook kinds, with deliberately different failure semantics:
 *
 *   - `commitValidation` — ADVISORY. Runs at commit time in `GitService`
 *     (`commit` / `commitFile`), exactly where the injected `IKbValidator`
 *     used to run. A returned report with `mustFix` entries is logged/surfaced
 *     but NEVER blocks the commit, and a hook that throws is caught and logged
 *     (see CLAUDE.md "Validation is advisory"). The signature mirrors the old
 *     `runValidation(workspaceId)` shape so `KbValidatorService` registers
 *     with a one-line adapter.
 *
 *   - `agentRead` — BLOCKING. Runs before a gated agent READ of a
 *     knowledge-base path (reads, `delete_file`, `delete_folder`, and each
 *     file a `grep` walk opens). A hook that throws REFUSES the read.
 *
 *   - `preWrite` — BLOCKING. Runs before a gated agent WRITE (the file-write
 *     tools, once per path) or a write-capable shell command, which carries no
 *     path. A hook that throws REFUSES the operation, and the caller sees the
 *     hook's own message and status.
 *
 * The two blocking hooks are the seam a deployment builds a per-conversation
 * rule on: they carry the session id the call named, and core itself neither
 * decides nor records anything (see `workspace/agent-access.gate.ts`).
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
 * What an agent operation looks like to the blocking hooks. The core gate has
 * already resolved the only two skips it owns (the caller is not an agent, or
 * is the recovery bot), so every hook call describes a real agent operation.
 *
 * `sessionId` is present only when the call carried one — core does NOT fail
 * closed on its absence, because whether a path needs a session is the
 * registering deployment's rule, not core's.
 */
export interface AgentOperationContext {
  /** The conversation the call belongs to, when it named one. */
  sessionId?: string;
  /**
   * The workspace-relative path the operation targets. Absent for a
   * write-capable operation with no resolvable target (`execute_command`).
   */
  wsPath?: string;
  /** The branch (draft) whose workspace the operation acts on. */
  branch: string;
  /** The calling user. */
  user: AuthUser;
  /** Whether the caller is the in-app agent (`internal`) or an external one. */
  source: 'internal' | 'external';
}

/** Blocking pre-read hook: throw to refuse the read; return to allow. */
export type AgentReadHook = (ctx: AgentOperationContext) => Promise<void>;

/** Blocking pre-write hook: throw to refuse the write; return to allow. */
export type PreWriteHook = (ctx: AgentOperationContext) => Promise<void>;

/**
 * The registry instance. ONE per composition (created in
 * `createCoreServices`, shared by `GitService` and exposed as
 * `WorkflowService.hooks` for the composition root to register against).
 */
export class WorkflowHooks {
  private readonly commitValidation: CommitValidationHook[] = [];
  private readonly agentRead: AgentReadHook[] = [];
  private readonly preWrite: PreWriteHook[] = [];

  /** Register an advisory commit-time validation hook. */
  onCommitValidation(hook: CommitValidationHook): void {
    this.commitValidation.push(hook);
  }

  /** Register a blocking pre-read hook. */
  onAgentRead(hook: AgentReadHook): void {
    this.agentRead.push(hook);
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
   * Run every blocking pre-read hook in registration order. The first throw
   * propagates and refuses the read; with no hooks registered (core-only)
   * this resolves immediately.
   */
  async runAgentRead(ctx: AgentOperationContext): Promise<void> {
    for (const hook of this.agentRead) {
      await hook(ctx);
    }
  }

  /**
   * Run every blocking pre-write hook in registration order. The first throw
   * propagates and refuses the write; with no hooks registered (core-only)
   * this resolves immediately.
   */
  async runPreWrite(ctx: AgentOperationContext): Promise<void> {
    for (const hook of this.preWrite) {
      await hook(ctx);
    }
  }
}
