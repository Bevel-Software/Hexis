import { describe, expect, it } from 'vitest';
import { redactSecret, urlQuerySecrets } from '../redact-secret.js';

describe('redactSecret', () => {
  it('scrubs the configured token wherever it appears', () => {
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_supersecret';
    try {
      expect(redactSecret('fatal: ghp_supersecret was rejected')).toBe('fatal: *** was rejected');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  it('scrubs URL userinfo — a user:pass@ remote must not leak the password', () => {
    expect(redactSecret("fetch of 'https://alice:hunter2@example.com/kb.git' failed")).toBe(
      "fetch of 'https://***@example.com/kb.git' failed",
    );
    // A plain URL is untouched.
    expect(redactSecret('https://example.com/kb.git')).toBe('https://example.com/kb.git');
  });

  it('scrubs URL query strings — a presigned remote keeps its credential there', () => {
    expect(
      redactSecret("unable to access 'https://git.example.com/kb.git?X-Amz-Signature=abc123&X-Amz-Credential=AKIA/x': 403"),
    ).toBe("unable to access 'https://git.example.com/kb.git?***': 403");
    expect(redactSecret('fetch https://git.example.com/kb.git?access_token=s3cret failed')).toBe(
      'fetch https://git.example.com/kb.git?*** failed',
    );
    expect(redactSecret('https://alice:pw@example.com/kb.git?sig=zz')).toBe('https://***@example.com/kb.git?***');
  });

  it('scrubs every token in effect: env aliases and tokens the caller names', () => {
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GIT_TOKEN: process.env.GIT_TOKEN };
    delete process.env.GITHUB_TOKEN;
    process.env.GIT_TOKEN = 'glpat_fromenv';
    try {
      expect(redactSecret('a glpat_fromenv b ghp_fromsettings c', ['ghp_fromsettings', '', null])).toBe(
        'a *** b *** c',
      );
      // A token containing another is scrubbed whole, not half.
      expect(redactSecret('x ghp_abc_long y', ['ghp_abc', 'ghp_abc_long'])).toBe('x *** y');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('urlQuerySecrets', () => {
  it('names the query and each credential-length value, raw and decoded', () => {
    const secrets = urlQuerySecrets('https://git.example.com/kb.git?X-Amz-Signature=abc%2Fdef123&X-Amz-Expires=3600');
    expect(secrets).toContain('X-Amz-Signature=abc%2Fdef123&X-Amz-Expires=3600');
    expect(secrets).toContain('abc%2Fdef123');
    expect(secrets).toContain('abc/def123');
    // Too short to be a credential: scrubbing it would garble every "3600".
    expect(secrets).not.toContain('3600');
    expect(urlQuerySecrets('https://git.example.com/kb.git')).toEqual([]);
    expect(urlQuerySecrets('not a url')).toEqual([]);
    expect(urlQuerySecrets(undefined)).toEqual([]);
  });

  it("lets redactSecret scrub a remote's signature where no URL pattern can see it", () => {
    const secrets = urlQuerySecrets('https://git.example.com/kb.git?X-Amz-Signature=abc%2Fdef123');
    expect(redactSecret('helper echoed abc/def123 then abc%2Fdef123', secrets)).toBe('helper echoed *** then ***');
  });
});
