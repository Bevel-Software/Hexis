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

function makeHarness(branchMd: string, holds: Partial<Record<'canRead' | 'canWrite' | 'canOwner' | 'canDownload', boolean>> = {}) {
  const byRef: Record<string, string> = {
    [`origin/${DEFAULT_BRANCH}`]: DEFAULT_MD,
    [`origin/${BRANCH}`]: branchMd,
  };
  const workspaceService = {
    ensureRemotesFetched: vi.fn(async () => undefined),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, p: string) =>
      p === ACCESS_MD ? (byRef[ref] ?? null) : null,
    ),
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
