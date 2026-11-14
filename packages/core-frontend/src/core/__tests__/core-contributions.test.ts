import { describe, it, expect } from 'vitest';
import { withCoreModuleContributions } from '../core-contributions';
import { makeRegistry, type AdminMenuItem } from '../registry';

// Core modules offer their rows through their public surface and the shell
// merges them; the settings list never imports another module's rows.
describe('withCoreModuleContributions', () => {
  it("merges git's profile-menu row ahead of the registry's", () => {
    const extension: AdminMenuItem = { id: 'stub', label: 'Stub', path: '/stub' };
    const merged = withCoreModuleContributions(makeRegistry({ adminMenuItems: [extension] }));
    expect(merged.adminMenuItems.map((item) => item.id)).toEqual([
      'ask-before-branch-delete',
      'stub',
    ]);
  });
});
