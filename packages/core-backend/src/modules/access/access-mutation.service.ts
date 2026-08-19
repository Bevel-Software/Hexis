/**
 * AccessMutationService — the WRITE side of access control.
 *
 * `AccessControlService` resolves permissions (read-only); this service mutates
 * them. It grants / revokes / re-verbs a principal on a KB path by surgically
 * splicing the relevant `access.md` (folder target) or the node's own
 * frontmatter (file target), then re-resolves the effective access so the
 * caller can return an authoritative, fresh view.
 *
 * Invariants this service owns (the route wires the lock + commit around it):
 *   - SURGICAL SPLICE, never parse→emit: comments + markdown bodies survive
 *     (see access-splice.ts).
 *   - INJECTION-SAFE: every principal is validated before it touches a file.
 *   - INDEPENDENT VERBS: a grant adds the principal under exactly the verb asked
 *     for and touches no other verb. Verbs are NOT a strict hierarchy — `read`,
 *     `write`, `owner`, and `download` are independent lists, and a principal may
 *     legitimately appear under several at once (e.g. `read` + `download`, or
 *     `owner` + `download`). (The RESOLVER happens to let an `owner`/`write`
 *     grant imply lower read access, but that's a read-side convenience, not a
 *     rule the write side enforces by collapsing entries.) This keeps the model
 *     open to future verbs that don't nest.
 *   - FILE vs FOLDER: a file target edits the node's OWN frontmatter (no sibling
 *     leak); a folder target edits the folder's `access.md`.
 *   - UNCONDITIONAL REVOKE: a revoke always removes what it's asked to — there is
 *     no last-owner guard and no self-lockout guard. `owner` names who validates a
 *     file/folder, not a stronger privilege tier, so removing the last owner
 *     creates no lockout; and a user may drop their own access (including write),
 *     since admins keep rescue access regardless.
 *
 * Paths in/out of this service are REPO-RELATIVE (e.g. `Knowledge/Sales`,
 * `Knowledge/Sales/Deal.md`). The route strips the `<kbDirName>/` prefix once at
 * entry; everything here speaks repo-relative, matching `IAccessControl`.
 */

import path from 'node:path';

import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { IAccessControl } from './access-control.interface.js';
import {
  type Verb,
  KNOWN_VERBS,
  ROLE_TOKEN_PREFIX,
  canonicalRoleName,
} from './access-control.service.js';
import {
  spliceRevoke,
  spliceGrant,
  validatePrincipal,
  AccessSpliceError,
  type Principal,
  type TokenMatch,
} from './access-splice.js';
import { WorkflowDomainError } from '../workflow/workflow.errors.js';

/** Whether the dialog target is a folder (edit folder access.md) or a file (edit node frontmatter). */
export type TargetKind = 'folder' | 'file';

/** Bad-request-class mutation failure (invalid principal, unknown role/group, lockout). */
export class AccessMutationError extends WorkflowDomainError {
  constructor(message: string, status = 400, payload?: Record<string, unknown>) {
    super(message, status, payload);
    this.name = 'AccessMutationError';
  }
}

/**
 * The `access.md` path that governs a folder. For the repo root (`''`) this is
 * `access.md`; otherwise `<dir>/access.md`.
 */
export function accessMdPathForFolder(repoRelDir: string): string {
  return repoRelDir ? `${repoRelDir}/access.md` : 'access.md';
}

/**
 * The file whose frontmatter governs a node — the node file itself. (A file
 * target edits its OWN frontmatter, not the folder's access.md, so a per-file
 * grant never leaks to siblings.)
 */
export function targetFileForNode(repoRelFile: string): string {
  return repoRelFile;
}

export class AccessMutationService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
  ) {}

  /**
   * Resolve the file we'll actually edit for a (kind, target) pair, repo-relative.
   *   - folder → the folder's `access.md` (block-list form)
   *   - file   → the node file itself (its own frontmatter, scalar form allowed)
   */
  fileToEdit(kind: TargetKind, repoRelTarget: string): { editPath: string; allowScalar: boolean } {
    if (kind === 'folder') {
      return { editPath: accessMdPathForFolder(repoRelTarget), allowScalar: false };
    }
    return { editPath: targetFileForNode(repoRelTarget), allowScalar: true };
  }

  /**
   * Read the to-be-edited file's current text, or '' when it's an expected
   * missing file. `allowMissing` is true only where an absent file is normal
   * (a folder that has no `access.md` yet); there we swallow ENOENT/ENOTDIR.
   * Every other error — a typoed node target, a transient read failure — is
   * rethrown so we never treat it as empty and write a brand-new access file.
   */
  private async readOrEmpty(
    workspaceId: string,
    repoRelEditPath: string,
    allowMissing: boolean,
  ): Promise<string> {
    const wsRelative = this.toWorkspaceRelative(repoRelEditPath);
    try {
      return await this.workspaceService.readFile(workspaceId, wsRelative);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (allowMissing && (code === 'ENOENT' || code === 'ENOTDIR')) {
        return '';
      }
      throw err;
    }
  }

  private toWorkspaceRelative(repoRelative: string): string {
    return path.posix.join(this.kbDirName, repoRelative);
  }

  /**
   * How a REVOKE of `principal` matches file tokens — the shadowing rule:
   *
   *   - When a GROUP owns the principal's bare name (group-first precedence),
   *     the two spellings are DIFFERENT principals: the bare token is the
   *     group's, `role/<name>` is the role's. Matching is `'exact'` so
   *     revoking the role never strips the group's bare grant (and revoking
   *     the group never strips the role's explicit grant).
   *   - Unshadowed, both spellings resolve to the ROLE (bare falls back to
   *     it), so matching is `'name'`: revoking the role also removes legacy
   *     bare spellings — the historical cleanup behavior.
   *
   * Judged against THIS workspace's merged principal index (`kbPrincipals` —
   * the same model the resolver reads), so revoke agrees with resolution on
   * who owns the bare key. A model that fails to load yields no groups, i.e.
   * unshadowed — matching degrades to the pre-groups name-level behavior.
   */
  private async revokeTokenMatch(workspaceId: string, principal: Principal): Promise<TokenMatch> {
    if (principal.kind !== 'role') return 'exact'; // user matching ignores the mode
    const canonical = canonicalRoleName(principal.role);
    const bare = canonical.startsWith(ROLE_TOKEN_PREFIX)
      ? canonical.slice(ROLE_TOKEN_PREFIX.length)
      : canonical;
    const { groups } = await this.accessControl.kbPrincipals(workspaceId);
    const shadowed = groups.some((g) => canonicalRoleName(g) === bare);
    return shadowed ? 'exact' : 'name';
  }

  /**
   * Grant `principal` `verb` on `target`. Adds the principal under exactly this
   * verb and touches no other verb — verbs are independent, so a principal may
   * hold several at once (e.g. `read` + `download`). Idempotent: a no-op when the
   * principal already holds the verb. Reads the current file FRESH (the caller
   * holds the lock), splices, and writes back. Returns whether anything changed.
   *
   * Throws `AccessMutationError` for an invalid/unknown principal. The caller is
   * responsible for the permission gate and the lock; this method only mutates
   * file content.
   */
  async grant(
    workspaceId: string,
    kind: TargetKind,
    repoRelTarget: string,
    verb: Verb,
    principal: Principal,
  ): Promise<{ changed: boolean; editPath: string }> {
    this.assertPrincipalSafe(principal); // injection/shape guard (role-exists is the route's job)
    const { editPath, allowScalar } = this.fileToEdit(kind, repoRelTarget);
    const current = await this.readOrEmpty(workspaceId, editPath, kind === 'folder');
    let result;
    try {
      result = spliceGrant(current, verb, principal, { allowScalar, target: kind === 'folder' ? 'folder' : 'node' });
    } catch (err) {
      throw this.toMutationError(err);
    }
    if (result.changed) {
      await this.workspaceService.writeFile(
        workspaceId,
        this.toWorkspaceRelative(editPath),
        result.text,
      );
      // Drop the resolver cache so any same-request re-resolve reads the new
      // bytes (mirrors revoke()'s post-write invalidation).
      this.accessControl.invalidate(workspaceId);
    }
    return { changed: result.changed, editPath };
  }

  /**
   * Revoke `principal` from `target`. Removes them from ALL verbs on the edited
   * file (a revoke is "no longer has access here", not "drop one verb"), or just
   * the one `verb` when given. A revoke is UNCONDITIONAL — there is deliberately
   * no last-owner guard and no self-lockout guard. `owner` is not a privilege
   * tier (it names who validates a file/folder, not a stronger grant), so
   * removing the last owner creates no lockout to protect against; and a user
   * dropping their own access — including their own write — is a legitimate
   * choice (admins keep rescue access regardless). The caller holds the lock and
   * supplies the acting user (used for attribution / future per-principal checks).
   */
  async revoke(
    workspaceId: string,
    kind: TargetKind,
    repoRelTarget: string,
    principal: Principal,
    // Kept on the signature: the route supplies it, for attribution / future
    // per-principal checks. Not consumed yet.
    _actingUserEmail: string,
    // When present, strip ONLY this verb (a per-checkbox toggle in the share UI);
    // absent strips the principal from every verb (the whole-principal Remove).
    verb?: Verb,
  ): Promise<{ changed: boolean; editPath: string }> {
    void _actingUserEmail; // referenced to satisfy no-unused-vars until something consumes it
    this.assertPrincipalSafe(principal); // same injection/shape guard grant runs
    const { editPath } = this.fileToEdit(kind, repoRelTarget);
    // Allow a missing target only for a folder (no access.md yet is normal); a
    // missing FILE node is a bad target and should surface, not silently no-op
    // — same rule grant() uses.
    const original = await this.readOrEmpty(workspaceId, editPath, kind === 'folder');
    // Alias-tolerant vs exact-token matching, decided by group shadowing —
    // see revokeTokenMatch.
    const tokenMatch = await this.revokeTokenMatch(workspaceId, principal);
    let next = original;
    let changed = false;
    try {
      const verbsToRevoke = verb ? [verb] : KNOWN_VERBS;
      for (const v of verbsToRevoke) {
        const r = spliceRevoke(next, v, principal, {
          target: kind === 'folder' ? 'folder' : 'node',
          tokenMatch,
        });
        next = r.text;
        changed = changed || r.changed;
      }
    } catch (err) {
      throw this.toMutationError(err);
    }
    if (!changed) return { changed: false, editPath };

    const wsRelative = this.toWorkspaceRelative(editPath);
    await this.workspaceService.writeFile(workspaceId, wsRelative, next);
    this.accessControl.invalidate(workspaceId);

    return { changed: true, editPath };
  }

  /**
   * Restrict access to JUST this target by adding a `deny <principal>` at the
   * target — the per-item override for a principal whose access is inherited
   * from a parent (Drive's "limited-access folder" analog). Closeness-first
   * resolution makes the closer `deny` shadow the farther grant for the
   * target's subtree, without touching any ancestor.
   *
   * Two subtleties this method owns (eng review D5 / D9):
   *   1. STRIP-THEN-DENY: the resolver lets a grant in a scope override a deny
   *      of the same principal in that SAME scope (`buildScope`'s "a grant
   *      sticks"). So if the target already names the principal under a verb as
   *      a grant, writing a bare `deny` next to it would be silently discarded.
   *      We first revoke any same-scope grant for the principal, THEN add the
   *      deny — so the deny actually takes effect.
   *   2. POST-RESOLVE ASSERT: after writing, we re-resolve and confirm the
   *      principal genuinely lost effective access on the target. If they
   *      didn't (e.g. the deny had no effect for a reason we didn't model), we
   *      roll the file back and error rather than report a no-op success — the
   *      "never a silent no-op" invariant this whole slice exists to uphold.
   *
   * Folder target → the folder's `access.md`; file target → its own frontmatter.
   * The caller holds the lock and has already authorized write on the target.
   *
   * `verb` scopes the restriction: when given, ONLY that verb is denied here
   * (the per-checkbox "restrict just this verb on this item" — e.g. unchecking
   * an inherited `write` while keeping a direct `download`); when absent, the
   * whole principal is denied across every verb (the whole-row "block this
   * person from this item"). The strip-then-deny and the effectiveness assert
   * apply to whichever verbs were targeted.
   */
  async denyHere(
    workspaceId: string,
    kind: TargetKind,
    repoRelTarget: string,
    principal: Principal,
    verb?: Verb,
  ): Promise<{ changed: boolean; editPath: string }> {
    this.assertPrincipalSafe(principal);
    const { editPath, allowScalar } = this.fileToEdit(kind, repoRelTarget);
    const original = await this.readOrEmpty(workspaceId, editPath, kind === 'folder');

    const verbsToDeny = verb ? [verb] : KNOWN_VERBS;
    // Same shadowing-aware matching as revoke(): the strip must not swallow a
    // same-named OTHER principal's grant (bare = group vs role/<name> = role).
    const tokenMatch = await this.revokeTokenMatch(workspaceId, principal);
    let next = original;
    try {
      for (const v of verbsToDeny) {
        // (1) Strip any same-scope GRANT for this principal so grant-beats-deny
        // can't silently swallow the deny we're about to add.
        next = spliceRevoke(next, v, principal, {
          target: kind === 'folder' ? 'folder' : 'node',
          tokenMatch,
        }).text;
        // (2) Add the deny under the same verb.
        next = spliceGrant(next, v, principal, { allowScalar, deny: true, target: kind === 'folder' ? 'folder' : 'node' }).text;
      }
    } catch (err) {
      throw this.toMutationError(err);
    }

    if (next === original) {
      // The principal was already denied here (for the targeted verb[s]) — nothing to write.
      return { changed: false, editPath };
    }

    const wsRelative = this.toWorkspaceRelative(editPath);
    await this.workspaceService.writeFile(workspaceId, wsRelative, next);
    this.accessControl.invalidate(workspaceId);

    // (3) Assert the deny actually removed effective access on the targeted
    // verb(s) — else roll back.
    const stillHas = await this.principalStillHasAccess(
      workspaceId,
      kind,
      repoRelTarget,
      principal,
      verb,
    );
    if (stillHas) {
      await this.workspaceService.writeFile(workspaceId, wsRelative, original);
      this.accessControl.invalidate(workspaceId);
      throw new AccessMutationError(
        'The restriction had no effect — this person still has access here. Remove the grant at its source instead.',
        409,
        { kind: 'deny-ineffective' },
      );
    }

    return { changed: true, editPath };
  }

  /**
   * True iff `principal` still effectively holds the targeted access on the
   * target after a mutation — `verb` scopes it to that one verb, else it checks
   * ANY verb. This is the deny-effectiveness check, so it must reflect REAL
   * access — not just "is there a removable file entry."
   *
   * For a USER, that distinction matters: effective access includes admin-rescue
   * on `access.md`/`roles.yaml`, role/group membership, and the built-in `everyone` —
   * none of which `grantSources` reports (it is MECE over file-backed
   * direct/ancestor entries only). So we ask the same `canRead/canWrite/
   * canDownload/canOwner` resolver every real access decision uses; if the
   * targeted verb is still true, the deny didn't take and `denyHere` rolls back.
   * (This is why the admin-rescue case rolls back: the admin still `canWrite` the
   * access.md even with no file entry. It also correctly catches a verb-scoped
   * `deny write` that can't bite because the principal is an `owner` — `canWrite`
   * stays true via the owner implication.)
   *
   * For a ROLE principal there is no per-role "can log in" check, but a role only
   * ever holds access by being NAMED in a file (no rescue / role-via-role /
   * everyone indirection applies to a role token), so `grantSources` IS its
   * complete effective-access answer (scoped to `verb` when given).
   */
  private async principalStillHasAccess(
    workspaceId: string,
    kind: TargetKind,
    repoRelTarget: string,
    principal: Principal,
    verb?: Verb,
  ): Promise<boolean> {
    if (principal.kind === 'user') {
      const email = principal.email;
      const canOf: Record<Verb, () => Promise<boolean>> = {
        read: () => this.accessControl.canRead(workspaceId, email, repoRelTarget),
        write: () => this.accessControl.canWrite(workspaceId, email, repoRelTarget),
        download: () => this.accessControl.canDownload(workspaceId, email, repoRelTarget),
        owner: () => this.accessControl.canOwner(workspaceId, email, repoRelTarget),
      };
      const verbs = verb ? [verb] : KNOWN_VERBS;
      const results = await Promise.all(verbs.map((v) => canOf[v]()));
      return results.some(Boolean);
    }
    const sources = await this.accessControl.grantSources(workspaceId, kind, repoRelTarget, {
      kind: 'role',
      role: principal.role,
    });
    return verb ? sources[verb] !== undefined : Object.keys(sources).length > 0;
  }

  /**
   * Sync placeholder for "is this a real principal" — role validity is checked
   * asynchronously in the route (it needs the roles model). Here we only run the
   * cheap injection/shape validation so a malformed principal never reaches the
   * splice. Role-exists-in-roles.yaml is the route's job (so it can offer
   * an honest 404 for an unknown role/group).
   */
  private assertPrincipalSafe(principal: Principal): void {
    try {
      validatePrincipal(principal);
    } catch (err) {
      throw this.toMutationError(err);
    }
  }

  private toMutationError(err: unknown): AccessMutationError {
    if (err instanceof AccessMutationError) return err;
    if (err instanceof AccessSpliceError) return new AccessMutationError(err.message, 400);
    return new AccessMutationError(err instanceof Error ? err.message : 'mutation failed', 500);
  }
}
