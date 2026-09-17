import { describe, it, expect } from 'vitest';
import { domainErrorBody } from '../http-errors.js';
import {
  PathTraversalError,
  UnreadableArchiveError,
  WorkflowDomainError,
  WorkflowValidationError,
} from '../domain-errors.js';

/**
 * The one response body for a domain refusal — and the property eight route
 * surfaces used to get wrong in seven different places.
 */
describe('domainErrorBody', () => {
  it('carries the message and the payload discriminators together', () => {
    expect(domainErrorBody(new PathTraversalError())).toEqual({
      error: 'Path traversal detected',
      kind: 'path-traversal',
    });
    expect(domainErrorBody(new UnreadableArchiveError('bad central directory'))).toEqual({
      error: 'Could not read zip file: bad central directory',
      kind: 'unreadable-archive',
    });
  });

  it('is just the message when the error carries no payload', () => {
    expect(domainErrorBody(new WorkflowValidationError('Only .zip files can be extracted'))).toEqual({
      error: 'Only .zip files can be extracted',
    });
  });

  it("a payload key named `error` never replaces the message — the bug this exists to make unwritable", () => {
    // Spread payload-last and the client renders "something else entirely"
    // instead of the refusal. `payload` is a Record<string, unknown>, so this
    // key is expressible and nothing but ordering prevents it.
    const err = new WorkflowDomainError('The real refusal.', 409, {
      error: 'something else entirely',
      kind: 'contended',
    });
    expect(domainErrorBody(err)).toEqual({ error: 'The real refusal.', kind: 'contended' });
  });
});
