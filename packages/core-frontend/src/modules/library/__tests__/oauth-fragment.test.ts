import { describe, it, expect, beforeEach } from 'vitest';
import { readOAuthFragment } from '../utils/oauth-fragment';

/**
 * The fragment contract the backend callback speaks. The double-decode case is
 * the one that matters: `URLSearchParams` already percent-decodes, so a second
 * pass corrupts any provider message containing a literal `%`.
 */
describe('readOAuthFragment', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/skills-and-tools/tools/github');
  });

  function at(hash: string) {
    window.history.replaceState(null, '', `/skills-and-tools/tools/github${hash}`);
    return readOAuthFragment();
  }

  it('returns null when there is no fragment', () => {
    expect(readOAuthFragment()).toBeNull();
  });

  it('reads a bare #authorized', () => {
    expect(at('#authorized')).toEqual({ kind: 'authorized' });
  });

  it('reads #authorized=<id> the callback appends', () => {
    expect(at('#authorized=sec_123')).toEqual({ kind: 'authorized' });
  });

  it('decodes an #error message exactly once', () => {
    expect(at('#error=Something%20bad')).toEqual({ kind: 'error', message: 'Something bad' });
  });

  it('leaves a literal percent in an error message alone', () => {
    // `%25` decodes to `%`. A second decodeURIComponent would then throw or
    // mangle it — this is the regression the single-decode rule exists for.
    expect(at('#error=100%25%20failed')).toEqual({ kind: 'error', message: '100% failed' });
  });

  it('falls back to a message when #error carries none', () => {
    expect(at('#error=')).toEqual({ kind: 'error', message: 'Authorization failed.' });
  });

  it('ignores a fragment that carries neither key', () => {
    expect(at('#section=connection')).toBeNull();
  });
});
