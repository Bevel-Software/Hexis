import { describe, it, expect, vi, afterEach } from 'vitest';

import { toHttpError, requireNonEmptyString } from '../admin-route-helpers.js';
import { WorkflowDomainError } from '../../../shared/domain-errors.js';
import { AccessMutationError } from '../access-mutation.service.js';

describe('toHttpError — the shared access-family error shape', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a sub-500 domain error keeps its status, message, and payload', () => {
    const err = new WorkflowDomainError('groups are being edited', 409, { kind: 'idp-mode' });
    expect(toHttpError(err, 'test')).toEqual({
      status: 409,
      body: { error: 'groups are being edited', kind: 'idp-mode' },
    });
  });

  it('a 500-status DOMAIN error never leaks its message — generic body, full server-side log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // AccessMutationService wraps unexpected raw errors (fs/db failures) in a
    // 500 AccessMutationError with the RAW message — that must not reach the
    // client.
    const err = new AccessMutationError("ENOENT: open '/srv/kb/secret-folder/access.md'", 500);
    const { status, body } = toHttpError(err, 'test');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal error.' });
    expect(JSON.stringify(body)).not.toContain('secret-folder');
    expect(spy).toHaveBeenCalled(); // the details land server-side
  });

  it('a raw (non-domain) error is a generic 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(toHttpError(new Error('db connection string postgres://u:p@host'), 'test')).toEqual({
      status: 500,
      body: { error: 'Internal error.' },
    });
  });

  it("a payload key named 'error' cannot overwrite the client-facing message", () => {
    const err = new WorkflowDomainError('the real message', 422, { error: 'spoofed', kind: 'x' });
    const { body } = toHttpError(err, 'test');
    expect(body.error).toBe('the real message');
    expect(body.kind).toBe('x');
  });
});

describe('requireNonEmptyString', () => {
  it('accepts a plain string and rejects non-strings with a 400 domain error', () => {
    expect(requireNonEmptyString('ok', 'field')).toBe('ok');
    for (const bad of [42, null, undefined, ['a'], { a: 1 }, '   ']) {
      let caught: unknown;
      try {
        requireNonEmptyString(bad, 'field');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkflowDomainError);
      expect((caught as WorkflowDomainError).status).toBe(400);
    }
  });
});
