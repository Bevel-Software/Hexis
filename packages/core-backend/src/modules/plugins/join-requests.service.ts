import {
  DEFAULT_BRANCH,
  isJoinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { workspaceIdForBranch, type WorkspaceService } from '../workspace/workspace.service.js';
import { pendingProposals, type JoinProposal } from './join-proposals.js';

/** One open join change request, with what it still proposes. */
export interface JoinRequest {
  number: number;
  branch: string;
  requesterName: string;
  createdAt: string;
  /** Grants the branch adds over the default branch. Never empty (see below). */
  proposals: JoinProposal[];
}

/**
 * Join requests as PROPOSALS, and the reconciliation that retires them.
 *
 * The lifecycle has no state of its own — it is derived, every time, from two
 * copies of one file:
 *
 *   open        the branch's `access.md` grants something the default's does not
 *   settled     it does not
 *
 * so "approve" is not an operation on the request at all. A manager grants a
 * principal through the ordinary access path (the same lock + commit every
 * other access edit uses, gated the same way), the default branch gains that
 * entry, and the proposal stops being pending because the diff no longer
 * contains it. When the last one goes, the change request has nothing left to
 * say and is rejected, its branch deleted.
 *
 * That reconciliation runs LAZILY on every listing as well as on demand, so a
 * grant made anywhere — this banner, the Manage-access dialog, a hand edit —
 * settles the request that asked for it. Nothing has to remember to.
 */
export class JoinRequestsService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workflow: IWorkflowService,
  ) {}

  /**
   * Open join requests for `plugin`, each carrying only its still-pending
   * proposals. Requests with none left are reconciled away (rejected, branch
   * deleted) and omitted.
   *
   * `actor` is who the reconciliation acts as — a manager of the plugin, since
   * rejecting a change request requires write on everything it touches.
   */
  async list(
    plugin: string,
    folder: string,
    crs: ChangeRequest[],
    actor: AuthUser,
  ): Promise<JoinRequest[]> {
    await this.refresh();
    const accessPath = `${folder}/access.md`;
    const baseText = await this.readAt(DEFAULT_BRANCH, accessPath);
    const out: JoinRequest[] = [];
    for (const cr of crs) {
      if (cr.state !== 'open' || !isJoinBranchFor(cr.branch, plugin)) continue;
      const proposals = pendingProposals(
        await this.readAt(cr.branch, accessPath),
        baseText,
        accessPath,
      );
      if (proposals.length === 0) {
        await this.settle(cr, actor);
        continue;
      }
      out.push({
        number: cr.number,
        branch: cr.branch,
        requesterName: cr.appAuthor?.name ?? 'Someone',
        createdAt: cr.createdAt,
        proposals,
      });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Re-check ONE request and settle it if nothing is pending. Returns whether
   * it was settled. Called right after a grant so the banner updates in the
   * same round-trip instead of waiting for the next listing.
   */
  async reconcile(
    plugin: string,
    folder: string,
    cr: ChangeRequest,
    actor: AuthUser,
  ): Promise<boolean> {
    if (cr.state !== 'open' || !isJoinBranchFor(cr.branch, plugin)) return false;
    await this.refresh();
    const accessPath = `${folder}/access.md`;
    const proposals = pendingProposals(
      await this.readAt(cr.branch, accessPath),
      await this.readAt(DEFAULT_BRANCH, accessPath),
      accessPath,
    );
    if (proposals.length > 0) return false;
    await this.settle(cr, actor);
    return true;
  }

  /**
   * Close a request whose proposals have all landed, and delete its branch.
   *
   * Rejecting rather than merging is the point: the grants are already on the
   * default branch, so merging would replay a diff that is now empty of
   * meaning while dragging along anything else the branch carries. The branch
   * goes too — it exists only to hold a proposal that no longer exists.
   *
   * Best-effort by contract: this runs inside a listing, and a request that
   * cannot be closed right now must not take the listing down with it. The
   * next pass tries again.
   */
  private async settle(cr: ChangeRequest, actor: AuthUser): Promise<void> {
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    try {
      await this.workflow.rejectChangeRequest(
        cr.number,
        actor,
        cr.state,
        cr.authorId ?? null,
        cr.base,
        wsId,
      );
    } catch (err) {
      console.warn(
        `[plugins] could not close settled join request #${cr.number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    try {
      await this.workflow.deleteBranch(wsId, cr.branch, actor);
    } catch (err) {
      // The request is closed either way; a leftover branch is cosmetic and
      // the author can still delete it themselves.
      console.warn(
        `[plugins] closed join request #${cr.number} but could not delete "${cr.branch}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The file at one branch, or null when it is absent/unreadable there.
   *
   * Every read runs against the DEFAULT branch's clone at `origin/<branch>`,
   * so one workspace answers for every request and a join branch never needs
   * a clone of its own. `readFileAtRef` takes a REPO-relative path (the KB
   * dir is the repo root there).
   */
  private async readAt(branch: string, repoRelPath: string): Promise<string | null> {
    try {
      return await this.workspaceService.readFileAtRef(
        workspaceIdForBranch(DEFAULT_BRANCH),
        `origin/${branch}`,
        repoRelPath,
      );
    } catch {
      return null;
    }
  }

  /**
   * Refresh remote-tracking refs before reading them. Throttled inside, and
   * best-effort: a request pushed seconds ago is worth one fetch, but a fetch
   * failure must degrade to "read what we have" rather than empty the list.
   */
  private async refresh(): Promise<void> {
    await this.workspaceService
      .ensureRemotesFetched(workspaceIdForBranch(DEFAULT_BRANCH))
      .catch(() => undefined);
  }
}
