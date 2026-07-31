import { describe, it, expect } from 'vitest';
import { sanitizeError } from '../sanitize-error.js';

describe('sanitizeError', () => {
  it('returns String(err) for non-Error throws', () => {
    expect(sanitizeError('plain string')).toBe('plain string');
    expect(sanitizeError(42)).toBe('42');
    expect(sanitizeError(null)).toBe('null');
  });

  it('extracts err.message for Error instances and drops the stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at /secret/path/file.ts:1:1\n  authorization: bearer abc';
    expect(sanitizeError(err)).toBe('boom');
  });

  it('collapses whitespace to a single line', () => {
    expect(sanitizeError(new Error('line1\nline2\n\tline3'))).toBe('line1 line2 line3');
  });

  it('redacts the user:pass component of a credentialed URL but keeps the host', () => {
    const msg = "fatal: unable to access 'https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/acme/repo.git/'";
    const out = sanitizeError(new Error(msg));
    expect(out).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(out).not.toContain('x-access-token');
    expect(out).toContain('[REDACTED]@');
    expect(out).toContain('github.com');
  });

  it('redacts Authorization: Bearer headers', () => {
    const out = sanitizeError(
      new Error('http 401 (Authorization: Bearer sk-AAAAAAAAAAAAAAAAAAAA)'),
    );
    expect(out).not.toContain('sk-AAAAAAAAAAAAAAAAAAAA');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts token= / secret= / api_key= style key-value pairs', () => {
    const out = sanitizeError(new Error('curl https://host?token=AAAAAAAAAAAAAAAA secret=BBBBBBBBBBBBBBBB'));
    expect(out).not.toContain('AAAAAAAAAAAAAAAA');
    expect(out).not.toContain('BBBBBBBBBBBBBBBB');
    expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('redacts long bare hex blobs that look like tokens', () => {
    const out = sanitizeError(new Error('sha=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'));
    expect(out).not.toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  });

  it('redacts GitHub PAT prefixes (ghp_, github_pat_)', () => {
    expect(sanitizeError(new Error('use ghp_abcdef1234567890'))).not.toContain('ghp_abcdef1234567890');
    expect(sanitizeError(new Error('use github_pat_11ABCDEFGH_xxx'))).not.toContain('github_pat_11ABCDEFGH_xxx');
  });

  it('truncates messages longer than 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is idempotent on already-sanitised text', () => {
    const once = sanitizeError(new Error('Authorization: Bearer abc; token=def123'));
    const twice = sanitizeError(once);
    expect(twice).toBe(once);
  });
});
