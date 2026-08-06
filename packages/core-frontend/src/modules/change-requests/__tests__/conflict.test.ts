import { describe, it, expect } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { conflictResolutionPrompt } from '../utils/conflict';

const cr = {
  number: 12,
  title: 'Changes from Razvan — Knowledge',
  branch: 'suggestions/razvan/knowledge',
  base: 'main',
} as PullRequestSummary;

describe('conflictResolutionPrompt', () => {
  /**
   * The prompt is pasted VERBATIM into whatever agent the user runs, so it
   * must be self-contained: the request number and both branch names filled
   * in (no blanks for the user to complete), the outcome stated rather than
   * a tool sequence, and the resolution intent — the proposal lands ON TOP
   * of the newer text.
   */
  it('carries everything the agent needs, verbatim', () => {
    const p = conflictResolutionPrompt(cr);
    expect(p).toContain('#12');
    expect(p).toContain('"suggestions/razvan/knowledge"');
    expect(p).toContain('"main"');
    expect(p).toContain('Changes from Razvan — Knowledge');
    // Outcome, not mechanism: the words an agent can act on regardless of
    // which tools it holds.
    expect(p).toMatch(/resolve the conflicts/);
    expect(p).toMatch(/push the branch/);
    expect(p).toMatch(/applied cleanly/);
  });
});
