import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { type WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { folderTarget } from '../../access/access-requests.contract.js';
import { JoinRequestsService } from '../join-requests.service.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * A request ends when the person it names HOLDS what it asked for — however
 * they came to hold it.
 *
 * The file diff alone cannot see that. Owner covers Can edit without putting
 * a `write:` line anywhere; a role or a group carries access without naming
 * anybody; a grant on a parent folder never touches this file at all. Each of
 * those leaves the branch proposing something no editor can usefully accept,
 * and the request sits open forever. These are the cases that asking the
 * resolver instead settles — including for the two Library request kinds,
 * which go through exactly this service.
 */
const ALI = 'ali@bevel.software';
const FOLDER = 'Plugins/GTM';
const ACCESS_MD = `${FOLDER}/access.md`;
const ACTOR: AuthUser = { id: 'u-1', email: 'olga@bevel.software', name: 'Olga Ivanova' };
const BRANCH = joinBranchFor(ALI, 'GTM');

const base = (body: string) => `---\nread:\n  - everyone\n---\n${body}`;
const DEFAULT_MD = base('read:\n  - GTM Team\n');
const ASKS_WRITE = base(`read:\n  - GTM Team\nwrite:\n  - Ali Baba <${ALI}>\n`);
const ASKS_FOR_A_ROLE = base('read:\n  - GTM Team\n  - role/Analysts\n');

function cr(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 7,
    title: 'Access request: GTM',
    author: { login: 'user-abc' },
    authorId: 'hash-ali',
    appAuthor: { name: 'Ali Baba' },
    branch: BRANCH,
    base: DEFAULT_BRANCH,
    state: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    touchedNodePaths: [ACCESS_MD],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  } as ChangeRequest;
}

function makeHarness(
  branchMd: string | undefined,
  holds: Partial<Record<'canRead' | 'canWrite' | 'canOwner' | 'canDownload', boolean>> = {},
  /** Refs that only appear once a FORCED fetch has run — a branch just pushed. */
  arrivesOnForcedFetch: string | undefined = undefined,
  liveMd: string = DEFAULT_MD,
) {
  const byRef: Record<string, string> = {
    [`origin/${DEFAULT_BRANCH}`]: liveMd,
    ...(branchMd === undefined ? {} : { [`origin/${BRANCH}`]: branchMd }),
  };
  const fetches: { force: boolean }[] = [];
  const workspaceService = {
    ensureRemotesFetched: vi.fn(async (_ws: string, opts: { force?: boolean } = {}) => {
      fetches.push({ force: !!opts.force });
      if (opts.force && arrivesOnForcedFetch !== undefined) {
        byRef[`origin/${BRANCH}`] = arrivesOnForcedFetch;
      }
    }),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, p: string) => {
      if (p !== ACCESS_MD) return null;
      const text = byRef[ref];
      // A ref this clone has not heard of is not an empty file — it throws,
      // exactly as `git show` does for an unknown ref.
      if (text === undefined) throw new Error(`unknown revision ${ref}`);
      return text;
    }),
  } as unknown as WorkspaceService;
  const workflow = {
    rejectChangeRequest: vi.fn(async () => ({ number: 7, state: 'closed' })),
    deleteBranch: vi.fn(async () => undefined),
  } as unknown as IWorkflowService;
  const asked: { verb: string; path: string; email: string }[] = [];
  const answer = (verb: 'canRead' | 'canWrite' | 'canOwner' | 'canDownload') =>
    vi.fn(async (_ws: string, email: string, path: string) => {
      asked.push({ verb, path, email });
      return holds[verb] ?? false;
    });
  const accessControl = {
    canRead: answer('canRead'),
    canWrite: answer('canWrite'),
    canOwner: answer('canOwner'),
    canDownload: answer('canDownload'),
  } as unknown as IAccessControl;
  return {
    svc: new JoinRequestsService(workspaceService, workflow, testKbContext(), accessControl),
    workflow,
    asked,
    fetches,
  };
}

describe('a request settles once the person holds what it asked for', () => {
  it('settles a write request when Owner already covers it', async () => {
    // `canWrite` is the resolver's own question, and owner folds into write —
    // so an owner grant made in the dialog retires the Can edit request.
    const h = makeHarness(ASKS_WRITE, { canWrite: true });
    await expect(h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR)).resolves.toEqual([]);
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalled();
    expect(h.workflow.deleteBranch).toHaveBeenCalledWith(expect.anything(), BRANCH, ACTOR);
  });

  it('asks about the ITEM, not its rules file — a folder request is about the folder', async () => {
    const h = makeHarness(ASKS_WRITE, { canWrite: true });
    await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(h.asked).toContainEqual({ verb: 'canWrite', path: FOLDER, email: ALI });
  });

  it('settles through a role or group the person has since joined', async () => {
    // Nothing in the file names Ali, yet the resolver says he writes here:
    // that is a role, a group, or a grant on a parent folder.
    const h = makeHarness(ASKS_WRITE, { canWrite: true });
    await expect(h.svc.reconcile('GTM', folderTarget(FOLDER), cr(), ACTOR)).resolves.toBe(true);
  });

  it('leaves the request open while the person still holds nothing', async () => {
    const h = makeHarness(ASKS_WRITE);
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].proposals.map((p) => p.verb)).toEqual(['write']);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('keeps today\'s literal rule for a proposal naming a ROLE', async () => {
    // "Does this role hold read here" is not a question the per-person
    // resolver answers, so a role proposal is settled by the live rules
    // carrying it — never by what some person happens to hold.
    const h = makeHarness(ASKS_FOR_A_ROLE, { canRead: true, canWrite: true, canOwner: true });
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].proposals.map((p) => p.label)).toEqual(['role/Analysts']);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('leaves the request open when the resolver cannot answer', async () => {
    const h = makeHarness(ASKS_WRITE);
    const svc = h.svc as unknown as { accessControl: { canWrite: () => Promise<boolean> } };
    svc.accessControl.canWrite = () => Promise.reject(new Error('resolver down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(out).toHaveLength(1);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a branch that cannot be read settles nothing', () => {
  /**
   * The failure this guards against, in full: these reads go through
   * `origin/<branch>` in the DEFAULT branch's clone, and that clone's fetch is
   * throttled. A request opened seconds ago names a ref the clone has not
   * heard of. Read as "the branch proposes nothing" — which is what an empty
   * diff against a missing file looks like — the request is CLOSED, by
   * nobody, before any editor has seen it, and the person is told their
   * request was not accepted.
   *
   * So: a miss is retried behind a forced fetch, and a miss that survives that
   * leaves the request exactly where it was.
   */

  it('retries behind a FORCED fetch before believing a branch says nothing', async () => {
    // Present on origin, absent from this clone's refs until it fetches.
    const h = makeHarness(undefined, {}, ASKS_WRITE);
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);

    expect(h.fetches.some((f) => f.force)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].proposals.map((p) => p.verb)).toEqual(['write']);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('leaves the request open — and unclosed — when the branch still cannot be read', async () => {
    const h = makeHarness(undefined);
    await expect(h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR)).resolves.toEqual([]);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
    expect(h.workflow.deleteBranch).not.toHaveBeenCalled();
  });

  it('reconcile refuses to settle one it could not read', async () => {
    const h = makeHarness(undefined);
    await expect(h.svc.reconcile('GTM', folderTarget(FOLDER), cr(), ACTOR)).resolves.toBe(false);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('still settles a branch it DID read that proposes nothing', async () => {
    // The distinction has to cut both ways, or nothing would ever retire.
    const h = makeHarness(DEFAULT_MD);
    await expect(h.svc.reconcile('GTM', folderTarget(FOLDER), cr(), ACTOR)).resolves.toBe(true);
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalled();
  });
});

describe('a person the rules explicitly deny', () => {
  /**
   * `ARTest5`-shaped rules: read granted, write DENIED, and the branch
   * proposing the write anyway. The resolver says that person cannot write
   * (verified against the real one), so their proposal is unmet and must
   * survive to reach an editor — "Accept … includes a person the rules
   * explicitly deny" is unreachable otherwise, and the requester is told a
   * refusal nobody made.
   */
  const DENIED_MD = base(`read:\n  - Ali Baba <${ALI}>\nwrite:\n  - deny Ali Baba <${ALI}>\n`);
  const ASKS_DESPITE_DENY = base(
    `read:\n  - Ali Baba <${ALI}>\nwrite:\n  - deny Ali Baba <${ALI}>\n  - Ali Baba <${ALI}>\n`,
  );

  it('keeps their proposal, so an editor can still accept it', async () => {
    // Live DENIES the write; the branch adds the grant beside the deny, which
    // is exactly the text the dialog's own grant writes for this person.
    const h = makeHarness(ASKS_DESPITE_DENY, { canRead: true, canWrite: false }, undefined, DENIED_MD);
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0].proposals.map((p) => p.verb)).toEqual(['write']);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('retires it once the grant has landed and the resolver says they write', async () => {
    // What Accept does: a same-scope grant beats a same-scope deny, so the
    // resolver then reports write and the request has nothing left to ask.
    const h = makeHarness(ASKS_DESPITE_DENY, { canWrite: true }, undefined, DENIED_MD);
    await expect(h.svc.reconcile('GTM', folderTarget(FOLDER), cr(), ACTOR)).resolves.toBe(true);
  });
});

describe('a stale ref must not be mistaken for a finished request', () => {
  /**
   * The nastier half of the same hazard. Here the branch's ref RESOLVES — it
   * is simply a few seconds behind, pointing at the commit before the
   * proposal was pushed. That reads as a file identical to live, which is an
   * empty diff, which looks exactly like a request whose grants have all
   * landed. Nothing about it looks like a failure, and the request is closed.
   */

  /** Stale: the branch answers with live's own text until a forced fetch. */
  const staleHarness = () => makeHarness(DEFAULT_MD, {}, ASKS_WRITE);

  it('does not settle a request whose proposal only shows after a fresh fetch', async () => {
    const h = staleHarness();
    const out = await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);

    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
    expect(h.workflow.deleteBranch).not.toHaveBeenCalled();
    // And having fetched, it reports the proposal rather than nothing.
    expect(out).toHaveLength(1);
    expect(out[0].proposals.map((p) => p.verb)).toEqual(['write']);
  });

  it('reconcile refuses to settle it either', async () => {
    const h = staleHarness();
    await expect(h.svc.reconcile('GTM', folderTarget(FOLDER), cr(), ACTOR)).resolves.toBe(false);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('confirms with a FORCED fetch before closing anything', async () => {
    const h = makeHarness(DEFAULT_MD);
    await h.svc.list('GTM', folderTarget(FOLDER), [cr()], ACTOR);
    expect(h.fetches.some((f) => f.force)).toBe(true);
    // Genuinely finished — the confirming read agrees, so it closes.
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalled();
  });
});
