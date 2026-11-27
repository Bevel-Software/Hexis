import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import type { Database } from '../../database/index.js';
import { assertValidBranchName } from '../../kb-fs/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlService } from '../version-control.service.js';

/**
 * `draftNameFor`: the name `create_branch` creates a draft under. The service
 * is built with only the git rule it consults standing in, so the test pins
 * the naming decision through the method `create_branch` calls.
 */
function draftNameFor(mayDelete: boolean | 'unreadable', name: string, user: AuthUser): Promise<string> {
  const git = {
    mayDeleteBranch: async () => {
      if (mayDelete === 'unreadable') throw new Error('roles.yaml could not be read');
      return mayDelete;
    },
  } as unknown as GitService;
  const svc = new VersionControlService(
    {} as unknown as Database,
    git,
    {} as PullRequestService,
    {} as IChangeRequestReviewService,
    {} as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    {} as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
  );
  return svc.draftNameFor('ws', name, user);
}

const visitor: AuthUser = { id: 'u1', email: 'demo@example.com', name: 'Demo' };
const dotted: AuthUser = { id: 'u2', email: 'Jane.Doe@example.com', name: 'Jane' };
const noLocalpart: AuthUser = { id: 'abcdef123456', email: '---@example.com', name: 'Dashes' };
const leadingUnderscore: AuthUser = { id: 'abcdef123456', email: '_ops@example.com', name: 'Ops' };

describe('draftNameFor', () => {
  it("puts the caller's prefix on a bare name they could not delete once made", async () => {
    expect(await draftNameFor(false, 'copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'fix-typo', dotted)).toBe('jane-doe/fix-typo');
  });

  it('gives an address with no usable localpart its suggestions prefix, which is still theirs to delete', async () => {
    expect(await draftNameFor(false, 'fix-typo', noLocalpart)).toBe('suggestions/user-abcdef12/fix-typo');
  });

  it('never answers a name that cannot be created: a localpart that would start the name with a dash gets the suggestions prefix', async () => {
    // `_ops@…` sanitizes to `-ops`, and `-ops/fix-typo` is refused as a branch
    // name, so the bare name that was creatable would stop being so.
    const name = await draftNameFor(false, 'fix-typo', leadingUnderscore);
    expect(name).toBe('suggestions/_ops-abcdef12/fix-typo');
    expect(() => assertValidBranchName(name)).not.toThrow();
  });

  it('treats a delete rule that cannot be read as a no, and adds the prefix', async () => {
    expect(await draftNameFor('unreadable', 'copilot-check', visitor)).toBe('demo/copilot-check');
  });

  it('keeps a bare name the caller may delete anyway (an admin)', async () => {
    expect(await draftNameFor(true, 'release-notes', visitor)).toBe('release-notes');
  });

  it('keeps a protected name as asked, so creating it is refused rather than prefixed', async () => {
    expect(await draftNameFor(false, 'target-company-state', visitor)).toBe('target-company-state');
  });

  it('keeps every name that already has a prefix, theirs or another', async () => {
    expect(await draftNameFor(false, 'demo/copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'suggestions/abc', visitor)).toBe('suggestions/abc');
    expect(await draftNameFor(false, 'agent/fix-123', visitor)).toBe('agent/fix-123');
  });
});
