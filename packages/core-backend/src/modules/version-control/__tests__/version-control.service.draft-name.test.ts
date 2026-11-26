import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { VersionControlService } from '../version-control.service.js';

/**
 * `draftNameFor`: the name `create_branch` creates a draft under. Called on a
 * stand-in holding only the git rule it consults, so the test pins the naming
 * decision and nothing of the service's wiring.
 */
function draftNameFor(mayDelete: boolean, name: string, user: AuthUser): Promise<string> {
  const asked: string[] = [];
  const self = {
    git: {
      mayDeleteBranch: async (_ws: string, branch: string) => {
        asked.push(branch);
        return mayDelete;
      },
    },
  };
  return VersionControlService.prototype.draftNameFor.call(self as never, 'ws', name, user);
}

const visitor: AuthUser = { id: 'u1', email: 'demo@example.com', name: 'Demo' };
const dotted: AuthUser = { id: 'u2', email: 'Paul.Brandt@bevel.software', name: 'Paul' };

describe('draftNameFor', () => {
  it("puts the caller's prefix on a bare name they could not delete once made", async () => {
    expect(await draftNameFor(false, 'copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'fix-typo', dotted)).toBe('paul-brandt/fix-typo');
  });

  it('keeps a bare name the caller may delete anyway (an admin)', async () => {
    expect(await draftNameFor(true, 'release-notes', visitor)).toBe('release-notes');
  });

  it('keeps every name that already has a prefix, theirs or another', async () => {
    expect(await draftNameFor(false, 'demo/copilot-check', visitor)).toBe('demo/copilot-check');
    expect(await draftNameFor(false, 'suggestions/abc', visitor)).toBe('suggestions/abc');
    expect(await draftNameFor(false, 'agent/fix-123', visitor)).toBe('agent/fix-123');
  });
});
