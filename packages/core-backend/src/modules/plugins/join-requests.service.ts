import {
  isJoinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { type WorkspaceService } from '../workspace/workspace.service.js';
import { logger } from '../../shared/logging.js';

const log = logger('plugins');
import type { KbContext } from '../../shared/kb-context.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import {
  rulesFileFor,
  type AccessRequestTarget,
  type IAccessRequestLifecycle,
} from '../access/access-requests.contract.js';
import type { Verb } from '../access-model/access-grammar.js';
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
 * Access requests as PROPOSALS, and the reconciliation that retires them.
 *
 * The lifecycle has no state of its own — it is derived, every time, from two
 * copies of one file (a folder's `access.md`, or a file's own frontmatter):
 *
 *   open        the branch proposes something the person does not already hold
 *   settled     it does not
 *
 * so "approve" is not an operation on the request at all. An editor grants a
 * principal through the ordinary access path (the same lock + commit every
 * other access edit uses, gated the same way), the default branch gains that
 * entry, and the proposal stops being pending.
 *
 * "Does not already hold" is stronger than "is not in the file", and
 * deliberately so: Owner covers Can edit, a parent folder's grant covers this
 * one, and a role or group carries access without naming anybody. Each of
 * those would leave a proposal nobody can usefully accept — accepting writes
 * a grant that changes nothing — and the request would sit open forever. See
 * {@link JoinRequestsService.unmetProposals}.
 *
 * That reconciliation runs LAZILY on every listing as well as on demand, so
 * access gained anywhere — this banner, the Manage access dialog, a hand
 * edit, a role someone joined — settles the request that asked for it.
 * Nothing has to remember to.
 */
export class JoinRequestsService implements IAccessRequestLifecycle {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workflow: IWorkflowService,
    private readonly kb: Pick<KbContext, 'defaultBranch' | 'defaultWorkspaceId'>,
    /**
     * Read-only, and asked one question only: does this person already hold
     * this verb on the item, on the DEFAULT branch? See {@link unmetProposals}.
     */
    private readonly accessControl: Pick<
      IAccessControl,
      'canRead' | 'canWrite' | 'canOwner' | 'canDownload'
    >,
  ) {}

  /**
   * What `branch` still proposes for `target`, minus everything the person it
   * names already holds — or NULL when the branch's own copy could not be read
   * at all.
   *
   * That distinction is the whole point of the return type. "The branch says
   * nothing" is NOT "the branch proposes nothing", and the two arrive as the
   * same empty diff: `pendingProposals` reads an unreadable file as carrying
   * no grants (fail-closed, which is right for deciding what to SHOW). Used as
   * the settle test it is fail-open in the one direction that cannot be taken
   * back — it closes a request nobody answered.
   *
   * And unreadable is the normal case for a few seconds. These reads go
   * through `origin/<branch>` in the DEFAULT branch's clone, whose fetch is
   * throttled; a request opened moments ago names a ref that clone has not
   * heard of. So a miss is retried behind a FORCED fetch before it is believed,
   * and if it still misses the caller is told nothing rather than something
   * false.
   */
  async proposalsOn(
    branch: string,
    target: AccessRequestTarget,
    opts: { fresh?: boolean } = {},
  ): Promise<JoinProposal[] | null> {
    const rulesPath = rulesFileFor(target);
    await this.refresh({ force: opts.fresh });
    let branchText = await this.readAt(branch, rulesPath);
    if (branchText === null && !opts.fresh) {
      await this.refresh({ force: true });
      branchText = await this.readAt(branch, rulesPath);
    }
    if (branchText === null) return null;
    const proposals = pendingProposals(
      branchText,
      await this.readAt(this.kb.defaultBranch, rulesPath),
      rulesPath,
    );
    return this.unmetProposals(proposals, target);
  }

  /**
   * Drop every proposal the live workspace has already ANSWERED, however it
   * was answered.
   *
   * The file diff alone cannot see this. A request asking for `write` is
   * satisfied by an `owner:` line, by a grant on a parent folder, or by a role
   * or group the person has since joined — none of which put their email into
   * this file, so the diff keeps reporting a proposal nobody can usefully
   * accept (accepting writes a grant that changes nothing, and the request
   * never retires). Asking the resolver the question the dialog's own grant
   * would have to satisfy closes those requests instead of stranding them.
   *
   * A proposal naming a ROLE keeps the literal rule: "does this role hold the
   * verb here" is not a question the per-person resolver answers, and a role
   * proposal is answered by the live rules carrying it.
   */
  private async unmetProposals(
    proposals: JoinProposal[],
    target: AccessRequestTarget,
  ): Promise<JoinProposal[]> {
    const out: JoinProposal[] = [];
    for (const proposal of proposals) {
      if (proposal.principal.kind !== 'user') {
        out.push(proposal);
        continue;
      }
      if (await this.holds(proposal.principal.email, proposal.verb, target.path)) continue;
      out.push(proposal);
    }
    return out;
  }

  /**
   * Does `email` hold `verb` on the ITEM, on the default branch? The verb
   * folds are the resolver's own (owner covers write, write covers read), so
   * this asks exactly what an accepted grant would have to achieve.
   *
   * Best-effort in ONE direction: a resolver that fails answers "no", which
   * leaves the request open. A failure must never close somebody's request for
   * them.
   */
  private async holds(email: string, verb: Verb, itemPath: string): Promise<boolean> {
    const wsId = this.kb.defaultWorkspaceId();
    try {
      switch (verb) {
        case 'owner':
          return await this.accessControl.canOwner(wsId, email, itemPath);
        case 'write':
          return await this.accessControl.canWrite(wsId, email, itemPath);
        case 'download':
          return await this.accessControl.canDownload(wsId, email, itemPath);
        default:
          return await this.accessControl.canRead(wsId, email, itemPath);
      }
    } catch (err) {
      log.warn(
        `could not resolve ${verb} on "${itemPath}" for a request: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  /**
   * Open requests for one item, each carrying only what it still proposes.
   * Requests with nothing left are reconciled away (rejected, branch deleted)
   * and omitted.
   *
   * `key` is what named the branch (`joinBranchFor`) — a plugin's name for a
   * Subscribe request, the item's own path for everything the Manage access
   * dialog opens. `target` is the item whose rules those proposals edit; the
   * two differ only for plugins, whose folder is not their name.
   *
   * `actor` is who the reconciliation acts as — an editor of the item, since
   * rejecting a change request requires write on everything it touches.
   */
  async list(
    key: string,
    target: AccessRequestTarget,
    crs: ChangeRequest[],
    actor: AuthUser,
  ): Promise<JoinRequest[]> {
    const out: JoinRequest[] = [];
    for (const cr of crs) {
      if (cr.state !== 'open' || !isJoinBranchFor(cr.branch, key)) continue;
      const proposals = await this.confirmedProposals(cr.branch, target);
      // Unreadable: leave it exactly as it is. There is nothing to offer an
      // editor and nothing that says it is finished, and closing it on a read
      // that failed would end somebody's request for them. It stays in Change
      // requests for you, where it can still be answered by hand.
      if (proposals === null) continue;
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
    key: string,
    target: AccessRequestTarget,
    cr: ChangeRequest,
    actor: AuthUser,
  ): Promise<boolean> {
    if (cr.state !== 'open' || !isJoinBranchFor(cr.branch, key)) return false;
    const proposals = await this.confirmedProposals(cr.branch, target);
    // Same rule as the listing: only a branch that was READ and, on a fresh
    // read, proposes nothing is finished.
    if (proposals === null || proposals.length > 0) return false;
    await this.settle(cr, actor);
    return true;
  }

  /**
   * What the branch proposes, with an EMPTY answer confirmed against freshly
   * fetched refs before anyone acts on it. Null keeps its meaning: nothing
   * could be read, so nothing can be said.
   *
   * The confirmation is there because an empty answer is the terminal one.
   * These reads go through `origin/<branch>` in the default branch's clone,
   * and that clone's fetch is throttled — so a branch whose remote-tracking
   * ref is a few seconds old answers with the commit BEFORE the proposal was
   * pushed. That is a file identical to live, which is an empty diff, which
   * reads as "every grant has landed". A request nobody answered is then
   * closed, its branch deleted, and the person told it was not accepted.
   *
   * One extra fetch, on the one path that cannot be undone — and when that
   * fetch turns up a proposal after all, it is the answer, not a discarded
   * second opinion.
   */
  private async confirmedProposals(
    branch: string,
    target: AccessRequestTarget,
  ): Promise<JoinProposal[] | null> {
    const first = await this.proposalsOn(branch, target);
    if (first === null || first.length > 0) return first;
    return this.proposalsOn(branch, target, { fresh: true });
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
    const wsId = this.kb.defaultWorkspaceId();
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
      log.warn(
        `could not close settled join request #${cr.number}: ${
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
      log.warn(
        `closed join request #${cr.number} but could not delete "${cr.branch}": ${
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
        this.kb.defaultWorkspaceId(),
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
   *
   * `force` skips the throttle — for the one caller that has already missed
   * and must not mistake a stale ref list for an answer.
   */
  private async refresh(opts: { force?: boolean } = {}): Promise<void> {
    await this.workspaceService
      .ensureRemotesFetched(this.kb.defaultWorkspaceId(), opts)
      .catch(() => undefined);
  }
}
