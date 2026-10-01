import path from 'node:path';
import {
  joinBranchFor,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import {
  ChangeRequestConflictsError,
  DuplicateChangeRequestError,
} from '../../shared/domain-errors.js';
import { isAbsence } from '../../shared/fs.contract.js';
import type { KbContext } from '../../shared/kb-context.js';
import { spliceGrant } from '../access-model/access-splice.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { logger } from '../../shared/logging.js';
import { AccessMutationError } from './access-mutation.service.js';
import {
  rulesFileFor,
  type AccessRequestTarget,
  type IAccessRequestLifecycle,
  type RequestLevel,
} from './access-requests.contract.js';

/** How the dialog spells each level — the same words the request is answered in. */
const log = logger('access.request');

export const LEVEL_LABEL: Record<RequestLevel, string> = {
  write: 'Can edit',
  owner: 'Owner',
};

/** What the requester's own dialog shows in place of the control. */
export interface AccessRequestStatus {
  /**
   *  - `none`         nothing outstanding; show the control.
   *  - `pending`      a request is open and still asking for something.
   *  - `not-accepted` their last request closed without the access landing.
   */
  state: 'none' | 'pending' | 'not-accepted';
  level?: RequestLevel;
  number?: number;
}

/** The name an item is called by in a title — the last path segment. */
export function itemNameOf(repoRelPath: string): string {
  if (!repoRelPath) return 'the workspace';
  return path.posix.basename(repoRelPath) || repoRelPath;
}

/**
 * Neutralise every character a markdown renderer would read as structure.
 *
 * The note is somebody's free text and it lands in a change request's
 * description, which IS rendered. Escaping it is what makes "plain text" true:
 * without this a note can carry a heading, a link, or an image pointing at a
 * URL that logs whoever opens the request.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}

/** The exact inverse of {@link escapeMarkdown} — only our own backslashes go. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
}

/**
 * The fence the note sits behind in a request's description.
 *
 * The description is the note's only home — there is no column for it — so the
 * editors' banner has to read it back out of prose. Marking the block means
 * that read is exact rather than a guess at which paragraph was the note, and
 * an HTML comment is invisible in every surface that renders the description.
 */
const NOTE_OPEN = '<!--hexis:access-request-note-->';
const NOTE_CLOSE = '<!--/hexis:access-request-note-->';

/**
 * The level, recorded on the change request itself.
 *
 * The branch says what is proposed, but only while it can be read — and a
 * clone whose refs are a few seconds stale cannot read a branch cut moments
 * ago. The request's own row always can. "Requested: <level>" is a promise
 * about a request, so it is answered from the request, not from a file at a
 * ref that may not have arrived yet.
 */
const LEVEL_MARK = /<!--hexis:access-request-level:(write|owner)-->/;

/**
 * The requester's own words, back out of a request's description, or
 * undefined when they wrote none. Unescaped exactly as they were escaped, so
 * what the banner shows is what was typed.
 */
/**
 * The level a request asks for, off its own description. Undefined for a
 * request opened before this marker existed — those are the skill route's,
 * and the skill route only ever asked for `write`.
 */
export function extractRequestLevel(body: string | null | undefined): RequestLevel | undefined {
  const hit = body ? LEVEL_MARK.exec(body) : null;
  return hit ? (hit[1] as RequestLevel) : undefined;
}

export function extractRequestNote(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const start = body.indexOf(NOTE_OPEN);
  if (start < 0) return undefined;
  const end = body.indexOf(NOTE_CLOSE, start);
  if (end < 0) return undefined;
  const note = body
    .slice(start + NOTE_OPEN.length, end)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('>'))
    .map((line) => unescapeMarkdown(line.replace(/^>\s?/, '')))
    .join('\n')
    .trim();
  return note || undefined;
}

/**
 * Asking for Can edit or Owner on ONE item, and reading back what came of it.
 *
 * A request is a change request whose branch proposes exactly one grant in the
 * item's own rules — a folder's `access.md`, or a file's own frontmatter — and
 * nothing else. There is no request table: the branch IS the request, named
 * deterministically from (person, item), so a second click finds the first
 * click's request instead of opening a rival. Editors answer it by granting
 * through the ordinary access path, and it retires itself
 * ({@link IAccessRequestLifecycle}) once the access has landed however it
 * landed.
 *
 * Keyed on the ITEM'S PATH, which is what the skill page's "Request write
 * access" keys on too — so a Can edit request on a skill's folder and that
 * button open one request, shown on both surfaces.
 */
export class AccessRequestsService {
  constructor(
    private readonly deps: {
      workflow: IWorkflowService;
      workspaceService: WorkspaceService;
      lifecycle: IAccessRequestLifecycle;
      kb: Pick<KbContext, 'defaultBranch' | 'defaultWorkspaceId' | 'kbDirName'>;
    },
  ) {}

  /** The branch a request from `email` about `target` always lives on. */
  branchFor(email: string, target: AccessRequestTarget): string {
    return joinBranchFor(email, target.path);
  }

  /**
   * Open `user`'s request for `level` on `target`, or answer with the one they
   * already have open. Never opens a second request for the same pair.
   */
  async open(input: {
    user: AuthUser;
    target: AccessRequestTarget;
    itemName: string;
    level: RequestLevel;
    note?: string;
  }): Promise<{ number: number; level: RequestLevel }> {
    const { user, target, itemName, level } = input;
    const note = (input.note ?? '').trim();
    const { workflow, workspaceService, kb } = this.deps;
    const wsId = kb.defaultWorkspaceId();
    const branch = this.branchFor(user.email, target);

    // FRESH, and matched on the BRANCH rather than on the author: a repeated
    // click must find the request the previous one opened (the cached listing
    // can trail it), and the same lookup has to prove the branch free before
    // it is recut below. The branch name already carries the person, so
    // matching it is matching them.
    const openOnBranch = async () =>
      (await workflow.listChangeRequests({ fresh: true })).find(
        (cr) => cr.state === 'open' && cr.branch === branch,
      );
    const existing = await openOnBranch();
    if (existing) return { number: existing.number, level: await this.levelOf(existing.number) };

    // Existence is PROBED, before and — if creation fails — after: the race
    // shows up as "already exists" locally or as a rejected push when origin
    // got there first, and a message is not a contract. STRICT: the list
    // proves absence, and a listing that could not fetch proves nothing.
    const branchExists = async () =>
      (await workflow.listBranches(wsId, { freshFetch: true, strictFetch: true })).some(
        (b) => b.name === branch,
      );
    // A branch still standing here belonged to an ANSWERED request: it holds a
    // dead proposal on a base that may be months old. It cannot simply be
    // written to. `openChangeRequest` merges live INTO the source branch, and
    // that merge conflicts the moment live has touched the same rules file —
    // which an editor granting anyone anything on this item does. The person
    // asking would be shown "resolve the conflicts on <an internal branch>",
    // about a branch they cannot reach, for good.
    //
    // So the branch is CUT AGAIN from live. Live's tip is then the merge base,
    // the auto-merge is a no-op, and the diff is exactly the one grant this
    // request proposes. Deleting it also retires its clone, so the old content
    // cannot come back (`deleteBranch`), and `deleteBranch` refuses a branch
    // with an open request — the guard against recutting one under a request
    // that opened in the meantime.
    let present = await branchExists();
    if (present) {
      try {
        await workflow.deleteBranch(wsId, branch, user);
        // A delete that RETURNED is proof enough; re-probing here would let a
        // ref list that has not caught up talk us out of cutting the branch we
        // just removed, and the proposal would have nowhere to go.
        present = false;
      } catch (err) {
        // It raced into an open request, or could not be removed. Answer with
        // the request if there is one; otherwise carry on against the branch
        // as it stands, which is what this did before and still works whenever
        // the live rules have not moved.
        const raced = await openOnBranch();
        if (raced) return { number: raced.number, level: await this.levelOf(raced.number) };
        log.warn(
          `could not recut the request branch "${branch}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (!present) {
      try {
        await workflow.createBranch(wsId, branch, kb.defaultBranch);
      } catch (err) {
        if (!(await branchExists())) throw err;
      }
    }

    const rulesPath = rulesFileFor(target);
    const wsRulesPath = `${kb.kbDirName}/${rulesPath}`;
    // The proposal is spliced onto the LIVE copy, never onto whatever the
    // branch holds. Belt and braces with the recut above: a branch that could
    // not be recut still carries a declined proposal, and splicing onto it
    // would ask for two levels at once. Starting from live means the request
    // proposes exactly what was chosen this time.
    const live = await this.readLive(target, wsRulesPath);
    const spliced = spliceGrant(
      live,
      level,
      { kind: 'user', email: user.email, displayName: user.name },
      { allowScalar: target.kind === 'file', target: target.kind === 'folder' ? 'folder' : 'node' },
    );

    const ws = await workspaceService.getOrCreateForBranch(branch);
    const onBranch = await workspaceService
      .readFile(ws.id, wsRulesPath)
      .catch((err: unknown) => {
        if (!isAbsence(err)) throw err;
        return null;
      });
    if (onBranch !== spliced.text) {
      await workspaceService.writeFile(ws.id, wsRulesPath, spliced.text);
      await workflow.commitChanges(
        ws.id,
        user,
        `Request ${LEVEL_LABEL[level].toLowerCase()} access to ${itemName}`,
      );
    }

    try {
      const detail = await workflow.openChangeRequest(ws.id, user, {
        sourceBranch: branch,
        targetBranch: kb.defaultBranch,
        title: `Access request: ${itemName}`,
        description: this.describe({ user, target, level, note }),
      });
      return { number: detail.number, level };
    } catch (err) {
      // Two sends that raced past the listing above meet here, at the partial
      // unique index on open (source, target). The loser answers with the
      // winner's request rather than an error: the person asked once, and one
      // request is what they get.
      if (err instanceof DuplicateChangeRequestError) {
        return { number: err.existingNumber, level: await this.levelOf(err.existingNumber) };
      }
      // The branch is recut from live above precisely so this cannot happen;
      // reaching it means something raced. Whatever the cause, the person
      // asking cannot act on "resolve the conflicts on
      // reader2/join-artest3-04i7dr4" — they have never heard of that branch
      // and could not reach it if they had. Say the one thing that IS theirs
      // to do, and keep the detail where an operator will find it.
      if (err instanceof ChangeRequestConflictsError) {
        log.warn(
          `request branch "${branch}" conflicted with live after being recut: ${err.message}`,
        );
        throw new AccessMutationError(
          'The rules changed while your request was being sent. Try again.',
          409,
          { kind: 'request-raced' },
        );
      }
      throw err;
    }
  }

  /**
   * What `user`'s dialog should say about `target`.
   *
   * The two states are answered from DIFFERENT sources, because different
   * things prove them:
   *
   *   pending       an open request on this branch. That is the whole proof,
   *                 and the level comes off the request itself — asking the
   *                 branch would make "Requested: …" depend on whether this
   *                 clone has fetched a ref that may be seconds old.
   *   not-accepted  a closed request AND a branch that still carries an unmet
   *                 proposal naming this person. A settled request has no
   *                 branch left, so an accepted one can never read as
   *                 declined; a branch that cannot be read proves nothing and
   *                 reads as `none`, which shows the control rather than
   *                 claiming a refusal nobody made.
   */
  async status(user: AuthUser, target: AccessRequestTarget): Promise<AccessRequestStatus> {
    const { workflow } = this.deps;
    const branch = this.branchFor(user.email, target);

    const open = (await workflow.listChangeRequests({ fresh: true })).find(
      (cr) => cr.state === 'open' && cr.branch === branch,
    );
    if (open) {
      return { state: 'pending', level: await this.levelOf(open.number), number: open.number };
    }

    const level = await this.levelAskedOn(branch, target, user.email);
    if (!level) return { state: 'none' };
    const last = await workflow.latestClosedChangeRequest(user.email, branch);
    return last ? { state: 'not-accepted', level, number: last.number } : { state: 'none' };
  }

  /**
   * The level change request `number` asks for, off its own description.
   *
   * `write` when the description does not say: every request that predates the
   * marker came from the skill page's "Request write access", which asks for
   * exactly that. A detail that cannot be fetched falls there too — the line
   * it feeds says which level was asked for, and Can edit is the lesser claim.
   */
  private async levelOf(number: number): Promise<RequestLevel> {
    const detail = await this.deps.workflow
      .getChangeRequestDetail(number, { patches: false })
      .catch(() => null);
    return extractRequestLevel(detail?.body) ?? 'write';
  }

  /**
   * The level `email`'s branch still asks for on `target`, or null when it
   * asks for nothing they do not already hold. Owner wins when a branch
   * somehow carries both — it is the larger of the two, and it is the one the
   * person is still waiting on.
   */
  private async levelAskedOn(
    branch: string,
    target: AccessRequestTarget,
    email: string,
  ): Promise<RequestLevel | null> {
    const needle = email.trim().toLowerCase();
    // null ⇒ the branch could not be read at all, which is not "asks for
    // nothing". Saying nothing is outstanding shows the control, which is
    // recoverable; claiming a refusal would not be.
    const proposals = await this.deps.lifecycle.proposalsOn(branch, target);
    if (proposals === null) return null;
    const mine = proposals.filter(
      (p) => p.principal.kind === 'user' && p.principal.email.trim().toLowerCase() === needle,
    );
    if (mine.some((p) => p.verb === 'owner')) return 'owner';
    return mine.some((p) => p.verb === 'write') ? 'write' : null;
  }

  /**
   * The live rules text to splice onto. A folder with no `access.md` yet is
   * normal and reads as empty; a FILE that is not there is not — a request
   * must not conjure the file it asks about.
   */
  private async readLive(target: AccessRequestTarget, wsRulesPath: string): Promise<string> {
    const { workspaceService, kb } = this.deps;
    await workspaceService.getOrCreateForBranch(kb.defaultBranch);
    try {
      return await workspaceService.readFile(kb.defaultWorkspaceId(), wsRulesPath);
    } catch (err) {
      if (target.kind === 'folder' && isAbsence(err)) return '';
      if (isAbsence(err)) {
        throw new AccessMutationError(`"${target.path}" is not there any more.`, 404, {
          kind: 'unknown-target',
        });
      }
      throw err;
    }
  }

  /** The description an editor reads: who, what, where, the note, and how to answer. */
  private describe(input: {
    user: AuthUser;
    target: AccessRequestTarget;
    level: RequestLevel;
    note: string;
  }): string {
    const { user, target, level, note } = input;
    const who = escapeMarkdown(user.name || user.email);
    const lines = [
      `<!--hexis:access-request-level:${level}-->`,
      `${who} (${escapeMarkdown(user.email)}) asked for **${LEVEL_LABEL[level]}** on ` +
        `${escapeMarkdown(target.path || 'the workspace')}.`,
    ];
    if (note) {
      lines.push('', `Note from ${who}:`, '', NOTE_OPEN);
      for (const line of note.split(/\r?\n/)) lines.push(`> ${escapeMarkdown(line)}`);
      lines.push(NOTE_CLOSE);
    }
    lines.push(
      '',
      `Anyone who can edit this ${target.kind}'s access answers it: Accept in the ` +
        `${target.kind}'s Manage access dialog, or approve and merge this request. It closes ` +
        `itself once ${who} holds that access, however it was given.`,
    );
    return lines.join('\n');
  }
}
