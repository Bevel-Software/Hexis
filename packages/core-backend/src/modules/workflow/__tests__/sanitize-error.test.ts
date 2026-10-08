import { describe, it, expect } from 'vitest';
import { describeSyncFailure, sanitizeError } from '../sanitize-error.js';

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

  it('honours a raised cap, and falls back to 200 for a cap that is not a positive whole number', () => {
    const long = 'x'.repeat(500);
    expect(sanitizeError(long, { maxLen: 300 })).toHaveLength(300);
    for (const maxLen of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 12.5]) {
      const out = sanitizeError(long, { maxLen });
      expect(out).toHaveLength(200);
      expect(out.endsWith('…')).toBe(true);
    }
  });

  it('is idempotent on already-sanitised text', () => {
    const once = sanitizeError(new Error('Authorization: Bearer abc; token=def123'));
    const twice = sanitizeError(once);
    expect(twice).toBe(once);
  });
});

describe('describeSyncFailure', () => {
  // What a person reads about a failed push: the kind of failure, never a
  // line of git's own output (the server log keeps that).
  const cases: Array<[string, string]> = [
    [
      "fatal: Authentication failed for 'https://x-access-token:ghp_abc@github.com/acme/kb.git/'",
      "The repository host did not accept this server's credentials.",
    ],
    [
      "fatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 401",
      "The repository host did not accept this server's credentials.",
    ],
    [
      "fatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403",
      "The repository host did not give this server's credentials permission to push here.",
    ],
    [
      'remote: Permission to acme/kb.git denied to kb-bot.',
      "The repository host did not give this server's credentials permission to push here.",
    ],
    [
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      "The repository host did not accept this server's credentials.",
    ],
    [
      "error: cannot open .git/FETCH_HEAD: Permission denied",
      "This server could not write to its own copy of the repository.",
    ],
    [
      'error: insufficient permission for adding an object to repository database .git/objects',
      "This server could not write to its own copy of the repository.",
    ],
    [
      "fatal: unable to access 'https://127.0.0.1:9/none.git/': Failed to connect to 127.0.0.1 port 9: Connection refused",
      'The repository host could not be reached.',
    ],
    [
      '! [rejected] main -> main (non-fast-forward)',
      'The branch changed on the repository host and could not be reconciled automatically.',
    ],
    [
      'remote: Internal Server Error\n ! [remote rejected] ali/x -> ali/x (Internal Server Error)',
      'The repository host refused the request.',
    ],
    // A timeout in git's own standalone wording, and Node's code for one.
    [
      "fatal: unable to access 'https://github.com/acme/kb.git/': Operation timed out after 30001 milliseconds",
      'The repository host could not be reached.',
    ],
    ["fatal: unable to access 'https://github.com/acme/kb.git/': timed out", 'The repository host could not be reached.'],
    ['connect ETIMEDOUT 140.82.121.3:443', 'The repository host could not be reached.'],
    // A host's "token" wording is a rejected credential, as its "password" wording is.
    ["remote: Invalid username or token. Password authentication is not supported", "The repository host did not accept this server's credentials."],
    // "repository … not found" with git's quoted URL between the words.
    ["remote: Repository 'https://github.com/acme/kb.git/' not found", "The repository host did not give this server's credentials permission to push here."],
  ];

  it.each(cases)('describes %j without quoting it', (raw, expected) => {
    const said = describeSyncFailure(new Error(raw));
    expect(said).toBe(expected);
    expect(said).not.toMatch(/fatal|remote:|github\.com|ghp_|127\.0\.0\.1/);
  });

  it('says "access to this repository", not "push", when the PULL was refused', () => {
    for (const raw of [
      "fatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403",
      'remote: Repository not found.\nfatal: repository \'https://github.com/acme/kb.git/\' not found',
      'remote: Permission to acme/kb.git denied to kb-bot.',
    ]) {
      expect(describeSyncFailure(new Error(raw), 'pull')).toBe(
        "The repository host did not give this server's credentials access to this repository.",
      );
      expect(describeSyncFailure(new Error(raw), 'push')).toBe(
        "The repository host did not give this server's credentials permission to push here.",
      );
    }
    // A rejected credential is the same fix whichever side met it.
    expect(describeSyncFailure(new Error('fatal: Authentication failed'), 'pull')).toBe(
      "The repository host did not accept this server's credentials.",
    );
  });

  it('accepts a non-Error throw', () => {
    expect(describeSyncFailure('something odd')).toBe('The repository host refused the request.');
  });
});
