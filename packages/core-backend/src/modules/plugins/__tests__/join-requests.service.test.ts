import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_BRANCH,
  joinBranchFor,
  type AuthUser,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import {
  workspaceIdForBranch,
  type WorkspaceService,
} from '../../workspace/workspace.service.js';
import { JoinRequestsService } from '../join-requests.service.js';

/**
 * The derived lifecycle: a join request is open exactly while its branch's
 * `access.md` grants something the default branch's does not, and settling it
 * is what happens when that stops being true — nothing stores a status.
 */
const ALI = 'ali@bevel.software';
const FOLDER = 'Plugins/GTM';
const ACCESS_MD = `${FOLDER}/access.md`;
const ACTOR: AuthUser = { id: 'u-1', email: 'olga@bevel.software', name: 'Olga Ivanova' };

const base = (body: string) => `---\nread:\n  - everyone\n---\n${body}`;
const DEFAULT_MD = base('read:\n  - GTM Team\n');
const PROPOSING_MD = base('read:\n  - GTM Team\n  - Ali Baba <ali@bevel.software>\n');

function cr(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 7,
    title: 'Join request: GTM',
    author: { login: 'user-abc' },
    authorId: 'hash-ali',
    appAuthor: { name: 'Ali Baba' },
    branch: joinBranchFor(ALI, 'GTM'),
    base: DEFAULT_BRANCH,
    state: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    touchedNodePaths: [ACCESS_MD],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  } as ChangeRequest;
}

/** `byRef[ref]` is the access.md content at that ref (undefined ⇒ absent). */
function makeHarness(byRef: Record<string, string>) {
  const workspaceService = {
    ensureRemotesFetched: vi.fn(async () => undefined),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, path: string) =>
      path === ACCESS_MD ? (byRef[ref] ?? null) : null,
    ),
  } as unknown as WorkspaceService;
  const workflow = {
    rejectChangeRequest: vi.fn(async () => ({ number: 7, state: 'closed' })),
    deleteBranch: vi.fn(async () => undefined),
  } as unknown as IWorkflowService;
  return { svc: new JoinRequestsService(workspaceService, workflow), workflow, workspaceService };
}

const refs = (branchMd: string | undefined, defaultMd = DEFAULT_MD) => ({
  [`origin/${DEFAULT_BRANCH}`]: defaultMd,
  ...(branchMd === undefined ? {} : { [`origin/${joinBranchFor(ALI, 'GTM')}`]: branchMd }),
});

describe('JoinRequestsService.list', () => {
  it('reports a request with its pending proposals, and leaves it open', async () => {
    const h = makeHarness(refs(PROPOSING_MD));
    const out = await h.svc.list('GTM', FOLDER, [cr()], ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ number: 7, requesterName: 'Ali Baba' });
    expect(out[0].proposals.map((p) => p.label)).toEqual(['Ali Baba']);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('SETTLES a request whose proposals have all landed: closes it, deletes the branch, omits it', async () => {
    // The grant is on the default branch now, so the branch adds nothing.
    const h = makeHarness(refs(PROPOSING_MD, PROPOSING_MD));
    const out = await h.svc.list('GTM', FOLDER, [cr()], ACTOR);
    expect(out).toEqual([]);
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalledWith(
      7,
      ACTOR,
      'open',
      'hash-ali',
      DEFAULT_BRANCH,
      // The WORKSPACE id, which merely happens to equal the branch name for
      // slash-less branches — assert the encoding so a slashed default
      // branch could never silently break this.
      workspaceIdForBranch(DEFAULT_BRANCH),
    );
    expect(h.workflow.deleteBranch).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT_BRANCH),
      joinBranchFor(ALI, 'GTM'),
      ACTOR,
    );
  });

  it('ignores change requests that are closed or not on a join branch', async () => {
    const h = makeHarness(refs(PROPOSING_MD));
    const out = await h.svc.list(
      'GTM',
      FOLDER,
      [cr({ state: 'closed' }), cr({ number: 9, branch: 'ali/some-draft' })],
      ACTOR,
    );
    expect(out).toEqual([]);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('keeps listing when closing one request fails', async () => {
    const h = makeHarness(refs(PROPOSING_MD, PROPOSING_MD));
    (h.workflow.rejectChangeRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('gh down'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(h.svc.list('GTM', FOLDER, [cr()], ACTOR)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still closes the request when the branch delete fails, and says so', async () => {
    const h = makeHarness(refs(PROPOSING_MD, PROPOSING_MD));
    (h.workflow.deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('protected'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The request still settles (omitted from the list) — the leftover branch
    // is cosmetic, and the failure is logged rather than swallowed.
    await expect(h.svc.list('GTM', FOLDER, [cr()], ACTOR)).resolves.toEqual([]);
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not delete'));
    warn.mockRestore();
  });

  it('NEVER settles a slug-colliding other plugin\'s request (branch match is exact)', async () => {
    // `Finance!` slugs to `finance` too. Its branch's copy of
    // `Plugins/finance/access.md` is unchanged, so if the branch matched, the
    // empty diff would settle — closing a change request and deleting a
    // branch that belong to a DIFFERENT plugin. The plugin tag in the branch
    // name is what forbids the match.
    const other = cr({ branch: joinBranchFor(ALI, 'Finance!') });
    const h = makeHarness({
      [`origin/${DEFAULT_BRANCH}`]: DEFAULT_MD,
      [`origin/${joinBranchFor(ALI, 'Finance!')}`]: DEFAULT_MD,
    });
    await expect(h.svc.list('finance', 'Plugins/finance', [other], ACTOR)).resolves.toEqual([]);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
    expect(h.workflow.deleteBranch).not.toHaveBeenCalled();
    await expect(h.svc.reconcile('finance', 'Plugins/finance', other, ACTOR)).resolves.toBe(false);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });
});

describe('JoinRequestsService.reconcile', () => {
  it('settles and reports true once nothing is pending', async () => {
    const h = makeHarness(refs(PROPOSING_MD, PROPOSING_MD));
    await expect(h.svc.reconcile('GTM', FOLDER, cr(), ACTOR)).resolves.toBe(true);
    expect(h.workflow.rejectChangeRequest).toHaveBeenCalled();
    expect(h.workflow.deleteBranch).toHaveBeenCalled();
  });

  it('leaves a request alone while proposals remain', async () => {
    const h = makeHarness(refs(PROPOSING_MD));
    await expect(h.svc.reconcile('GTM', FOLDER, cr(), ACTOR)).resolves.toBe(false);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });

  it('refuses a change request that is not this plugin\'s join branch', async () => {
    const h = makeHarness(refs(PROPOSING_MD, PROPOSING_MD));
    await expect(
      h.svc.reconcile('GTM', FOLDER, cr({ branch: 'ali/some-draft' }), ACTOR),
    ).resolves.toBe(false);
    expect(h.workflow.rejectChangeRequest).not.toHaveBeenCalled();
  });
});
