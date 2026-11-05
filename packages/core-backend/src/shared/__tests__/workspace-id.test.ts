import { describe, it, expect } from 'vitest';
import { branchForWorkspaceId, workspaceIdForBranch } from '../workspace-id.js';

describe('workspace-id mapping', () => {
  it('round-trips branch names, slashes included', () => {
    for (const branch of ['current-company-state', 'alice/draft', 'a b', '100%']) {
      expect(branchForWorkspaceId(workspaceIdForBranch(branch))).toBe(branch);
    }
  });

  it('never throws on a malformed id — it names a branch that does not exist', () => {
    for (const malformed of ['%', '100%', '%2', '%zz', 'a%2Gb']) {
      expect(() => branchForWorkspaceId(malformed)).not.toThrow();
      expect(branchForWorkspaceId(malformed)).toBe(malformed);
    }
  });
});
