import {
  DEFAULT_KB_LAYOUT,
  resolveBranchModel,
  type BranchModel,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { KbContext } from '../shared/kb-context.js';

/**
 * The knowledge-base context suites hand to the services they construct: the
 * historical two-branch pair `vitest.config.ts` pins (and `test-setup.ts`
 * mirrors onto the shared bindings, for the fixtures that still spell a
 * branch by its binding), the default layout, and `knowledge-base` as the
 * checkout folder. Override any part for a suite that needs another.
 */
export const TEST_BRANCH_MODEL: BranchModel = {
  defaultBranch: 'target-company-state',
  protectedBranches: ['current-company-state', 'target-company-state'],
};

export function testKbContext(
  overrides: { kbDirName?: string; branchModel?: BranchModel | null; layout?: KbLayout } = {},
): KbContext {
  const model = overrides.branchModel === undefined ? TEST_BRANCH_MODEL : overrides.branchModel;
  return new KbContext(
    overrides.kbDirName ?? 'knowledge-base',
    model === null ? KbContext.branchModelOrUnconfigured({ defaultBranch: '', protectedBranches: [] }) : resolveBranchModel(model),
    overrides.layout ?? DEFAULT_KB_LAYOUT,
  );
}
