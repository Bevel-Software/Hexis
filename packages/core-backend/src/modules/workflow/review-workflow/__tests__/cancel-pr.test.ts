import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { ReviewWorkflowService } from '../review-workflow.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../../git/git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { hashEmail } from '../../../../shared/hash-email.js';
import { WorkflowValidationError } from '../../workflow.errors.js';

// Cancel is now a DB state flip (no `gh`): `update(change_requests) … WHERE
// number = ? AND state = 'open'`. This spy stands in for the update's
// `.returning()` — a non-empty array means the row was open and got closed.
const updateReturning = vi.fn(async () => [{ id: 'cr-1' }] as { id: string }[]);
// The re-read used only when the update matched zero rows (a race). Default to
// a merged row so that path yields already-applied.
const reReadState = { current: 'merged' as 'merged' | 'closed' };

function makeDb(): Database {
  return {
    update: () => ({ set: () => ({ where: () => ({ returning: updateReturning }) }) }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ state: reReadState.current }] }) }),
    }),
  } as unknown as Database;
}

const USER: AuthUser = { id: 'u1', email: 'juan@bevel.software', name: 'Juan' };
const OTHER_AUTHOR_HASH = hashEmail('someone-else@bevel.software');

function makeAccessControl(adminEmails: string[] = []): IAccessControl {
  const set = new Set(adminEmails.map((e) => e.toLowerCase()));
  return {
    canWrite: async () => false,
    canWriteBatch: async () => new Map(),
    canRead: async () => true,
    canReadBatch: async () => new Map(),
    eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    canReadAtRef: async () => null,
    canDownload: async () => false,
    canOwner: async () => false,
    eligibleOwners: async () => ({ roles: [], users: [] }),
    eligibleDownloaders: async () => ({ roles: [], users: [] }),
    eligibleWriters: async () => ({ roles: [], users: [] }),
    eligibleWriterEmails: async () => new Map(),
    eligibleOwnerEmails: async () => new Map(),
    grantSources: async () => ({}),
    invalidate: () => {},
    canWriteAtRef: async (_ws, _ref, email) => {
      return set.has(email.trim().toLowerCase());
    },
    canWriteBatchAtRef: async () => null,
    eligibleWritersAtRef: async () => null,
    eligibleWritersForPathsAtRef: async () => null,
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ plugins: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
  };
}

function makeService(accessControl: IAccessControl): ReviewWorkflowService {
  // `ensureRemotesFetched` is best-effort (catches errors); the DB stub above
  // stands in for the state-flip update + the race re-read.
  const workspace = { ensureRemotesFetched: async () => undefined } as unknown as WorkspaceService;
  return new ReviewWorkflowService(makeDb(), accessControl, workspace, {} as unknown as GitService);
}

describe('ReviewWorkflowService.cancelPr', () => {
  beforeEach(() => {
    updateReturning.mockClear();
    updateReturning.mockResolvedValue([{ id: 'cr-1' }]);
    reReadState.current = 'merged';
  });

  it('lets the PR author cancel (admin check skipped)', async () => {
    const svc = makeService(makeAccessControl([]));
    const result = await svc.cancelPr(
      42, USER, 'open', hashEmail(USER.email), 'current-company-state', 'ws-1',
    );
    expect(result.prNumber).toBe(42);
    expect(typeof result.cancelledAt).toBe('string');
    expect(new Date(result.cancelledAt).toString()).not.toBe('Invalid Date');
    // The row was flipped via the guarded update (state='open' precondition).
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it('lets a base-branch admin cancel someone else’s PR', async () => {
    const svc = makeService(makeAccessControl([USER.email]));
    const result = await svc.cancelPr(
      7, USER, 'open', OTHER_AUTHOR_HASH, 'current-company-state', 'ws-1',
    );
    expect(result.prNumber).toBe(7);
  });

  it('refuses when caller is neither author nor admin (403)', async () => {
    const svc = makeService(makeAccessControl([])); // no admins
    await expect(
      svc.cancelPr(7, USER, 'open', OTHER_AUTHOR_HASH, 'current-company-state', 'ws-1'),
    ).rejects.toMatchObject({
      name: 'CancelAuthError',
      status: 403,
      // Names the FULL authorization set — the facade's owner grant
      // (write on every changed file) included, so the refusal never
      // undersells who could actually do this.
      message: expect.stringMatching(/author, an admin, or having edit access to every file/i),
    });
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('refuses a merged PR with 422 already-applied — no state change', async () => {
    const svc = makeService(makeAccessControl([USER.email]));
    await expect(
      svc.cancelPr(7, USER, 'merged', hashEmail(USER.email), 'current-company-state', 'ws-1'),
    ).rejects.toMatchObject({
      name: 'CancelStateError',
      status: 422,
      message: 'This change request was already applied.',
    });
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('refuses an already-closed PR with 422 already-cancelled', async () => {
    const svc = makeService(makeAccessControl([USER.email]));
    await expect(
      svc.cancelPr(7, USER, 'closed', hashEmail(USER.email), 'current-company-state', 'ws-1'),
    ).rejects.toMatchObject({
      name: 'CancelStateError',
      status: 422,
      message: 'This change request is already cancelled.',
    });
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('maps a lost race (update matched 0 rows, row now merged) to already-applied', async () => {
    updateReturning.mockResolvedValue([]); // the guarded update caught nothing
    reReadState.current = 'merged';
    const svc = makeService(makeAccessControl([USER.email]));
    await expect(
      svc.cancelPr(42, USER, 'open', hashEmail(USER.email), 'current-company-state', 'ws-1'),
    ).rejects.toMatchObject({ name: 'CancelStateError', message: 'This change request was already applied.' });
  });

  it('rejects invalid PR numbers', async () => {
    const svc = makeService(makeAccessControl([USER.email]));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        svc.cancelPr(bad, USER, 'open', null, 'current-company-state', 'ws-1'),
      ).rejects.toBeInstanceOf(WorkflowValidationError);
    }
  });

  it('rejects empty workspaceId / baseBranch', async () => {
    const svc = makeService(makeAccessControl([USER.email]));
    await expect(
      svc.cancelPr(42, USER, 'open', null, '', 'ws-1'),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    await expect(
      svc.cancelPr(42, USER, 'open', null, 'current-company-state', ''),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('skips the admin lookup when the author check matches', async () => {
    // canWriteAtRef would throw — if the service calls it for a matching author,
    // the test fails. Guards against an authz-check ordering regression.
    const throwingAccess: IAccessControl = {
      ...makeAccessControl([]),
      canWriteAtRef: async () => {
        throw new Error('admin check should not run for matching author');
      },
    };
    const svc = makeService(throwingAccess);
    await expect(
      svc.cancelPr(
        42, USER, 'open', hashEmail(USER.email), 'current-company-state', 'ws-1',
      ),
    ).resolves.toMatchObject({ prNumber: 42 });
  });
});
