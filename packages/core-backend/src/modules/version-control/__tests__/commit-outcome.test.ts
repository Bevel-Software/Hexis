import { describe, expect, it } from 'vitest';
import { commitLanded } from '../commit-outcome.js';
import { PushNeedsAgentResolutionError, VersionControlValidationError } from '../../../shared/domain-errors.js';

describe('commitLanded — the one rule for what a committer announces', () => {
  it('a change answered: landed', () => {
    expect(commitLanded({ change: { sha: 'abc' } as never })).toBe(true);
  });

  it('a clean tree (null): nothing landed', () => {
    expect(commitLanded({ change: null })).toBe(false);
  });

  it('the push hand-off: the commit exists, only its push is owed — landed', () => {
    expect(commitLanded({ threw: new PushNeedsAgentResolutionError('feat', 'knowledge-base/A.md', 'non-fast-forward', 'rebase failed') })).toBe(true);
  });

  it('any other failure: nothing landed', () => {
    expect(commitLanded({ threw: new VersionControlValidationError('refused') })).toBe(false);
    expect(commitLanded({ threw: new Error('git exploded') })).toBe(false);
    expect(commitLanded({ threw: 'a string' })).toBe(false);
  });
});
