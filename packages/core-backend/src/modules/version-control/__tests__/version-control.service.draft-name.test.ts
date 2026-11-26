import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { VersionControlService } from '../version-control.service.js';

/**
 * `draftNameFor`: the name `create_branch` creates a draft under. Called on a
 * stand-in holding only what it consults (the git rule, the protected list and
 * the service's own author-or-Admin helper), so the test pins the naming
 * decision and nothing of the service's wiring.
 */
function draftNameFor(mayDelete: boolean | 'unreadable', name: string, user: AuthUser): Promise<string> {
  const self = {
    git: {
      mayDeleteBranch: async () => {
        if (mayDelete === 'unreadable') throw new Error('roles.yaml could not be read');
        return mayDelete;
      },
    },
    kb: { isProtectedBranch: (branch: string) => branch === 'main' },
    mayDelete: VersionControlService.prototype['mayDelete'],
  };
  return VersionControlService.prototype.draftNameFor.call(self as never, 'ws', name, user);
}

const visitor: AuthUser = { id: 'u1', email: 'demo@example.com', name: 'Demo' };
const dotted: AuthUser = { id: 'u2', email: 'Paul.Brandt@bevel.software', name: 'Paul' };
const noLocalpart: AuthUser = { id: 'abcdef123456', email: '---@example.com', name: 'Dashes' };

describe('draftNameFor', () => {
  it("puts the caller's prefix on a bare name they could not delete once made", async () => {
    expect(await draftNameFor(false, 'copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'fix-typo', dotted)).toBe('paul-brandt/fix-typo');
  });

  it('gives an address with no usable localpart its suggestions prefix, which is still theirs to delete', async () => {
    expect(await draftNameFor(false, 'fix-typo', noLocalpart)).toBe('suggestions/user-abcdef12/fix-typo');
  });

  it('treats a delete rule that cannot be read as a no, and adds the prefix', async () => {
    expect(await draftNameFor('unreadable', 'copilot-check', visitor)).toBe('demo/copilot-check');
  });

  it('keeps a bare name the caller may delete anyway (an admin)', async () => {
    expect(await draftNameFor(true, 'release-notes', visitor)).toBe('release-notes');
  });

  it('keeps a protected name as asked, so creating it is refused rather than prefixed', async () => {
    expect(await draftNameFor(false, 'main', visitor)).toBe('main');
  });

  it('keeps every name that already has a prefix, theirs or another', async () => {
    expect(await draftNameFor(false, 'demo/copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'suggestions/abc', visitor)).toBe('suggestions/abc');
    expect(await draftNameFor(false, 'agent/fix-123', visitor)).toBe('agent/fix-123');
  });
});
