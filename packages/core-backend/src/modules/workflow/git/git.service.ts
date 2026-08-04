import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AuthUser,
  BranchInfo,
  CommitAttribution,
  IGitService,
  PrFileStatus,
  PullRequestFile,
  ShareChangesRequest,
  WorkingTreeStatus,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowHooks, CommitValidationContext } from '../workflow-hooks.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { AccessDeniedError } from '../../access/access-errors.js';
import { WorkspaceMutex } from './mutex.js';
import { cloneTrackingConfigArgs, SAFE_IMPLICIT_FETCH_ARGS } from './clone-config.js';
import {
  assertValidBranchName,
  assertValidRelativePath,
  isBranchAuthoredBy,
  isProtectedBranch,
  PROTECTED_BRANCHES,
} from './branch-name.js';
import {
  BranchAuthorshipError,
  WorkflowValidationError,
  ProtectedBranchError,
  PullRebaseConflictError,
} from '../workflow.errors.js';

const execFileAsync = promisify(execFile);

interface GitRunResult {
  stdout: string;
  stderr: string;
}

function redact(msg: string): string {
  const token = process.env.GITHUB_TOKEN;
  return token ? msg.replaceAll(token, '***') : msg;
}

/**
 * Fallback committer identity. Every workflow commit overrides the author via
 * `--author=…` so the real human shows up in `git log`; this is just the
 * committer git records need. Mirrors the value `WorkspaceService` stamps on
 * each clone — set again where an operation must not depend on that ambient
 * config (e.g. the merge below).
 */
const BOT_NAME = 'Bevel Workflow';
const BOT_EMAIL = 'bevel-workflow@bevel.software';

/**
 * Git parses `--author="Name <email>"` by scanning for the last `<` and `>` and
 * taking everything before the `<` as the name. Stray angle brackets, newlines, or
 * carriage returns in either field break that parser or let a caller forge a
 * different author line. Reject rather than try to escape.
 */
/**
 * Parse the NUL-delimited output of `git status --porcelain=v1 -z` into a
 * deduplicated list of paths the next commit would include. For a rename /
 * copy entry the record spans two NUL-separated fields (new-path, old-path);
 * we keep the new path and discard the old one.
 */
export function parsePorcelainZ(stdout: string): string[] {
  const tokens = stdout.split('\0').filter((t) => t.length > 0);
  const paths = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    // Every entry is "XY <path>" — 2 status chars, a space, then the path.
    if (token.length < 4) { i++; continue; }
    const x = token[0];
    const y = token[1];
    paths.add(token.slice(3));
    // Rename or copy in either the index or worktree position carries an
    // extra NUL-separated old-path field we must skip.
    i += (x === 'R' || x === 'C' || y === 'R' || y === 'C') ? 2 : 1;
  }
  return Array.from(paths);
}

/**
 * Default commit subject used when a caller (typically `LockingFilesystem`'s
 * auto-commit on lock release) doesn't supply one. Must stay within the 200-
 * char subject limit enforced just below — deep KB paths can themselves exceed
 * 200 chars, so a naive `Update <path>` would trip the validator and the
 * release would propagate the error back to the agent's tool call. Fall back
 * to the basename, then hard-truncate as a last resort.
 */
function buildDefaultCommitSummary(repoRelativePath: string): string {
  const full = `Update ${repoRelativePath}`;
  if (full.length <= 200) return full;
  const basename = repoRelativePath.split('/').pop() ?? repoRelativePath;
  const basenameSummary = `Update ${basename}`;
  if (basenameSummary.length <= 200) return basenameSummary;
  return basenameSummary.slice(0, 199) + '…';
}

function assertValidAuthor(user: AuthUser): void {
  if (!user.name || !user.email) {
    throw new WorkflowValidationError('commit author name and email are required');
  }
  if (/[\r\n<>]/.test(user.name)) {
    throw new WorkflowValidationError('commit author name contains invalid characters');
  }
  if (/[\r\n<>\s]/.test(user.email) || !/^[^@\s]+@[^@\s]+$/.test(user.email)) {
    throw new WorkflowValidationError('commit author email is not a valid address');
  }
}

/**
 * Cheap binary heuristic. Git's own `diff` treats a file as binary if it sees a
 * NUL byte in the first ~8KB, and the same rule works here: text files don't
 * contain NULs, binary formats almost always do early in the file.
 */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.indexOf(0) !== -1;
}

/**
 * Matches `git diff`'s output for adding a new binary file — the UI just
 * echoes the patch text, so this header renders as a neutral "can't preview"
 * notice without needing special-case rendering in DiffView.
 */
function synthesizeBinaryAddDiff(relativePath: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    `Binary files /dev/null and b/${relativePath} differ`,
    '',
  ].join('\n');
}

/**
 * Produce a unified diff resembling `git diff --no-index /dev/null <path>` output
 * so the UI can render an untracked file as "all added" using the same DiffView
 * it uses for committed changes. No mode detection — new files get 100644.
 */
function synthesizeNewFileDiff(relativePath: string, contents: string): string {
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
  ].join('\n');

  if (contents === '') return `${header}\n`;

  const endsWithNewline = contents.endsWith('\n');
  // Drop the trailing empty string `split` introduces when the file ends with a newline
  // so the line count matches what git itself would report in the hunk header.
  const body = endsWithNewline ? contents.slice(0, -1) : contents;
  const lines = body.split('\n');
  const hunk = `@@ -0,0 +1,${lines.length} @@`;
  const bodyText = lines.map((l) => `+${l}`).join('\n');
  const trailer = endsWithNewline ? '' : '\n\\ No newline at end of file';
  return `${header}\n${hunk}\n${bodyText}${trailer}\n`;
}

/** Mirror of {@link synthesizeBinaryAddDiff} for the removed direction. */
function synthesizeBinaryRemoveDiff(relativePath: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'deleted file mode 100644',
    `Binary files a/${relativePath} and /dev/null differ`,
    '',
  ].join('\n');
}

/** Mirror of {@link synthesizeNewFileDiff} for when the working-tree file sits on the "from" side. */
function synthesizeDeletedFileDiff(relativePath: string, contents: string): string {
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'deleted file mode 100644',
    `--- a/${relativePath}`,
    '+++ /dev/null',
  ].join('\n');

  if (contents === '') return `${header}\n`;

  const endsWithNewline = contents.endsWith('\n');
  const body = endsWithNewline ? contents.slice(0, -1) : contents;
  const lines = body.split('\n');
  const hunk = `@@ -1,${lines.length} +0,0 @@`;
  const bodyText = lines.map((l) => `-${l}`).join('\n');
  const trailer = endsWithNewline ? '' : '\n\\ No newline at end of file';
  return `${header}\n${hunk}\n${bodyText}${trailer}\n`;
}

/**
 * Synthesize a diff for an untracked working-tree file when the current branch
 * is one side of a branch-vs-branch comparison. `direction` says which side the
 * working tree sits on: 'added' = working tree is the "to" side (all `+`),
 * 'removed' = working tree is the "from" side (all `-`).
 */
async function synthesizeUntrackedSideDiff(
  cwd: string,
  relativePath: string,
  direction: 'added' | 'removed',
): Promise<string> {
  try {
    const buf = await fs.readFile(path.join(cwd, relativePath));
    if (looksBinary(buf)) {
      return direction === 'added'
        ? synthesizeBinaryAddDiff(relativePath)
        : synthesizeBinaryRemoveDiff(relativePath);
    }
    const text = buf.toString('utf8');
    return direction === 'added'
      ? synthesizeNewFileDiff(relativePath, text)
      : synthesizeDeletedFileDiff(relativePath, text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export class GitService implements IGitService {
  // Per-workspace fetch state, kept OUTSIDE the workspace mutex on purpose.
  // `git fetch` only writes `refs/remotes/origin/*` and packs new objects —
  // it doesn't touch HEAD, the index, or the working tree, so it's safe to
  // run alongside checkout/status/commit. Holding the mutex during a network
  // round-trip used to park every other git op behind a slow origin (the
  // worst case for branch-switching UX).
  private readonly fetchLocks = new Map<string, Promise<void>>();
  private readonly lastImplicitFetchAt = new Map<string, number>();
  private static readonly IMPLICIT_FETCH_TTL_MS = 5_000;
  // Cap on concurrent `aheadBehindForBranch` calls inside `listBranches`. Each
  // call serializes up to 3 `git rev-list` spawns, so 8 workers ≈ ≤24
  // concurrent processes worst case — fast for typical (<8) feature-branch
  // counts, calm under large branch lists.
  private static readonly MAX_AHEAD_BEHIND_CONCURRENCY = 8;

  constructor(
    private readonly workspaceService: WorkspaceService,
    /**
     * Workflow lifecycle hooks. This service only consults the ADVISORY
     * `commitValidation` hooks (registered by the enterprise kb module in the
     * composition root — the constructor-injected `IKbValidator` this
     * replaced). No hooks registered = no commit-time validation, which is
     * safe because validation is advisory and never blocks a commit.
     */
    private readonly hooks: WorkflowHooks,
    private readonly kbDirName: string,
    private readonly mutex: WorkspaceMutex = new WorkspaceMutex(),
    private readonly accessControl: IAccessControl | null = null,
  ) {}

  /**
   * "Does the pending-commits queue hold rows for this workspace?" — used by
   * `statusInternal` to tell an expected dirty tree (queued saves still
   * draining) from a genuinely orphaned one. Injected as a narrow probe via
   * setter (not constructor) because the queue service is constructed after
   * this one in the composition root; `null` (e.g. in tests) keeps the old
   * always-warn behavior.
   */
  private pendingCommitsProbe: ((workspaceId: string) => Promise<boolean>) | null = null;

  setPendingCommitsProbe(probe: (workspaceId: string) => Promise<boolean>): void {
    this.pendingCommitsProbe = probe;
  }

  /**
   * Mark a workspace as freshly fetched. Called by `WorkspaceService` right
   * after a branch's clone is created — `git clone` already downloaded every
   * ref, so the first `listBranches` can skip the redundant implicit
   * `git fetch` (see `fetchOriginIfStale`).
   */
  noteWorkspaceFetched(workspaceId: string): void {
    this.lastImplicitFetchAt.set(workspaceId, Date.now());
  }

  /**
   * Run the registered ADVISORY commit-validation hooks at a commit site.
   * Preserves the semantics of the injected validator this replaced: a
   * `mustFix` report is logged (via `formatWarning`) but never blocks, and a
   * hook that throws is caught and logged — we'd rather land the commit than
   * refuse the save because a validator crashed. Each hook gets its own
   * try/catch so one crashing hook can't silence another.
   */
  private async runCommitValidationHooks(
    ctx: CommitValidationContext,
    formatWarning: (report: { mustFix: unknown[] }) => string,
  ): Promise<void> {
    for (const hook of this.hooks.commitValidationHooks()) {
      try {
        const report = await hook(ctx);
        if (report && report.mustFix.length > 0) {
          console.warn(formatWarning(report));
        }
      } catch (validatorErr) {
        // Validator failure is non-fatal — advisory only.
        console.warn('[git] validator crashed (advisory only, ignoring):', validatorErr instanceof Error ? validatorErr.message : validatorErr);
      }
    }
  }

  /**
   * Resolve write permission for a list of repo-relative paths against the
   * access tree at a specific ref. Throws `AccessDeniedError` for the first
   * path the caller lacks `write` on, with the eligible-roles + users
   * payload attached so the frontend can render a useful refusal message.
   *
   * Always uses an at-ref lookup (never the working tree) so a user can't
   * grant themselves access by editing `roles.yaml` / `access.md` locally.
   * Callers pass:
   *   - `HEAD` for commit / revert gates — the pre-operation state is the
   *     authoritative source for whether the user can write these paths.
   *   - `origin/<branch>` for push gates — the published state is the
   *     authoritative source; local rebases or commit-tree manipulation
   *     can't slip changes past this check.
   *
   * Bootstrap: if the ref doesn't carry usable config (no `roles.yaml` /
   * malformed / first commit creating the system), `canWriteBatchAtRef`
   * returns null and we treat that as "no rules in force yet" → allow.
   * Once config exists at the ref, gating kicks in.
   *
   * `accessControl` is optional on the constructor so existing tests that
   * don't exercise these paths can keep their stub WorkspaceService — when
   * it's null we skip the check entirely (legacy behaviour, only the
   * branch-name guards remain). Production wires it up via composition root.
   */
  private async assertCanWriteAtRef(
    workspaceId: string,
    ref: string,
    userEmail: string,
    paths: string[],
  ): Promise<void> {
    if (!this.accessControl || paths.length === 0) return;
    const result = await this.accessControl.canWriteBatchAtRef(
      workspaceId,
      ref,
      userEmail,
      paths,
    );
    if (!result) return; // bootstrap: no config at ref → default-allow
    for (const p of paths) {
      if (!result.get(p)) {
        const eligible = await this.accessControl.eligibleWritersAtRef(workspaceId, ref, p);
        throw new AccessDeniedError({
          path: p,
          eligibleRoles: eligible?.roles ?? [],
          eligibleUsers: eligible?.users ?? [],
        });
      }
    }
  }

  async status(workspaceId: string): Promise<WorkingTreeStatus> {
    return this.mutex.run(workspaceId, () => this.statusInternal(workspaceId));
  }

  async listBranches(
    workspaceId: string,
    opts: { freshFetch?: boolean } = {},
  ): Promise<BranchInfo[]> {
    const cwd = await this.repoDir(workspaceId);
    // Run the fetch BEFORE entering the mutex so a slow origin can't block
    // local-only git ops (checkout/status) on this workspace. The fetch has
    // its own per-workspace lock + TTL, so concurrent listBranches callers
    // share a single in-flight fetch instead of stacking up. `freshFetch`
    // bypasses the TTL — used for user-initiated refreshes (opening the branch
    // selector) so a draft another workspace just deleted is pruned right away
    // instead of lingering up to one TTL window.
    await this.fetchOriginIfStale(cwd, workspaceId, opts.freshFetch);
    return this.mutex.run(workspaceId, async () => {
      // Union local heads with origin's remote-tracking refs: a fresh per-user
      // clone only has one local head (HEAD's default), so without this we'd hide
      // target-company-state and every draft pushed by another user.
      const { stdout } = await this.git(cwd, [
        'for-each-ref',
        '--format=%(refname:short)%09%(refname)',
        'refs/heads',
        'refs/remotes/origin',
      ]);

      type Row = { shortName: string; ref: string; hasLocal: boolean; hasRemote: boolean };
      const buckets = new Map<string, Row>();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tab = trimmed.indexOf('\t');
        if (tab < 0) continue;
        const rawShort = trimmed.slice(0, tab);
        const ref = trimmed.slice(tab + 1);
        if (!rawShort || !ref) continue;
        // Skip symbolic refs up-front. Different git versions report
        // `refs/remotes/origin/HEAD` as either `origin` (older) or `origin/HEAD`
        // (modern) for `refname:short`, and a literal `HEAD` ref can also
        // appear under `refs/heads/` in pathological repos.
        if (rawShort === 'HEAD' || rawShort === 'origin' || rawShort === 'origin/HEAD') continue;

        const isLocal = ref.startsWith('refs/heads/');
        const shortName = isLocal ? rawShort : rawShort.replace(/^origin\//, '');
        if (!shortName) continue;
        // Final guard: the strip above turns `origin/HEAD` into `HEAD`. Even
        // if a future git version lands us here, don't bucket it as a branch.
        if (shortName === 'HEAD') continue;

        const existing = buckets.get(shortName);
        if (!existing) {
          buckets.set(shortName, {
            shortName,
            ref,
            hasLocal: isLocal,
            hasRemote: !isLocal,
          });
          continue;
        }
        // Prefer the local entry's ref when both exist — ahead/behind against the
        // configured upstream is more meaningful than against origin directly.
        if (isLocal && !existing.hasLocal) {
          existing.ref = ref;
          existing.hasLocal = true;
        } else if (!isLocal) {
          existing.hasRemote = true;
        }
      }

      const rows = Array.from(buckets.values()).sort((a, b) => {
        if (a.hasLocal !== b.hasLocal) return a.hasLocal ? -1 : 1;
        return a.shortName.localeCompare(b.shortName);
      });

      // Compute ahead/behind for every branch with bounded concurrency — each
      // branch is 1–3 `git rev-list` spawns, and the unbounded `Promise.all`
      // we used before could put N×3 processes in flight on repos with many
      // branches. Workers pull indices off a shared counter and write into a
      // pre-sized array, so input order (and the sort above) is preserved.
      const infos: BranchInfo[] = new Array(rows.length);
      let nextIndex = 0;
      const workerCount = Math.min(GitService.MAX_AHEAD_BEHIND_CONCURRENCY, rows.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            const i = nextIndex++;
            if (i >= rows.length) return;
            const row = rows[i];
            const { ahead, behind } = await this.aheadBehindForBranch(
              cwd,
              row.shortName,
              row.ref,
              row.hasLocal,
            );
            infos[i] = {
              name: row.shortName,
              isProtected: isProtectedBranch(row.shortName),
              ahead,
              behind,
              hasRemote: row.hasRemote,
            };
          }
        }),
      );
      return infos;
    });
  }

  /**
   * Run `git fetch --prune origin` outside the workspace mutex, with a short
   * TTL so back-to-back callers (mount + dropdown-open + 30s poll) coalesce
   * onto a single in-flight fetch instead of each waiting their turn behind
   * the network round-trip. Failures (offline, bad auth, no remote) are
   * logged and swallowed so the branch list still serves stale local data
   * instead of returning 500.
   *
   * Safe to keep outside the mutex: fetch only writes remote-tracking refs
   * and the object store, neither of which checkout/status/commit touch.
   */
  private async fetchOriginIfStale(
    cwd: string,
    workspaceId: string,
    force = false,
  ): Promise<void> {
    const last = this.lastImplicitFetchAt.get(workspaceId) ?? 0;
    if (!force && Date.now() - last < GitService.IMPLICIT_FETCH_TTL_MS) return;

    const inFlight = this.fetchLocks.get(workspaceId);
    if (inFlight) {
      // Another caller is already fetching for this workspace — share its
      // result rather than firing a redundant network round-trip. Awaiting
      // the same promise also means subsequent listBranches calls see the
      // newly fetched refs.
      await inFlight;
      return;
    }

    const runFetch = async (): Promise<void> => {
      try {
        // http.lowSpeedLimit/Time abort the fetch if the transfer stalls below
        // 1KB/s for 10 seconds — prevents a hung origin from parking us
        // forever and starving the TTL refresh.
        await this.git(cwd, [
          '-c', 'http.lowSpeedLimit=1000',
          '-c', 'http.lowSpeedTime=10',
          // This driver runs OUTSIDE the workspace mutex (see the caller), so
          // it may only run the safe implicit-fetch shape — see
          // `SAFE_IMPLICIT_FETCH_ARGS` in `clone-config.ts` for the rationale.
          ...SAFE_IMPLICIT_FETCH_ARGS,
        ]);
        this.lastImplicitFetchAt.set(workspaceId, Date.now());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[git] implicit fetch failed for workspace ${workspaceId}: ${msg}`);
        // Stamp the TTL on failure too so a hard-down origin doesn't make
        // every subsequent listBranches retry the (still-failing) fetch and
        // pile up 10s timeouts. Stale local refs are better than spinning.
        this.lastImplicitFetchAt.set(workspaceId, Date.now());
      }
    };
    const p = runFetch();
    this.fetchLocks.set(workspaceId, p);
    try {
      await p;
    } finally {
      // Drop the lock once the fetch settles so the next caller past the TTL
      // can spawn a fresh one. Compare-and-delete in case a future race
      // somehow swapped a different promise in.
      if (this.fetchLocks.get(workspaceId) === p) {
        this.fetchLocks.delete(workspaceId);
      }
    }
  }

  async createBranch(
    workspaceId: string,
    name: string,
    fromBase?: string,
  ): Promise<BranchInfo> {
    assertValidBranchName(name);
    if (isProtectedBranch(name)) {
      throw new ProtectedBranchError(name, 'creating a protected branch');
    }
    if (fromBase) assertValidBranchName(fromBase);

    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // With no fromBase, git branches from HEAD — i.e. whichever branch the
      // user has currently checked out.
      const args = fromBase ? ['branch', name, fromBase] : ['branch', name];
      await this.git(cwd, args);
      // Publish to origin immediately. The per-branch workspace bootstrap
      // (`WorkspaceService.getOrCreateForBranch`) shells out to
      // `git clone -b <name>` against origin — without this push the next
      // navigation to the new draft's URL fails with
      // "Remote branch <name> not found in upstream origin". Roll the local
      // ref back on failure so a retry isn't blocked by "branch already exists".
      try {
        await this.git(cwd, ['push', '-u', 'origin', name]);
      } catch (err) {
        await this.git(cwd, ['branch', '-D', name]).catch(() => undefined);
        throw err;
      }
      const { ahead, behind } = await this.aheadBehindForBranch(
        cwd,
        name,
        `refs/heads/${name}`,
        true,
      );
      // Drop the now-vestigial local head. Under the per-branch workspace model
      // this clone's identity is its OWN branch; the new draft lives in its own
      // workspace (cloned from origin on first navigation), so this clone never
      // checks `name` out again. Leaving a local `refs/heads/<name>` here means
      // that when the draft is later deleted from a DIFFERENT workspace (which
      // removes it from origin and from that clone), this clone's local head
      // survives `fetch --prune` — `prune` only drops remote-tracking refs — and
      // the draft resurfaces in the picker as a phantom orphan that "won't
      // delete". Removing it now keeps the draft as a pure remote-tracking ref,
      // which prune cleans up like any other. The push already published it to
      // origin, so the BranchInfo below still reports `hasRemote: true`.
      await this.git(cwd, ['branch', '-D', name]).catch(() => undefined);
      // `isCurrent` removed from BranchInfo with the per-branch workspace
      // migration — the workspace's identity IS the current branch, so
      // consumers derive it from the workspaceId. No need to call
      // `currentBranch(cwd)` here anymore either.
      return {
        name,
        isProtected: false,
        ahead,
        behind,
        hasRemote: true,
      };
    });
  }

  // `switchBranch` removed. Under the per-branch workspace model
  // (`workspaces/<encodeURIComponent(branch)>/`) the active branch IS the
  // workspace's identity — there is no "check out a different branch on this
  // workspace's clone" operation. Switching branches in the UI navigates to
  // a different workspace; the destination workspace's clone is already on
  // its branch by construction (`WorkspaceService.getOrCreateForBranch`).
  //
  // Two consequences:
  //   - The legacy `DirtyWorkingTreeError` gate this method used to throw
  //     can no longer surface as a user-facing 409.
  //   - The diff-backup reseed that used to fire here is unnecessary: a
  //     fresh per-branch workspace gets its backup seeded by the workspace
  //     bootstrap path, not by a branch switch on an existing one.

  async deleteBranch(
    workspaceId: string,
    name: string,
    user: AuthUser,
    opts: { onlyIfNoRemote?: boolean } = {},
  ): Promise<void> {
    assertValidBranchName(name);
    if (isProtectedBranch(name)) {
      throw new ProtectedBranchError(name, 'deleting a protected branch');
    }
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const current = await this.currentBranch(cwd);
      if (current === name) {
        throw new WorkflowValidationError(
          `Cannot delete "${name}" while it's the checked-out branch.`,
        );
      }

      if (opts.onlyIfNoRemote) {
        // Legacy orphan-cleanup path (PR merged + remote head pruned). Skip
        // the authorship check — callers prune any orphan they encounter,
        // not just their own — but keep the "refuse if origin still has the
        // ref" safety: a present remote means the branch is still live.
        if (await this.refExists(cwd, `refs/remotes/origin/${name}`)) {
          throw new WorkflowValidationError(
            `Branch "${name}" still exists on origin — refusing to auto-prune.`,
          );
        }
      } else {
        // Authored-or-admin delete path. The branch's author (per the
        // `<email-localpart>/...` naming convention — see `isBranchAuthoredBy`)
        // can always delete their own draft. Admins (per the workspace's
        // `roles.yaml`) can additionally clean up anyone's branch, including
        // unprefixed CLI branches like `fix/...` that have no recognisable
        // author. We detect admin via `canWrite(_, _, 'roles.yaml')` because
        // that predicate is the existing source of truth for `Admin`-role
        // membership inside the access model — no separate `isAdmin()` plumbing
        // needed.
        const isAuthor = isBranchAuthoredBy(name, user.email);
        const isAdmin = this.accessControl
          ? await this.accessControl.canWrite(workspaceId, user.email, 'roles.yaml')
          : false;
        if (!isAuthor && !isAdmin) {
          throw new BranchAuthorshipError(name);
        }
      }

      // Local delete. `-D` force-deletes even if the branch isn't "fully
      // merged" from git's POV — squash-merged PRs leave a local branch whose
      // commits don't appear on origin/<base> verbatim, but the changes are
      // in fact merged. Force is the right default for our workflow.
      //
      // Skip when no local ref exists — the picker can surface branches that
      // exist only as `refs/remotes/origin/<name>` (the user hasn't worked on
      // them locally), and "discard from origin" must still work for those.
      if (await this.refExists(cwd, `refs/heads/${name}`)) {
        await this.git(cwd, ['branch', '-D', name]);
      }

      // Remote delete. Skip in `onlyIfNoRemote` mode (the contract is
      // local-only cleanup) and skip when there's no remote ref to delete.
      // A push failure here surfaces to the caller — the local ref is
      // already gone, and we don't try to resurrect it because rolling back
      // a "merged-into-the-deleted-branch" local commit would be even more
      // confusing than the half-finished state.
      if (!opts.onlyIfNoRemote
        && await this.refExists(cwd, `refs/remotes/origin/${name}`)) {
        await this.git(cwd, ['push', 'origin', '--delete', name]);
      }
    });
  }

  /**
   * True iff the given ref (e.g. `refs/heads/foo`, `refs/remotes/origin/foo`)
   * exists in this workspace's clone. Wraps `git show-ref --verify --quiet`
   * — exits 0 when the ref is present, 1 with no stderr when it's missing.
   * Any other exit code / stderr means a real failure and is rethrown so
   * "ref not found" can't silently mask filesystem / repo corruption.
   *
   * `this.git()` wraps execFile failures and stores the original exit code on
   * `wrapped.exitCode` (not `.code`) — check the wrapped property name, or
   * the "ref not found" path silently becomes "rethrow every show-ref error".
   */
  private async refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.git(cwd, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch (err) {
      const exitCode = (err as { exitCode?: number })?.exitCode;
      const stderr = (err as { stderr?: string })?.stderr ?? '';
      const refNotFound = exitCode === 1 && stderr.trim() === '';
      if (refNotFound) return false;
      throw err;
    }
  }

  // `forkCurrentToDraft` removed: under the per-branch workspace model, every
  // branch IS its own workspace by construction. The "stuck on protected
  // branch with dirty edits" escape hatch this method implemented can no
  // longer occur — save=share auto-commits each write, and the user can
  // never end up with uncommitted work that needs to be carried onto a new
  // draft. Creating a draft is just `createBranch` + URL navigation to the
  // new branch's workspace.

  // `discardChanges` removed: under save=share, the working tree is never
  // dirty by design — every write goes through `LockingFilesystem`, which
  // auto-commits on lock release. There's nothing to discard. The method
  // was only meaningful when users could accumulate uncommitted edits
  // between explicit save actions.

  async commit(
    workspaceId: string,
    user: AuthUser,
    req: ShareChangesRequest,
  ): Promise<CommitAttribution> {
    const subject = req.summary?.trim();
    if (!subject) throw new WorkflowValidationError('commit summary is required');
    if (subject.length > 200) {
      throw new WorkflowValidationError('commit summary must be ≤ 200 characters');
    }
    if (subject.includes('\n')) {
      throw new WorkflowValidationError('commit summary must be a single line');
    }
    assertValidAuthor(user);

    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);

      // One-change-per-file invariant from PLAN.md: each commit must touch
      // exactly one path. Empty folders are represented via `.gitkeep`, so
      // "creating a folder" is also one file. We compute the touched set
      // unconditionally (the protected-branch gate below reuses it) and
      // refuse anything other than exactly one path before any access
      // check runs — keeps the error message stable across permission
      // outcomes.
      const { stdout: porcelain } = await this.git(cwd, [
        'status', '--porcelain=v1', '-z',
      ]);
      const touched = parsePorcelainZ(porcelain);
      if (touched.length === 0) {
        throw new WorkflowValidationError('No pending changes to commit', {
          kind: 'no-pending-changes',
        });
      }
      if (touched.length > 1) {
        throw new WorkflowValidationError(
          `Each change must affect exactly one file. ${touched.length} files are currently pending: ${touched.join(', ')}. Commit them one at a time.`,
          { kind: 'too-many-files-dirty', paths: touched },
        );
      }

      // Gate by access-control rules — but ONLY on protected branches.
      // Feature/draft branches are free-for-all: anyone can commit anything
      // because nothing canonical changes until a CR merges, and the CR's
      // approval gate (`origin/<base>` access tree) is the real security
      // boundary. Without this guard, the standard "fork to draft then
      // propose" workflow would 403 for non-admins — they can't write
      // protected, can't write the draft they forked from it either.
      if (isProtectedBranch(branch)) {
        // Gate against the access tree as it exists at HEAD — the pre-commit
        // state. Reading from the working tree would let the user broaden
        // their own access by editing access.md alongside the change they're
        // trying to push through.
        await this.assertCanWriteAtRef(workspaceId, 'HEAD', user.email, touched);
      }

      // Validation is **advisory**, not a gate. We still run the registered
      // commit-validation hooks (the report surfaces in logs + can drive UI
      // warnings later), but a `mustFix` result no longer blocks the commit —
      // the user's right to save their work shouldn't depend on the rest of
      // the KB being clean.
      await this.runCommitValidationHooks(
        { workspaceId, branch, paths: touched },
        (report) =>
          `[git] commit on workspace=${workspaceId} branch=${branch} landing with ${report.mustFix.length} unresolved KB validator issue(s); the editor surfaces them but commit is no longer blocked.`,
      );

      await this.git(cwd, ['add', '-A']);

      const args = [
        'commit',
        `--author=${user.name} <${user.email}>`,
        '-m',
        subject,
      ];
      if (req.description && req.description.trim()) {
        args.push('-m', req.description.trim());
      }
      await this.git(cwd, args);

      const { stdout } = await this.git(cwd, [
        'log',
        '-1',
        '--pretty=format:%H%x00%an%x00%ae%x00%s%x00%aI',
      ]);
      const [sha, authorName, authorEmail, subj, committedAt] = stdout.split('\x00');

      // The commit may have changed roles.yaml or access.md — drop cached state.
      this.accessControl?.invalidate(workspaceId);

      return {
        sha: sha?.trim() ?? '',
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        subject: subj ?? subject,
        committedAt: committedAt?.trim() ?? new Date().toISOString(),
      };
    });
  }

  /**
   * Commit a single path — bypasses the one-file-per-change guard in
   * `commit()` because the caller has already scoped the change to one
   * path (typically the lock-release flow, where the lock itself
   * guarantees the file is the only one whose edits this user owns).
   *
   * `git add <path>` then `git commit` — other dirty paths in the working
   * tree are left alone. Validation + protected-branch access gating still
   * run, since `path` could itself be `roles.yaml` / `access.md`.
   *
   * Returns `null` when the path has nothing to commit (no diff against
   * HEAD, not untracked) — keeps lock-release idempotent on "I opened the
   * editor but didn't actually change anything" flows.
   */
  /**
   * Reset the file's working-tree state to HEAD — used when a write
   * partially completed but the surrounding flow can't commit it
   * (validator was advisory so this is rare, but op-throws + push-
   * blocked-by-access-control still hit this path). Tracked files
   * `git checkout HEAD --` reverts to the committed content; untracked
   * files (a half-written new file) are deleted outright. Either way
   * the working tree returns to a clean state so the next acquirer
   * doesn't inherit half-finished bytes.
   *
   * Idempotent: a path that's already clean stays clean. Missing paths
   * are silently ignored.
   */
  async discardPath(workspaceId: string, relativePath: string): Promise<void> {
    assertValidRelativePath(relativePath);
    const repoRelativePath = this.stripRepoPrefix(relativePath);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // Tracked-at-HEAD? `ls-files --error-unmatch` returns 0 if so.
      let trackedAtHead = false;
      try {
        await this.git(cwd, ['ls-files', '--error-unmatch', '--', repoRelativePath]);
        trackedAtHead = true;
      } catch {
        trackedAtHead = false;
      }
      if (trackedAtHead) {
        await this.git(cwd, ['checkout', 'HEAD', '--', repoRelativePath]).catch((err) => {
          console.warn(
            `[git] discardPath checkout failed for "${repoRelativePath}":`,
            err instanceof Error ? err.message : err,
          );
        });
      } else {
        // Untracked new file — remove from working tree.
        const fileAbs = path.join(cwd, repoRelativePath);
        await fs.rm(fileAbs, { force: true }).catch((err) => {
          console.warn(
            `[git] discardPath rm failed for "${repoRelativePath}":`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    });
  }

  async commitFile(
    workspaceId: string,
    user: AuthUser,
    relativePath: string,
    summary?: string,
    skipValidator?: boolean,
  ): Promise<CommitAttribution | null> {
    assertValidRelativePath(relativePath);
    assertValidAuthor(user);
    const repoRelativePath = this.stripRepoPrefix(relativePath);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);

      // Path-scoped status — is this specific file dirty? `--porcelain` on
      // a single path returns empty when there's nothing to commit.
      const { stdout: scoped } = await this.git(cwd, [
        'status', '--porcelain=v1', '--', repoRelativePath,
      ]);
      if (!scoped.trim()) return null;

      // **No access check at commit time.** Per the "disk is the source of
      // truth" rule, by the time content is on disk it must not be rejected.
      // The permission check that used to live here now runs at lock
      // acquisition (see `WorkflowService.acquireLock`'s
      // `assertCanWriteAtPath`), so a user can't even start editing a file
      // they lack write permission on — they never reach this commit. The
      // legacy gate could destroy a user's edits when access changed
      // mid-session; lock-time gating eliminates that destructive window.
      //
      // `GitService.commit` (the multi-file variant called by the agent's
      // `commit_change` tool) still gates at commit time because it's used
      // for files dirtied OUTSIDE the LockingFilesystem (e.g. agent
      // manual-merge resolution), where no acquireLock ran.

      // Validation is advisory; see `commit()` above for full rationale.
      // `skipValidator` is set by callers that commit content which was
      // already validated when it was first written — notably the reject
      // flow, which re-commits a pre-agent baseline. Running the validator
      // there is pure latency (it parses the whole KB and regenerates
      // `diagram.md`) for a result that's neither enforced nor surfaced.
      if (!skipValidator) {
        await this.runCommitValidationHooks(
          { workspaceId, branch, paths: [repoRelativePath] },
          (report) =>
            `[git] commitFile on workspace=${workspaceId} branch=${branch} path=${repoRelativePath} landing with ${report.mustFix.length} unresolved KB validator issue(s); commit is no longer blocked.`,
        );
      }

      await this.git(cwd, ['add', '--', repoRelativePath]);

      const subject = summary?.trim() || buildDefaultCommitSummary(repoRelativePath);
      if (subject.length > 200) {
        throw new WorkflowValidationError('commit summary must be ≤ 200 characters');
      }
      if (subject.includes('\n')) {
        throw new WorkflowValidationError('commit summary must be a single line');
      }

      await this.git(cwd, [
        'commit',
        `--author=${user.name} <${user.email}>`,
        '-m', subject,
      ]);

      const { stdout } = await this.git(cwd, [
        'log',
        '-1',
        '--pretty=format:%H%x00%an%x00%ae%x00%s%x00%aI',
      ]);
      const [sha, authorName, authorEmail, subj, committedAt] = stdout.split('\x00');
      this.accessControl?.invalidate(workspaceId);
      return {
        sha: sha?.trim() ?? '',
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        subject: subj ?? subject,
        committedAt: committedAt?.trim() ?? new Date().toISOString(),
      };
    });
  }

  /**
   * Atomic multi-file commit — commits whatever is currently dirty in the
   * working tree as ONE commit attributed to `user`, then returns its
   * attribution (or null when the tree is clean — idempotent re-apply). The
   * multi-file sibling of `commit()`: same `git add -A` + commit, but WITHOUT
   * the one-file-per-change guard — the caller has assembled + written + validated
   * a batch (bulk node upload; the role-rename rewrite via `LockingFilesystem`).
   *
   * Deliberately does NOT write file content itself — disk writes are the
   * caller's job. This is the git layer: it only stages + commits what is already
   * on disk (the working tree is expected otherwise-clean under save=share, so
   * `git add -A` stages exactly the caller's batch). Caller pushes separately
   * (mirrors `commitFile` + `push`).
   */
  async commitChanges(
    workspaceId: string,
    user: AuthUser,
    summary: string,
  ): Promise<CommitAttribution | null> {
    assertValidAuthor(user);
    const subject = summary?.trim();
    if (!subject) throw new WorkflowValidationError('commit summary is required');
    if (subject.length > 200) throw new WorkflowValidationError('commit summary must be ≤ 200 characters');
    if (subject.includes('\n')) throw new WorkflowValidationError('commit summary must be a single line');

    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);

      // Nothing dirty → no-op (idempotent). Compute touched BEFORE `git add` so
      // the protected-branch gate sees the same path set `commit()` would.
      const { stdout: porcelain } = await this.git(cwd, ['status', '--porcelain=v1', '-z']);
      const touched = parsePorcelainZ(porcelain);
      if (touched.length === 0) return null;

      // Protected-branch access gate (defence in depth — callers already gate at
      // lock-acquire / upload-mint, but this primitive is generic). Gate every
      // touched path against the access tree at HEAD, like `commit()`.
      if (isProtectedBranch(branch)) {
        await this.assertCanWriteAtRef(workspaceId, 'HEAD', user.email, touched);
      }

      await this.git(cwd, ['add', '-A']);
      await this.git(cwd, ['commit', `--author=${user.name} <${user.email}>`, '-m', subject]);

      const { stdout } = await this.git(cwd, [
        'log', '-1', '--pretty=format:%H%x00%an%x00%ae%x00%s%x00%aI',
      ]);
      const [sha, authorName, authorEmail, subj, committedAt] = stdout.split('\x00');
      this.accessControl?.invalidate(workspaceId);
      return {
        sha: sha?.trim() ?? '',
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        subject: subj ?? subject,
        committedAt: committedAt?.trim() ?? new Date().toISOString(),
      };
    });
  }

  async push(workspaceId: string, user: AuthUser): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);

      // Access gate fires only when pushing to a protected branch. Pushing
      // a feature/draft branch to its same-named remote can't change
      // canonical state — the PR merge gate (`origin/<base>` access tree)
      // is the real security boundary. Skipping the check here lets non-
      // admins push their drafts freely so they can propose changes via
      // PR. Gate against `origin/<branch>` — the published state — for
      // protected pushes; that's defence-in-depth against local rebases or
      // `commit-tree` shenanigans that might bypass the commit-time gate.
      if (isProtectedBranch(branch)) {
        const touched = await this.unpushedTouchedPaths(cwd);
        await this.assertCanWriteAtRef(
          workspaceId,
          `origin/${branch}`,
          user.email,
          touched,
        );
      }

      await this.git(cwd, ['push', '-u', 'origin', branch]);
    });
  }

  // `forcePush` method removed. The workflow layer no longer auto-force-pushes
  // as a recovery — when the cooperative `pull --rebase` + retry can't
  // reconcile, we throw `PushNeedsAgentResolutionError` and hand off to the
  // agent. The agent has git + gh CLI access and can choose to run a raw
  // `git push --force-with-lease` itself when it has determined that's the
  // correct call (i.e. it semantically merged + force-pushed, or determined
  // the displacing commits were spurious). Removing the wrapper method
  // prevents accidental reintroduction as an "easy fallback" — force-push
  // belongs in the agent's tool surface (raw CLI), not the system's
  // automatic-recovery path.

  /**
   * Attempt a local merge of `origin/<targetBranch>` into the currently-
   * checked-out branch. Used by the workflow module to auto-merge target →
   * source when a change request is opened or refreshed (PLAN §1).
   *
   * Two outcomes:
   *   - `{ kind: 'clean', alreadyUpToDate }` — merge succeeded, possibly as a
   *     no-op (`alreadyUpToDate: true`) or with a new merge commit attributed
   *     to `user` with a descriptive subject + body so reviewers can see why
   *     the merge landed without inspecting the diff.
   *   - `{ kind: 'conflicts', paths }` — `git merge` reported conflicts. The
   *     merge is aborted to leave the working tree clean before returning
   *     the conflicting paths so the caller can route to the agent for
   *     resolution.
   *
   * Requires the source branch to already be checked out and the working
   * tree clean — both refused with structured errors before any git op runs.
   */
  async mergeFromOrigin(
    workspaceId: string,
    sourceBranch: string,
    targetBranch: string,
    user: AuthUser,
  ): Promise<
    | { kind: 'clean'; alreadyUpToDate: boolean }
    | { kind: 'conflicts'; paths: string[] }
  > {
    assertValidBranchName(sourceBranch);
    assertValidBranchName(targetBranch);
    assertValidAuthor(user);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // Under the per-branch workspace model, the workspace's identity is
      // the source branch — the legacy "current branch must equal sourceBranch"
      // guard was an artifact of the single-workspace-many-branches model and
      // is no longer needed. The legacy dirty-tree refusal is also gone:
      // save=share guarantees the tree is clean before any auto-merge runs,
      // and the only way it could be dirty now is an upstream bug, which
      // `statusInternal` already logs server-side.
      // Refresh the target ref so we merge against the latest published
      // state. Failing the fetch here is non-recoverable for this
      // operation: a stale `origin/<target>` would let us silently miss
      // conflicts the next push would surface, and the whole point of
      // `mergeFromOrigin` is to surface those conflicts now. Propagate
      // the error so the auto-merge aborts cleanly instead of producing
      // a merge based on a stale ref. Explicit destination refspec for the
      // same reason as `mergeChangeRequest`: a bare `fetch origin <branch>`
      // updates `origin/<branch>` only as far as `remote.origin.fetch` allows,
      // and a drifted refspec would hand this merge the stale ref it is
      // explicitly trying to avoid.
      await this.git(cwd, [
        'fetch', '--no-write-fetch-head', 'origin',
        `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
      ]);

      // `--no-commit --no-ff` so we control the commit (need to override
      // author) and so we never sneak a fast-forward past the merge-commit
      // explanation gate.
      let mergeStdout = '';
      try {
        const r = await this.git(cwd, [
          'merge', '--no-commit', '--no-ff', `origin/${targetBranch}`,
        ]);
        mergeStdout = r.stdout;
      } catch (err) {
        // Conflict or other failure. Disambiguate via the shared porcelain parse.
        const conflictPaths = await this.conflictedPaths(cwd);
        // Always attempt to abort so a partial merge doesn't poison the tree.
        try {
          await this.git(cwd, ['merge', '--abort']);
        } catch {
          // Already aborted (no MERGE_HEAD) — fine.
        }
        if (conflictPaths.length === 0) throw err;
        return { kind: 'conflicts' as const, paths: conflictPaths };
      }

      // No conflicts. Detect "already up to date" — git prints that exact
      // phrase and stages nothing. Otherwise the merge is staged and waiting
      // for the commit we now author as `user`.
      if (/Already up to date/i.test(mergeStdout)) {
        return { kind: 'clean' as const, alreadyUpToDate: true };
      }
      const subject = `Refresh ${sourceBranch} from ${targetBranch}`;
      const body =
        `Workflow auto-merge: incorporates the latest ${targetBranch} into ${sourceBranch} ` +
        `as part of opening or refreshing a change request. ` +
        `Conflicts (if any) would have been surfaced to the caller before this commit landed; ` +
        `none were detected, so the merge applied cleanly.`;
      await this.git(cwd, [
        'commit',
        `--author=${user.name} <${user.email}>`,
        '-m', subject,
        '-m', body,
      ]);
      this.accessControl?.invalidate(workspaceId);
      return { kind: 'clean' as const, alreadyUpToDate: false };
    });
  }

  /**
   * Merge a change request locally and publish it to the target branch — the
   * provider-agnostic replacement for `gh pr merge`. Runs in the *base* branch's
   * workspace: reset to the published base tip, merge the source's published
   * tip as a `--no-ff` commit authored by the human triggerer, and push.
   *
   * Serialized per base workspace via the mutex, with a bounded retry: if the
   * push is rejected because the base advanced (a concurrent merge), we reset to
   * the new base and re-merge on top of it. Conflicts are deterministic — they
   * return immediately (no retry) so the caller can route into resolution.
   *
   * Returns the merge commit SHA, or the conflicting paths.
   */
  async mergeChangeRequest(
    baseWorkspaceId: string,
    sourceBranch: string,
    targetBranch: string,
    commit: { subject: string; body: string },
    user: AuthUser,
  ): Promise<{ kind: 'merged'; sha: string } | { kind: 'conflicts'; paths: string[] }> {
    assertValidBranchName(sourceBranch);
    assertValidBranchName(targetBranch);
    assertValidAuthor(user);
    const MAX_ATTEMPTS = 3;
    return this.mutex.run(baseWorkspaceId, async () => {
      const cwd = await this.repoDir(baseWorkspaceId);
      // `git merge`/`git commit` need a committer identity. Prod clones are
      // stamped by WorkspaceService, but stamp here too so the merge never
      // depends on that ambient config (it would fail "Committer identity
      // unknown" on a clone that lacks it).
      await this.git(cwd, ['config', 'user.name', BOT_NAME]);
      await this.git(cwd, ['config', 'user.email', BOT_EMAIL]);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        // Explicit destination refspecs, because the two `origin/<branch>`
        // reads below MUST see the tips this fetch just retrieved. A bare
        // `fetch origin <branch>` only updates `refs/remotes/origin/<branch>`
        // *opportunistically* — via whatever `remote.origin.fetch` happens to
        // say — and this PR exists because that refspec drifts. Narrowed (or
        // dropped) it leaves `origin/<source>` stale, so the merge below lands
        // an old source tip on the base and every push attempt burns against
        // the same stale ref. Naming the destinations removes the dependency
        // on ambient config; both branches are `assertValidBranchName`-checked
        // at the top of this method.
        //
        // `--no-write-fetch-head`: a multi-ref fetch writes one for-merge
        // FETCH_HEAD entry PER ref — the exact shape that kills a concurrent
        // `git pull` in this clone (see `pull`). Only the `origin/<branch>`
        // refs below are read.
        await this.git(cwd, [
          'fetch', '--no-write-fetch-head', 'origin',
          `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`,
          `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`,
        ]);
        // Match the published base tip exactly. Protected base branches never
        // carry local commits (save=share + no direct commits), so this only
        // discards a prior attempt's state, never real work.
        await this.git(cwd, ['checkout', targetBranch]);
        await this.git(cwd, ['reset', '--hard', `origin/${targetBranch}`]);

        // `--no-commit --no-ff` so we author the merge commit as the human and
        // never fast-forward past the merge record.
        try {
          await this.git(cwd, ['merge', '--no-commit', '--no-ff', `origin/${sourceBranch}`]);
        } catch (err) {
          const paths = await this.conflictedPaths(cwd);
          await this.git(cwd, ['merge', '--abort']).catch(() => undefined);
          if (paths.length > 0) return { kind: 'conflicts' as const, paths };
          // Not a conflict — surface the underlying git error so the real cause
          // (e.g. missing identity, unrelated histories) is diagnosable.
          throw new Error(
            `git merge failed without detectable conflicts: ${redact(
              err instanceof Error ? err.message : String(err),
            )}`,
          );
        }

        // Nothing staged ⇒ base already contains source (empty CR). The base tip
        // is the "merged" state; report it without an empty commit.
        const { stdout: staged } = await this.git(cwd, ['diff', '--cached', '--name-only']);
        if (staged.trim() === '') {
          const { stdout: sha } = await this.git(cwd, ['rev-parse', 'HEAD']);
          await this.git(cwd, ['merge', '--abort']).catch(() => undefined);
          return { kind: 'merged' as const, sha: sha.trim() };
        }

        await this.git(cwd, [
          'commit',
          `--author=${user.name} <${user.email}>`,
          '-m', commit.subject,
          '-m', commit.body,
        ]);
        const { stdout: sha } = await this.git(cwd, ['rev-parse', 'HEAD']);

        try {
          await this.git(cwd, ['push', 'origin', `HEAD:refs/heads/${targetBranch}`]);
          this.accessControl?.invalidate(baseWorkspaceId);
          return { kind: 'merged' as const, sha: sha.trim() };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Base moved under us — reset to the new tip and re-merge next loop.
          if (/non-fast-forward|\[rejected\]|fetch first/i.test(msg) && attempt < MAX_ATTEMPTS) {
            continue;
          }
          throw err;
        }
      }
      throw new Error(
        `merge push to "${targetBranch}" kept being rejected after ${MAX_ATTEMPTS} attempts (base moving concurrently)`,
      );
    });
  }

  /** Conflicted paths from a half-done merge, parsed from porcelain status. */
  private async conflictedPaths(cwd: string): Promise<string[]> {
    const { stdout } = await this.git(cwd, ['status', '--porcelain=v1']);
    const paths: string[] = [];
    for (const line of stdout.split('\n')) {
      if (/^(UU|AA|DD|AU|UA|DU|UD) /.test(line)) paths.push(line.slice(3));
    }
    return paths;
  }

  /**
   * Paths changed in commits that exist locally but not on the upstream ref —
   * i.e. exactly what the next `push` would publish. Falls back to "every
   * commit not reachable from any remote ref" when there's no upstream yet
   * (first push).
   */
  private async unpushedTouchedPaths(cwd: string): Promise<string[]> {
    let range: string[];
    try {
      await this.git(cwd, ['rev-parse', '--verify', '--quiet', '@{u}']);
      range = ['@{u}..HEAD'];
    } catch {
      range = ['HEAD', '--not', '--remotes'];
    }
    const { stdout } = await this.git(cwd, [
      'log', '--name-only', '--pretty=format:', ...range,
    ]);
    const set = new Set<string>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
    return [...set];
  }


  async fetch(workspaceId: string): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // `--no-write-fetch-head`: callers want the remote-tracking refs, not
      // FETCH_HEAD, and leaving that shared file alone keeps this fetch from
      // steering a concurrent refresh in the same clone (see `pull`).
      await this.git(cwd, ['fetch', '--no-write-fetch-head', 'origin']);
    });
  }

  /**
   * Collapse the clone's drifted tracking config back to one fetch refspec and
   * one upstream ref, then refresh `refs/remotes/origin/<branch>` through an
   * explicit refspec — never touching the shared `FETCH_HEAD`. Returns the ref
   * the caller should operate on.
   *
   * Both halves matter, and neither is sufficient alone:
   *
   * - The self-heal. A multi-valued `branch.<name>.merge` makes every bare
   *   fetch in this clone write more than one *for-merge* FETCH_HEAD entry,
   *   which is the ammunition behind the failure below; a duplicated
   *   `remote.origin.fetch` refspec is the same class of drift (see
   *   `clone-config.ts`). `--replace-all` collapses either back to the single
   *   value the clone was created with. Best effort — the fetch names its refs
   *   explicitly, so a failure here is harmless.
   *
   * - Never reading or writing `FETCH_HEAD`. `git pull` is a two-step
   *   operation — fetch, then read the rebase target out of `.git/FETCH_HEAD`
   *   — and `FETCH_HEAD` is a single mutable file shared by every git process
   *   in the clone. This service is not the only writer: `fetchOriginIfStale`
   *   (outside the workspace mutex, see `listBranches`) and
   *   `WorkspaceService.ensureRemotesFetched` (outside it entirely, driven by
   *   the CR-list poll) both run bare `git fetch --prune origin`, and a bare
   *   fetch writes one for-merge entry per `branch.<name>.merge` value. Let one
   *   of those land in the window between the pull's own fetch and its read, on
   *   a clone whose merge config has drifted to two values, and pull sees two
   *   merge heads and dies with "Cannot rebase onto multiple branches" — the
   *   reported failure. (Measured: ~40% of refreshes with one concurrent fetch
   *   loop. The drifted config alone never breaks it — an explicit
   *   `pull --rebase origin <branch>` survives every drift shape on its own.)
   *
   * So: fetch with an explicit destination refspec, which updates
   * `refs/remotes/origin/<branch>` regardless of any `remote.origin.fetch`
   * drift, and let the caller name that ref. `--no-write-fetch-head` (git
   * 2.29+, asserted at boot by `git-version.ts`) keeps this refresh from
   * perturbing anyone else's `FETCH_HEAD` in turn. Nothing here reads shared
   * mutable state, so no concurrent git process can steer or break it.
   *
   * Shared by the two refresh paths (`pull`, `resetToRemote`) so they can't
   * drift apart — which is precisely the failure class this guards against.
   */
  private async refreshRemoteBranchRef(cwd: string, branch: string): Promise<string> {
    for (const args of cloneTrackingConfigArgs(branch)) {
      await this.git(cwd, args).catch(() => undefined);
    }
    await this.git(cwd, [
      'fetch', '--no-write-fetch-head', 'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    return `refs/remotes/origin/${branch}`;
  }

  async pull(workspaceId: string): Promise<void> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);
      try {
        // Refresh WITHOUT `git pull`, and without touching `FETCH_HEAD` — see
        // `refreshRemoteBranchRef` for why both halves are load-bearing.
        //
        // `--autostash` is load-bearing for the cooperative push recovery.
        // Under save=share the working tree is *supposed* to stay clean, but
        // in practice it can carry modified tracked artifacts (e.g. the
        // validator regenerates a dashboard HTML on every commit) that the
        // single-file commit didn't pick up. A rebase without it aborts
        // outright on those — "cannot rebase: You have unstaged
        // changes" — which is exactly the failure that strands a diverged
        // branch in an unrecoverable loop (the retry push stays non-fast-
        // forward forever). Autostash stashes those modifications, rebases
        // the local commits onto origin, then reapplies them, so the retry
        // push can fast-forward. Untracked files don't block rebase and are
        // left untouched.
        const remoteRef = await this.refreshRemoteBranchRef(cwd, branch);
        await this.git(cwd, ['rebase', '--autostash', remoteRef]);
      } catch (err) {
        // Capture the contested paths BEFORE the abort wipes the rebase
        // state — `--diff-filter=U` lists exactly the files whose replay
        // conflicted. Best-effort: an empty list just means this wasn't a
        // content conflict (or the probe itself failed) and the raw error
        // is surfaced unchanged.
        let conflictedPaths: string[] = [];
        try {
          const { stdout } = await this.git(cwd, ['diff', '--name-only', '--diff-filter=U']);
          conflictedPaths = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
        } catch {
          // fall through with an empty list
        }
        // A failed rebase leaves the repo in a "REBASE_HEAD" / detached-apply state,
        // which makes every subsequent git command behave unexpectedly. Return the
        // working tree to a clean state before surfacing the original error.
        await this.git(cwd, ['rebase', '--abort']).catch(() => undefined);
        if (conflictedPaths.length > 0) {
          // Typed so the workflow layer can queue background recovery — this
          // divergence never resolves on its own (every retry pull hits the
          // same conflict) and the unpushed local commits are someone's saved
          // content stuck violating save=share.
          throw new PullRebaseConflictError(
            branch,
            conflictedPaths,
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
      this.accessControl?.invalidate(workspaceId);
    });
  }

  /**
   * Does the checked-out branch carry commits its remote-tracking ref
   * doesn't reach? Purely local (`rev-list` against
   * `refs/remotes/origin/<branch>` — no network), so a stale tracking ref
   * can only over-report: commits that were in fact already pushed make
   * this return true, and the follow-up push is a harmless no-op. A
   * missing tracking ref (branch never pushed) counts as unpushed — that
   * IS unshared work.
   *
   * Used by the pending-commits worker's no-op arm: a clean tree does NOT
   * mean "nothing to share" when a prior best-effort push (the autosave
   * path) failed and left the committed change stranded locally.
   */
  async hasUnpushedCommits(workspaceId: string): Promise<boolean> {
    const cwd = await this.repoDir(workspaceId);
    const branch = await this.currentBranch(cwd);
    try {
      const { stdout } = await this.git(cwd, [
        'rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`,
      ]);
      return Number(stdout.trim()) > 0;
    } catch {
      return true;
    }
  }

  /**
   * Hard-reset the workspace's checked-out branch to `origin/<branch>`, fetching
   * first. This is the break-glass primitive behind roles.yaml recovery: it
   * makes the local clone EXACTLY match origin, discarding any local divergence
   * (e.g. a half-finished recovery commit from a prior failed push, or commits
   * the clone was behind on). The caller then writes its fix on top of the
   * current origin tip, so the follow-up push fast-forwards instead of being
   * rejected non-fast-forward.
   *
   * Destructive by design and intentionally NOT gated on the protected-branch
   * rule — it only ever moves the LOCAL ref to match origin (no remote mutation),
   * and recovery must work precisely on the protected default branch. Under
   * save=share there is no precious unpushed local work to lose (every save
   * auto-pushes); the one exception is a failed recovery commit, which the
   * caller re-creates.
   */
  async resetToRemote(workspaceId: string, branch: string): Promise<void> {
    assertValidBranchName(branch);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // Same self-heal + FETCH_HEAD-free refresh as `pull`, then reset to the
      // remote-tracking ref it returns — never `FETCH_HEAD`. The stakes here
      // are higher than a failed refresh: this is a hard reset, so a raced
      // FETCH_HEAD would silently reset the workspace to whatever branch the
      // other fetch happened to write. Deliberately no rebase — a divergent
      // local commit can never conflict.
      const remoteRef = await this.refreshRemoteBranchRef(cwd, branch);
      await this.git(cwd, ['reset', '--hard', remoteRef]);
      this.accessControl?.invalidate(workspaceId);
    });
  }

  async resolveForkBase(workspaceId: string, branch: string): Promise<string | null> {
    assertValidBranchName(branch);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      let best: { base: string; ahead: number } | null = null;
      for (const p of PROTECTED_BRANCHES) {
        if (p === branch) continue;
        const res = await this.tryAheadBehind(cwd, branch, `origin/${p}`);
        if (res && (best === null || res.ahead < best.ahead)) {
          best = { base: p, ahead: res.ahead };
        }
      }
      return best?.base ?? null;
    });
  }

  /**
   * Count commits on `branch` that aren't on `baseBranch`. Identical to the
   * "ahead" half of `tryAheadBehind` but exposed as a public method because
   * background callers (the routine runner) need to gate "open a CR or
   * clean the branch up?" on it. Returns 0 when either ref can't be
   * resolved — a missing branch can't possibly be ahead of anything, and
   * misreporting as `> 0` would block legitimate cleanup.
   */
  async countCommitsAhead(
    workspaceId: string,
    branch: string,
    baseBranch: string,
  ): Promise<number> {
    assertValidBranchName(branch);
    assertValidBranchName(baseBranch);
    if (branch === baseBranch) return 0;
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      // Compare against the *remote* base — the routine flow pushes commits
      // to origin as they're made, and matching here against the same ref the
      // CR creator uses (`origin/<base>`) keeps the two readings consistent.
      const res = await this.tryAheadBehind(cwd, branch, `origin/${baseBranch}`);
      return res?.ahead ?? 0;
    });
  }

  /**
   * Whether `head` and `origin/<base>` have any common ancestor. False when
   * `head` is an orphan branch or was created from an unrelated history —
   * GitHub refuses PRs in that state with a `no history in common` error,
   * so PR creation pre-flights this and hands off to the agent on false.
   */
  async haveSharedHistory(
    workspaceId: string,
    base: string,
    head: string,
  ): Promise<boolean> {
    assertValidBranchName(base);
    assertValidBranchName(head);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      try {
        const { stdout } = await this.git(cwd, [
          'merge-base',
          `origin/${base}`,
          head,
        ]);
        return stdout.trim().length > 0;
      } catch (err) {
        // git merge-base exits 1 specifically for "no common ancestor" — the
        // very condition this method tests for. Any other failure (exit 128
        // for invalid args / corrupt repo, ENOENT for missing git binary,
        // etc.) is an infra problem that must bubble up rather than silently
        // masquerade as "no shared history".
        const exitCode = (err as { exitCode?: number }).exitCode;
        if (exitCode === 1) return false;
        throw err;
      }
    });
  }

  async diffStat(workspaceId: string, base?: string): Promise<string[]> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      if (base) assertValidBranchName(base.replace(/^origin\//, ''));
      const against = base ?? '@{upstream}';
      try {
        // `git diff <ref>` (no dots) compares <ref> to the working tree, so
        // this counts uncommitted + committed changes that would land if the
        // caller committed and pushed right now — that's what the share
        // dialog previews. For PR creation the working tree is already clean
        // (the push just ran), so the answer matches the old three-dot form.
        const { stdout } = await this.git(cwd, ['diff', '--name-only', against]);
        return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      } catch {
        // No upstream / unknown base — nothing to diff against.
        return [];
      }
    });
  }

  async pendingChanges(workspaceId: string): Promise<string[]> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const { stdout } = await this.git(cwd, ['status', '--porcelain=v1', '-z']);
      return parsePorcelainZ(stdout);
    });
  }

  /**
   * Repo-relative paths of every VCS-tracked file (NUL-delimited, so paths with
   * spaces or bracketed prefixes survive intact). Untracked / ignored files are
   * excluded — the caller gets exactly the working tree's committed contents.
   */
  async listTrackedFiles(workspaceId: string): Promise<string[]> {
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const { stdout } = await this.git(cwd, ['ls-files', '-z']);
      return stdout.split('\0').filter(Boolean);
    });
  }

  async revertCommit(
    workspaceId: string,
    user: AuthUser,
    sha: string,
  ): Promise<CommitAttribution> {
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
      throw new WorkflowValidationError('invalid commit sha');
    }
    assertValidAuthor(user);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const branch = await this.currentBranch(cwd);

      // Revert creates a new commit reversing `sha`. Same model as commit:
      // gate only on protected branches; reverts on feature/draft branches
      // are free (they produce a commit that would still need to merge via
      // PR to affect canonical state).
      if (isProtectedBranch(branch)) {
        const { stdout: diffOut } = await this.git(cwd, [
          'diff-tree', '--no-commit-id', '--name-only', '-r', sha,
        ]);
        const touched = diffOut.split('\n').map((s) => s.trim()).filter(Boolean);
        await this.assertCanWriteAtRef(workspaceId, 'HEAD', user.email, touched);
      }

      await this.git(cwd, [
        'revert',
        '--no-edit',
        `--author=${user.name} <${user.email}>`,
        sha,
      ]);

      const { stdout } = await this.git(cwd, [
        'log',
        '-1',
        '--pretty=format:%H%x00%an%x00%ae%x00%s%x00%aI',
      ]);
      const [headSha, authorName, authorEmail, subj, committedAt] = stdout.split('\x00');

      // A revert may have touched roles.yaml or access.md — drop cached
      // access state so the next gate read reflects the rolled-back tree.
      // Mirrors the commit / pull paths.
      this.accessControl?.invalidate(workspaceId);

      return {
        sha: headSha?.trim() ?? '',
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        subject: subj ?? '',
        committedAt: committedAt?.trim() ?? new Date().toISOString(),
      };
    });
  }

  async logForFile(
    workspaceId: string,
    relativePath: string,
    limit = 20,
  ): Promise<CommitAttribution[]> {
    assertValidRelativePath(relativePath);
    const max = Math.max(1, Math.min(limit, 100));
    const repoRelativePath = this.stripRepoPrefix(relativePath);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const { stdout } = await this.git(cwd, [
        'log',
        `--max-count=${max}`,
        '--pretty=format:%H%x00%an%x00%ae%x00%s%x00%aI',
        '--',
        repoRelativePath,
      ]);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): CommitAttribution => {
          const [sha, authorName, authorEmail, subject, committedAt] = line.split('\x00');
          return {
            sha: sha ?? '',
            authorName: authorName ?? '',
            authorEmail: authorEmail ?? '',
            subject: subject ?? '',
            committedAt: committedAt ?? '',
          };
        });
    });
  }

  async diffFileAtCommit(
    workspaceId: string,
    relativePath: string,
    sha: string,
  ): Promise<string> {
    assertValidRelativePath(relativePath);
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
      throw new WorkflowValidationError('invalid commit sha');
    }
    const repoRelativePath = this.stripRepoPrefix(relativePath);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      try {
        const { stdout } = await this.git(cwd, [
          'show',
          sha,
          '--',
          repoRelativePath,
        ]);
        return stdout;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to execute git show for "${relativePath}" at "${sha}": ${msg}`,
          { cause: err },
        );
      }
    });
  }

  async diffFileBetweenBranches(
    workspaceId: string,
    relativePath: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<string> {
    assertValidRelativePath(relativePath);
    assertValidBranchName(fromBranch);
    assertValidBranchName(toBranch);
    if (fromBranch === toBranch) {
      throw new WorkflowValidationError('from and to branches must differ');
    }
    const repoRelativePath = this.stripRepoPrefix(relativePath);
    return this.mutex.run(workspaceId, async () => {
      const cwd = await this.repoDir(workspaceId);
      const fromRef = await this.resolveBranchRef(cwd, fromBranch);
      const toRef = await this.resolveBranchRef(cwd, toBranch);
      // When one side is the currently-checked-out branch, diff against the
      // working tree instead of the branch's HEAD commit. Otherwise saves
      // that haven't been committed yet (which is the normal state in the
      // share-changes flow) are invisible — the user just edited the file
      // and would see "identical" if we always compared committed states.
      const current = await this.currentBranch(cwd);
      const isToCurrent = toBranch === current;
      const isFromCurrent = fromBranch === current;
      // `git diff <ref> -- <path>` ignores untracked working-tree files, so a
      // brand-new file (created on disk but never committed) renders as
      // identical between branches. When the current branch is one side and
      // the path is untracked locally, synthesize an added/removed diff —
      // same pattern diffFileWorking uses for HEAD-vs-working-tree.
      if (
        isToCurrent !== isFromCurrent &&
        (await this.isPathUntracked(cwd, repoRelativePath))
      ) {
        return synthesizeUntrackedSideDiff(
          cwd,
          repoRelativePath,
          isToCurrent ? 'added' : 'removed',
        );
      }
      const args = ['diff', '--no-color'];
      if (isToCurrent && !isFromCurrent) {
        // `git diff <ref>` compares ref → working tree, with the working
        // tree's contents shown as `+`. That's exactly the +/- direction
        // we want when "to" is the current branch.
        args.push(fromRef);
      } else if (isFromCurrent && !isToCurrent) {
        // Reverse so the +/- direction matches "from current → to ref":
        // ref's contents show as `+`, working tree shows as `-`.
        args.push('-R', toRef);
      } else {
        // Neither side is the current branch — pure commit-vs-commit.
        // Two-dot, not three-dot: three-dot would be merge-base semantics
        // (PR-style) which would hide changes on the from-side since the
        // fork point — wrong for "compare these two versions right now".
        args.push(fromRef, toRef);
      }
      args.push('--', repoRelativePath);
      try {
        const { stdout } = await this.git(cwd, args);
        return stdout;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to diff "${relativePath}" between "${fromBranch}" and "${toBranch}": ${msg}`,
          { cause: err },
        );
      }
    });
  }

  /**
   * Head/base commit SHAs for a change request, computed locally — no provider
   * API. `head` is the source branch tip, `base` the target branch tip, both
   * resolved on `origin/*` after a fetch so a force-push is reflected. These are
   * what approvals pin against and what the diff range is built from.
   */
  async resolvePrShas(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<{ baseSha: string; headSha: string }> {
    assertValidBranchName(baseBranch);
    assertValidBranchName(headBranch);
    // Fetch (a network round-trip) BEFORE taking the mutex so a slow origin can't
    // block unrelated local git ops on this workspace; the lock guards only the
    // local ref resolution + rev-parse below.
    const cwd = await this.repoDir(workspaceId);
    await this.fetchPrRefs(cwd, baseBranch, headBranch);
    return this.mutex.run(workspaceId, async () => {
      const baseRef = await this.resolveBranchRef(cwd, baseBranch);
      const headRef = await this.resolveBranchRef(cwd, headBranch);
      const [{ stdout: baseSha }, { stdout: headSha }] = await Promise.all([
        this.git(cwd, ['rev-parse', baseRef]),
        this.git(cwd, ['rev-parse', headRef]),
      ]);
      return { baseSha: baseSha.trim(), headSha: headSha.trim() };
    });
  }

  /**
   * The changed-file list for a change request, computed locally via three-dot
   * (merge-base) diff — the same semantics a GitHub PR shows. Replaces the
   * `gh api …/pulls/:n/files` call so any git host works.
   *
   * `--name-status` + `--numstat` (both rename-aware via `-M`) drive the file
   * list, statuses, and +/- counts; per-file patches are generated for up to
   * `patchCap` files (default 400) — beyond that `patch` is left undefined,
   * exactly like the old API's binary/oversized files (the UI renders those with
   * no inline diff). Patch generation is skipped for binary files.
   */
  async changedFilesForPr(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
    opts: { patchCap?: number } = {},
  ): Promise<PullRequestFile[]> {
    assertValidBranchName(baseBranch);
    assertValidBranchName(headBranch);
    const patchCap = opts.patchCap ?? 400;
    // Fetch outside the mutex (network round-trip) so origin latency can't hold
    // the workspace lock; the lock guards only the local diff work below.
    const cwd = await this.repoDir(workspaceId);
    await this.fetchPrRefs(cwd, baseBranch, headBranch);
    return this.mutex.run(workspaceId, async () => {
      const baseRef = await this.resolveBranchRef(cwd, baseBranch);
      const headRef = await this.resolveBranchRef(cwd, headBranch);
      const range = `${baseRef}...${headRef}`; // three-dot = changes on head since merge-base

      const [{ stdout: nameStatusOut }, { stdout: numstatOut }] = await Promise.all([
        this.git(cwd, ['diff', '-M', '-z', '--name-status', range]),
        this.git(cwd, ['diff', '-M', '-z', '--numstat', range]),
      ]);
      const statuses = parseNameStatusZ(nameStatusOut);
      const counts = parseNumstatZ(numstatOut);

      // `--name-status` and `--numstat` enumerate the same files in the same
      // order (same `-M` over the same range), so we zip by index. If the two
      // ever disagree in length, the index alignment is unsafe — fall back to
      // zeroed counts (statuses/paths stay correct) rather than pin the wrong
      // +/- to a file.
      const aligned = counts.length === statuses.length;
      if (!aligned) {
        console.warn(
          `[cr] diff name-status/numstat length mismatch (${statuses.length} vs ${counts.length}) ` +
            `for ${range} — reporting file list without +/- counts`,
        );
      }

      const files: PullRequestFile[] = statuses.map((s, i) => {
        const c = (aligned ? counts[i] : undefined) ?? { additions: 0, deletions: 0, isBinary: false };
        return {
          path: s.path,
          previousPath: s.previousPath,
          status: s.status,
          additions: c.additions,
          deletions: c.deletions,
          patch: undefined,
          isBinary: c.isBinary,
          sha: '',
          rawUrl: '',
        };
      });

      // Generate per-file patches for the first `patchCap` non-binary files.
      let generated = 0;
      for (const f of files) {
        if (generated >= patchCap) break;
        if (f.isBinary) continue;
        f.patch = await this.filePatchForPr(cwd, range, f);
        generated += 1;
      }
      return files;
    });
  }

  /**
   * Just the repo-relative paths changed by a change request (three-dot), no
   * patches — the cheap version used to build CR-list summaries and owner
   * routing. `changedFilesForPr` is the full version with statuses + diffs.
   */
  async changedPathsForPr(
    workspaceId: string,
    baseBranch: string,
    headBranch: string,
  ): Promise<string[]> {
    assertValidBranchName(baseBranch);
    assertValidBranchName(headBranch);
    // Fetch outside the mutex (network round-trip) so origin latency can't hold
    // the workspace lock; the lock guards only the local diff below.
    const cwd = await this.repoDir(workspaceId);
    await this.fetchPrRefs(cwd, baseBranch, headBranch);
    return this.mutex.run(workspaceId, async () => {
      const baseRef = await this.resolveBranchRef(cwd, baseBranch);
      const headRef = await this.resolveBranchRef(cwd, headBranch);
      const { stdout } = await this.git(cwd, [
        'diff', '-M', '--name-only', `${baseRef}...${headRef}`,
      ]);
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    });
  }

  /** Fetch the two branches a CR spans so origin refs reflect the latest push. */
  private async fetchPrRefs(cwd: string, baseBranch: string, headBranch: string): Promise<void> {
    // Best-effort: a branch may be local-only (rare) or origin briefly
    // unreachable; `resolveBranchRef` still falls back to whatever is local.
    // `--no-write-fetch-head` — this runs on the CR-detail path (polled around
    // every merge) and only the `origin/<branch>` refs are read; writing two
    // for-merge FETCH_HEAD entries here can break a concurrent refresh in the
    // same clone (see `pull`).
    //
    // Explicit destination refspecs for the same reason as `mergeChangeRequest`:
    // "reflect the latest push" is exactly what a drifted `remote.origin.fetch`
    // silently stops delivering, and the CR diff would then be computed against
    // a stale head. Every caller `assertValidBranchName`s both branches.
    await this.git(cwd, [
      'fetch', '--no-write-fetch-head', 'origin',
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      `+refs/heads/${headBranch}:refs/remotes/origin/${headBranch}`,
    ]).catch(() => undefined);
  }

  /** Unified-diff patch for one file across the CR range (rename-aware). */
  private async filePatchForPr(
    cwd: string,
    range: string,
    file: PullRequestFile,
  ): Promise<string | undefined> {
    // For a rename, pass both endpoints so `-M` renders it as a rename patch;
    // otherwise the single (destination, or base-side for deletes) path.
    const pathspec =
      file.previousPath && file.previousPath !== file.path
        ? ['--', file.previousPath, file.path]
        : ['--', file.path];
    try {
      const { stdout } = await this.git(cwd, ['diff', '-M', '--no-color', range, ...pathspec]);
      return stdout.length > 0 ? stdout : undefined;
    } catch {
      // A patch failure is cosmetic — the file still shows in the list.
      return undefined;
    }
  }

  // `workingStatus` + `diffFileWorking` removed: both reported the dirty
  // state of a workspace's working tree, which under save=share is always
  // empty. The frontend used these to render a "pending uncommitted edits"
  // panel and per-file diff — neither has a meaningful state to show
  // anymore. `diffFileBetweenBranches` + `diffFileAtCommit` still cover
  // the meaningful diff cases (cross-branch comparisons and history).

  /**
   * Strip the `knowledge-base/` prefix from a workspace-relative path so
   * it lines up with where git actually runs (`cwd = repoDir`, i.e. inside
   * `knowledge-base/`). The frontend stores `openFilePath` as a
   * workspace-relative path including that prefix because the file viewer
   * reads/writes through `WorkspaceService.readFile`, which resolves from
   * the workspace root. Git pathspecs, on the other hand, are resolved from
   * cwd — so without this normalization `git diff -- knowledge-base/X`
   * silently looks for `knowledge-base/knowledge-base/X` and returns
   * nothing, which the UI renders as "identical".
   *
   * No-op for paths already repo-relative (the agent tools and tests pass
   * those directly).
   */
  private stripRepoPrefix(relativePath: string): string {
    return relativePath.startsWith(`${this.kbDirName}/`)
      ? relativePath.slice(this.kbDirName.length + 1)
      : relativePath;
  }

  /**
   * Resolve a branch name to a concrete ref the local clone knows about.
   * Tries the local head first, falls back to the matching remote-tracking
   * ref. The workspace clone fetches all remotes on creation, so protected
   * branches are reachable through `origin/` even when the user has never
   * personally checked them out.
   */
  private async resolveBranchRef(cwd: string, branch: string): Promise<string> {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      try {
        await this.git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
        return ref;
      } catch {
        // Try the next candidate.
      }
    }
    throw new WorkflowValidationError(`unknown branch: ${branch}`);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async statusInternal(workspaceId: string): Promise<WorkingTreeStatus> {
    const cwd = await this.repoDir(workspaceId);
    const branch = await this.currentBranch(cwd);
    // Defensive sanity check. Under save=share a dirty working tree has two
    // very different meanings:
    //   - Rows exist in `pending_commits` for this workspace → EXPECTED. The
    //     saves are on disk and their commits are still draining through the
    //     background worker (a bulk write can queue hundreds of rows, taking
    //     minutes). Not a bug — log quietly for observability.
    //   - No queued rows → files are dirty with nothing scheduled to commit
    //     them: an upstream bug (lock-release crashed mid-write, an external
    //     `git` invocation left state behind, etc.). Warn loudly.
    // Either way it's never surfaced to the user: the structured status no
    // longer carries an isDirty bit, which removes the only path by which a
    // transient working-tree blip used to leak into a user-facing 409.
    const porcelain = await this.git(cwd, ['status', '--porcelain=v1']);
    if (porcelain.stdout.trim().length > 0) {
      let queueExplainsIt = false;
      if (this.pendingCommitsProbe) {
        try {
          queueExplainsIt = await this.pendingCommitsProbe(workspaceId);
        } catch {
          // Probe failure (DB blip) must not break status — fall through to
          // the loud warning, which is the safe-side default.
        }
      }
      const dirtyList = porcelain.stdout.trim().replace(/\s+/g, ' ');
      if (queueExplainsIt) {
        console.log(
          `[git] workspace=${workspaceId} branch=${branch} working tree is dirty while ` +
            `pending commits drain (expected — the background worker is catching up). ` +
            `Files: ${dirtyList}`,
        );
      } else {
        console.warn(
          `[git] workspace=${workspaceId} branch=${branch} has a non-clean working ` +
            `tree under save=share with NO queued pending commits — this should never ` +
            `happen and likely indicates a missed lock-release commit. Files: ${dirtyList}`,
        );
      }
    }

    let hasUpstream = true;
    let unmergedFromUpstream = false;
    try {
      // We don't expose `unpushedCommits` anymore — under save=share every
      // commit is auto-pushed on lock release, so ahead is always 0. We only
      // care about "is origin ahead of us?" for the auto-pull driver.
      const behind = await this.git(cwd, ['rev-list', '--count', 'HEAD..@{u}']);
      unmergedFromUpstream = (parseInt(behind.stdout.trim(), 10) || 0) > 0;
    } catch {
      // Branch has never been published — nothing upstream to compare against.
      // Surfaces via `hasUpstream` so the UI can flag a never-shared draft.
      hasUpstream = false;
    }

    return { branch, hasUpstream, unmergedFromUpstream };
  }

  private async currentBranch(cwd: string): Promise<string> {
    const { stdout } = await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  /**
   * Ahead/behind of `ref` (a full ref like `refs/heads/foo` or
   * `refs/remotes/origin/foo`). When the branch exists locally (`hasLocal`),
   * prefer its configured upstream; otherwise — or when no upstream is set —
   * fall back to the nearest protected branch on origin, picking whichever
   * minimises "ahead" as a proxy for the fork point.
   */
  private async aheadBehindForBranch(
    cwd: string,
    shortName: string,
    ref: string,
    hasLocal: boolean,
  ): Promise<{ ahead: number | null; behind: number | null }> {
    if (hasLocal) {
      const upstream = await this.tryAheadBehind(cwd, ref, `${shortName}@{upstream}`);
      if (upstream) return upstream;
    }

    let best: { ahead: number; behind: number } | null = null;
    for (const p of PROTECTED_BRANCHES) {
      if (p === shortName) continue;
      const res = await this.tryAheadBehind(cwd, ref, `refs/remotes/origin/${p}`);
      if (res && (best === null || res.ahead < best.ahead)) best = res;
    }
    return best ?? { ahead: null, behind: null };
  }

  private async tryAheadBehind(
    cwd: string,
    branch: string,
    base: string,
  ): Promise<{ ahead: number; behind: number } | null> {
    try {
      const { stdout } = await this.git(cwd, [
        'rev-list',
        '--left-right',
        '--count',
        `${base}...${branch}`,
      ]);
      const [behind, ahead] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      return { ahead, behind };
    } catch {
      return null;
    }
  }

  /**
   * Read a repo-relative file's contents at an arbitrary git ref (a branch,
   * `origin/<branch>`, or a sha) WITHOUT checking it out. Returns `null` when
   * the path does not exist at that ref (mirrors the access resolver's
   * `showAtRef`) — the caller distinguishes "absent" from "present but empty".
   * Read-only: `git show <ref>:<path>` never mutates the working tree.
   */
  async readFileAtRef(
    workspaceId: string,
    ref: string,
    repoRelativePath: string,
  ): Promise<string | null> {
    const cwd = await this.repoDir(workspaceId);
    try {
      const { stdout } = await this.git(cwd, ['show', `${ref}:${repoRelativePath}`]);
      return stdout;
    } catch (err) {
      // ONLY "the path doesn't exist at this ref" maps to null. `git show
      // <ref>:<path>` reports that as `fatal: path '<p>' does not exist in
      // '<ref>'` (or `... exists on disk, but not in '<ref>'`). Any other
      // failure — an unresolvable ref, a corrupt object, a repo/IO error —
      // must PROPAGATE, not be misread as "absent": callers like
      // `preserveBaseRolesYaml` compare base-vs-head content and rely on the
      // absent/present distinction being truthful, so a swallowed error
      // (both refs → null → "identical") would fail OPEN. Fail closed instead.
      const stderr =
        (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err));
      if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
      throw err;
    }
  }

  private async repoDir(workspaceId: string): Promise<string> {
    return path.join(await this.workspaceService.getWorkspacePath(workspaceId), this.kbDirName);
  }

  private async isPathUntracked(cwd: string, relativePath: string): Promise<boolean> {
    const { stdout } = await this.git(cwd, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      relativePath,
    ]);
    return stdout.trim().length > 0;
  }

  private async git(cwd: string, args: string[]): Promise<GitRunResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        // `GIT_LITERAL_PATHSPECS=1` makes git treat every pathspec literally
        // instead of interpreting `[`, `]`, `*`, `?`, `!`, or `:(magic)` as
        // glob / magic syntax. KB files routinely arrive with bracketed
        // prefixes like `[Approved] foo.docx` or `[Updated 2025] bar.md`; the
        // upload pipeline (`writeFileBinary` + `releaseLock` + `commitFile`)
        // passes the relative path straight through to `git add` / `git
        // checkout -- <path>`, which would otherwise glob and either match the
        // wrong file or no file at all. Setting it once here covers every git
        // subprocess this service spawns.
        //
        // `LC_ALL=C` / `LANG=C` force git's human-readable output (including
        // stderr) to stable, English, locale-independent text. Callers that
        // classify errors by message — e.g. `readFileAtRef` distinguishing a
        // "path does not exist in <ref>" absence from a hard failure — would
        // otherwise misread a translated message on a non-English host and, for
        // the fail-closed roles.yaml preservation path, fail OPEN.
        env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C', LANG: 'C' },
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip past any leading `-c key=val` pairs so the error names the actual
      // git subcommand that failed (e.g. "git fetch failed:" not "git -c failed:").
      let i = 0;
      while (i < args.length && args[i] === '-c') i += 2;
      const subcommand = args[i] ?? args[0];
      const wrapped = new Error(`git ${subcommand} failed: ${redact(msg)}`) as Error & {
        exitCode?: number;
        stderr?: string;
      };
      // Preserve the underlying exit code / stderr so callers can distinguish
      // expected non-zero exits (e.g. merge-base exit 1 = no common ancestor)
      // from infra failures (ENOENT, exit 128) without parsing message strings.
      const original = err as { code?: unknown; stderr?: unknown };
      if (typeof original.code === 'number') wrapped.exitCode = original.code;
      if (typeof original.stderr === 'string') wrapped.stderr = redact(original.stderr);
      throw wrapped;
    }
  }
}

/** Map a git status letter (`git diff --name-status`) to the DTO's `PrFileStatus`. */
function mapGitStatus(letter: string): PrFileStatus {
  switch (letter[0]) {
    case 'A': return 'added';
    case 'D': return 'removed';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'changed'; // type change (e.g. file ↔ symlink)
    case 'M':
    default: return 'modified';
  }
}

interface NameStatusEntry {
  status: PrFileStatus;
  path: string;
  previousPath?: string;
}

/**
 * Parse `git diff -M -z --name-status` output. NUL-separated tokens: each record
 * is `<statusLetter>\0<path>`, or for a rename/copy `<Rxxx|Cxxx>\0<old>\0<new>`.
 */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const tokens = out.split('\0');
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];
    if (!raw) { i += 1; continue; } // trailing empty token after the final NUL
    const letter = raw[0];
    if (letter === 'R' || letter === 'C') {
      const previousPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (path === undefined) break; // malformed tail — stop rather than throw
      entries.push({ status: mapGitStatus(letter), path, previousPath });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path === undefined) break;
      entries.push({ status: mapGitStatus(letter), path });
      i += 2;
    }
  }
  return entries;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  isBinary: boolean;
}

/**
 * Parse `git diff -M -z --numstat` output, in the SAME file order as
 * `--name-status` (both driven by `-M` over the same range). Each record is
 * `<add>\t<del>\t<path>` for a normal change, or `<add>\t<del>\t\0<old>\0<new>`
 * for a rename (empty path segment before the two NUL-separated names). Binary
 * files report `-` for both counts.
 */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split('\0');
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i];
    if (!raw) { i += 1; continue; }
    const m = raw.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) { i += 1; continue; }
    const isBinary = m[1] === '-' && m[2] === '-';
    const entry: NumstatEntry = {
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      isBinary,
    };
    if (m[3] === '') {
      // Rename: the two names follow as separate NUL-terminated tokens.
      i += 3;
    } else {
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

export { PROTECTED_BRANCHES };
