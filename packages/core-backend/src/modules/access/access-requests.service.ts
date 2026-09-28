import path from 'node:path';
import {
  joinBranchFor,
  type AuthUser,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { DuplicateChangeRequestError } from '../../shared/domain-errors.js';
import { isAbsence } from '../../shared/fs.contract.js';
import type { KbContext } from '../../shared/kb-context.js';
import { spliceGrant } from '../access-model/access-splice.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { AccessMutationError } from './access-mutation.service.js';
import {
  rulesFileFor,
  type AccessRequestTarget,
  type IAccessRequestLifecycle,
  type RequestLevel,
} from './access-requests.contract.js';

/** How the dialog spells each level — the same words the request is answered in. */
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
 * The requester's own words, back out of a request's description, or
 * undefined when they wrote none. Unescaped exactly as they were escaped, so
 * what the banner shows is what was typed.
 */
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

    // FRESH: a repeated click must find the request the previous one opened,
    // and the cached listing can trail it — a miss here would send the retry
    // into a duplicate.
    const existing = (
      await workflow.listChangeRequestsAuthoredBy(user.email, { fresh: true })
    ).find((cr) => cr.state === 'open' && cr.branch === branch);
    if (existing) return { number: existing.number, level };

    // The branch may already exist (a request listed as closed, a retry after
    // a failed open). Existence is PROBED, before and — if creation fails —
    // after: the race shows up as "already exists" locally or as a rejected
    // push when origin got there first, and a message is not a contract. A
    // branch that is there is proceeded against; anything else is a real
    // failure, and a proposal on a branch that was not made would be worse
    // than the error. STRICT: the list proves absence, and a listing that
    // could not fetch proves nothing.
    const branchExists = async () =>
      (await workflow.listBranches(wsId, { freshFetch: true, strictFetch: true })).some(
        (b) => b.name === branch,
      );
    if (!(await branchExists())) {
      try {
        await workflow.createBranch(wsId, branch, kb.defaultBranch);
      } catch (err) {
        if (!(await branchExists())) throw err;
      }
    }

    const rulesPath = rulesFileFor(target);
    const wsRulesPath = `${kb.kbDirName}/${rulesPath}`;
    // The proposal is spliced onto the LIVE copy, not onto whatever the branch
    // happens to hold. A branch survives a decline (that is how the dialog
    // knows to say "wasn't accepted"), so a second request splicing onto the
    // branch would carry the declined level along and ask for two at once.
    // Starting from live means a new request proposes exactly what was chosen
    // this time, and drops anything the live rules have since gained.
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
        return { number: err.existingNumber, level };
      }
      throw err;
    }
  }

  /**
   * What `user`'s dialog should say about `target`, read from the request's
   * branch rather than from any stored status.
   *
   * `pending` and `not-accepted` are the same reading told apart by one fact:
   * whether the request is still open. Both need the branch to still carry an
   * unmet proposal naming this person — which is exactly what a settled
   * request no longer has (its branch is deleted), so an accepted request can
   * never read as declined, and a person who got the access another way sees
   * nothing outstanding.
   */
  async status(user: AuthUser, target: AccessRequestTarget): Promise<AccessRequestStatus> {
    const { workflow } = this.deps;
    const branch = this.branchFor(user.email, target);
    const level = await this.levelAskedOn(branch, target, user.email);

    const open = (
      await workflow.listChangeRequestsAuthoredBy(user.email, { fresh: true })
    ).find((cr) => cr.state === 'open' && cr.branch === branch);
    if (open) {
      return level ? { state: 'pending', level, number: open.number } : { state: 'none' };
    }

    if (!level) return { state: 'none' };
    const last = await workflow.latestClosedChangeRequest(user.email, branch);
    return last ? { state: 'not-accepted', level, number: last.number } : { state: 'none' };
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
    const proposals = await this.deps.lifecycle.proposalsOn(branch, target);
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
