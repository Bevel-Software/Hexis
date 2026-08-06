import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  configureBranchModel,
  isBranchModelConfigured,
  isProtectedBranch,
  protectedBranchDisplayName,
  DEFAULT_BRANCH,
  PROTECTED_BRANCHES,
} from '@bevel-software/platform-shared';

const PAIR = {
  defaultBranch: 'target-company-state',
  protectedBranches: ['current-company-state', 'target-company-state'],
};

beforeEach(() => configureBranchModel(PAIR));
// The model is module-global by design (that is what lets every call site keep
// importing a binding). Restore it so a suite that runs after this one in the
// same worker is not left with whatever the last case configured.
afterEach(() => configureBranchModel(PAIR));

describe('configureBranchModel', () => {
  it('applies the model to every export', () => {
    expect(isBranchModelConfigured()).toBe(true);
    expect(DEFAULT_BRANCH).toBe('target-company-state');
    expect([...PROTECTED_BRANCHES].sort()).toEqual([
      'current-company-state',
      'target-company-state',
    ]);
    expect(isProtectedBranch('current-company-state')).toBe(true);
    expect(isProtectedBranch('someone/draft')).toBe(false);
  });

  it('accepts the comma/space list the environment supplies', () => {
    configureBranchModel({ defaultBranch: 'main', protectedBranches: 'main, release' });
    expect([...PROTECTED_BRANCHES].sort()).toEqual(['main', 'release']);
  });

  it('derives display names from the slug', () => {
    expect(protectedBranchDisplayName('target-company-state')).toBe('Target company state');
    // Unknown names return null so the caller decides between the raw slug and
    // hiding the affordance — it must not invent a name for a feature branch.
    expect(protectedBranchDisplayName('someone/draft')).toBeNull();
  });

  /**
   * The default branch is where users land and the default propose target. If
   * it is not itself protected, `isProtectedBranch(DEFAULT_BRANCH)` is false and
   * every protected-branch guard silently stops applying to the one branch that
   * needs them most. Refused rather than shipped.
   */
  it('refuses a default branch that is not protected', () => {
    expect(() =>
      configureBranchModel({ defaultBranch: 'main', protectedBranches: ['release'] }),
    ).toThrow(/must be one of the protected branches/);
  });

  it('refuses an empty model rather than defaulting to something plausible', () => {
    expect(() => configureBranchModel({ defaultBranch: '', protectedBranches: ['main'] })).toThrow(
      /default branch is required/,
    );
    expect(() => configureBranchModel({ defaultBranch: 'main', protectedBranches: [] })).toThrow(
      /At least one protected branch/,
    );
  });

  /**
   * A rejected model must not half-apply. The previous one stays in force, so a
   * bad `/api/config` payload cannot leave the app pointing at a branch that is
   * neither the old value nor the new one.
   */
  it('leaves the previous model intact when it refuses a new one', () => {
    expect(() =>
      configureBranchModel({ defaultBranch: 'nope', protectedBranches: ['other'] }),
    ).toThrow();
    expect(DEFAULT_BRANCH).toBe('target-company-state');
    expect(isProtectedBranch('target-company-state')).toBe(true);
  });
});
