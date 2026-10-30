import { describe, it, expect } from 'vitest';
import { canonicalWorkspaceId } from '../pending-commits.service.js';

/**
 * Regression for the "human saves on a feature branch never commit" bug: the
 * enqueue path received the workspace id URL-decoded (`alice/feature`, because
 * Express decodes the `:id` path param) while the worker claimed per
 * `knownWorkspaces()` = `encodeURIComponent(branch)` (`alice%2Ffeature`). The
 * two strings differed, so the `pending_commits` row was never claimed and the
 * edit stayed uncommitted. `canonicalWorkspaceId` must collapse BOTH forms to
 * the single encoded id so enqueue and claim always agree.
 */
describe('canonicalWorkspaceId', () => {
  it('maps the decoded and encoded forms of a slashed branch to the same id', () => {
    const decoded = canonicalWorkspaceId('razvan.radulescu/code-review-skill');
    const encoded = canonicalWorkspaceId('razvan.radulescu%2Fcode-review-skill');
    expect(decoded).toBe('razvan.radulescu%2Fcode-review-skill');
    expect(encoded).toBe('razvan.radulescu%2Fcode-review-skill');
    expect(decoded).toBe(encoded);
  });

  it('is idempotent', () => {
    const once = canonicalWorkspaceId('alice/feature');
    expect(canonicalWorkspaceId(once)).toBe(once);
  });

  it('leaves a protected (slash-less) branch id unchanged', () => {
    expect(canonicalWorkspaceId('current-company-state')).toBe('current-company-state');
    expect(canonicalWorkspaceId('target-company-state')).toBe('target-company-state');
  });

  it('returns a malformed percent-sequence untouched instead of throwing', () => {
    // `decodeURIComponent('%zz')` throws — the helper must swallow and pass through.
    expect(canonicalWorkspaceId('%zz')).toBe('%zz');
  });
});
