import { describe, it, expect } from 'vitest';
import { cloneTrackingConfigArgs, ORIGIN_FETCH_REFSPEC } from '../clone-config.js';

describe('cloneTrackingConfigArgs', () => {
  // A slashed draft name is the everyday case (`<email-localpart>/<slug>`), and
  // the branch lands verbatim inside the config KEY — pin the exact tuples so a
  // future quoting/encoding change can't silently re-point tracking.
  it('emits the three --replace-all tuples for a slashed branch', () => {
    expect(cloneTrackingConfigArgs('feature/x')).toEqual([
      ['config', '--replace-all', 'remote.origin.fetch', ORIGIN_FETCH_REFSPEC],
      ['config', '--replace-all', 'branch.feature/x.remote', 'origin'],
      ['config', '--replace-all', 'branch.feature/x.merge', 'refs/heads/feature/x'],
    ]);
  });
});
