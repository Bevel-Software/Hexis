import { describe, it, expect } from 'vitest';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { ToolError } from '../../tool-helpers/tool.contract.js';

const SID = 'watchlistcheck-gtm-run-1';

describe('RoutineWritePolicyService', () => {
  it('allows any write when the session has no restriction', () => {
    const policy = new RoutineWritePolicyService();
    expect(() => policy.assertPathWritable(SID, 'knowledge-base/KnowledgeBase/Product/Knowledge/Foo.md')).not.toThrow();
    expect(() => policy.assertUnrestricted(SID)).not.toThrow();
  });

  it('allows only the restricted extensions and blocks everything else with a 403', () => {
    const policy = new RoutineWritePolicyService();
    policy.restrictToExtensions(SID, ['.html', '.htm']);

    // Dashboard writes pass (case-insensitive).
    expect(() => policy.assertPathWritable(SID, 'knowledge-base/KnowledgeBase/GTM/Dashboard.html')).not.toThrow();
    expect(() => policy.assertPathWritable(SID, 'knowledge-base/KnowledgeBase/GTM/Dashboard.HTM')).not.toThrow();

    // Graph nodes and any other path are refused.
    for (const blocked of [
      'knowledge-base/KnowledgeBase/Product/Knowledge/sc-b2g-no-self-billing.md',
      'knowledge-base/AGENTS.md',
      'knowledge-base/KnowledgeBase/GTM/notes.txt',
      'knowledge-base/KnowledgeBase/GTM', // a directory (mkdir) — no extension
    ]) {
      const err = getThrown(() => policy.assertPathWritable(SID, blocked));
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).status).toBe(403);
    }
  });

  it('never restricts a caller with no session id', () => {
    const policy = new RoutineWritePolicyService();
    policy.restrictToExtensions(SID, ['.html']);
    // A different (or absent) session id is unaffected by SID's restriction.
    expect(() => policy.assertPathWritable(undefined, 'anything.md')).not.toThrow();
    expect(() => policy.assertPathWritable('other-session', 'anything.md')).not.toThrow();
    expect(() => policy.assertUnrestricted(undefined)).not.toThrow();
  });

  it('blocks the pathless shell tool for a restricted session', () => {
    const policy = new RoutineWritePolicyService();
    policy.restrictToExtensions(SID, ['.html']);
    const err = getThrown(() => policy.assertUnrestricted(SID));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).status).toBe(403);
  });

  it('clear() lifts the restriction', () => {
    const policy = new RoutineWritePolicyService();
    policy.restrictToExtensions(SID, ['.html']);
    policy.clear(SID);
    expect(() => policy.assertPathWritable(SID, 'foo.md')).not.toThrow();
    expect(() => policy.assertUnrestricted(SID)).not.toThrow();
  });
});

function getThrown(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the function to throw, but it did not');
}
