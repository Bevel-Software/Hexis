import { describe, it, expect } from 'vitest';
import { offersManageAccess } from '../manage-access-affordance';

describe('offersManageAccess', () => {
  it("withholds it from the tree's own root row", () => {
    expect(offersManageAccess({ relativePath: '.' })).toBe(false);
  });

  it('offers it on any folder or file inside the tree, a skill folder included', () => {
    expect(offersManageAccess({ relativePath: 'knowledge-base/Sales' })).toBe(true);
    expect(offersManageAccess({ relativePath: 'knowledge-base/Skills/newsletter' })).toBe(true);
    expect(offersManageAccess({ relativePath: 'knowledge-base/Sales/Deal.md' })).toBe(true);
  });
});
