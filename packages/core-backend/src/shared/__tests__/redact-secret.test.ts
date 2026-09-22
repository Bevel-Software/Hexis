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

  it('scrubs userinfo whole when the password carries an unencoded @ of its own', () => {
    expect(redactSecret("unable to access 'https://alice:p@ss@w0rd@example.com/kb.git/': 401")).toBe(
      "unable to access 'https://***@example.com/kb.git/': 401",
    );
    // An @ past the host — in the path — is not userinfo.
    expect(redactSecret('https://example.com/acme/@team/kb.git')).toBe('https://example.com/acme/@team/kb.git');
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

  /**
   * A host that quotes a token back elides its middle (`ghp_abcdef…`). The
   * head it prints is enough of the secret to be one, so the longest echoed
   * prefix is scrubbed when the whole value is not there — down to a floor,
   * so a vendor's common prefix does not garble every other token.
   */
  it('scrubs the longest echoed prefix of a token the host elided', () => {
    expect(redactSecret("remote: token 'ghp_abcdefghijklmnop…' was rejected", ['ghp_abcdefghijklmnopqrstuv'])).toBe(
      "remote: token '***…' was rejected",
    );
    // Whole value present: scrubbed whole, once.
    expect(redactSecret('x ghp_abcdefghijklmnopqrstuv y', ['ghp_abcdefghijklmnopqrstuv'])).toBe('x *** y');
    // Both in one text (the value in the URL, the elided form in the reply): both go.
    expect(
      redactSecret("fetch https://ghp_abcdefghijklmnopqrstuv@host/r: token 'ghp_abcdefghijklmnop…' rejected", [
        'ghp_abcdefghijklmnopqrstuv',
      ]),
    ).toBe("fetch https://***@host/r: token '***…' rejected");
    // Only the vendor prefix in common: below the floor, untouched.
    expect(redactSecret('a ghp_other b', ['ghp_abcdefghijklmnopqrstuv'])).toBe('a ghp_other b');
    // Two tokens sharing a head longer than the floor: the echo of the second
    // goes whole, not just the head the first one also has.
    expect(
      redactSecret("token 'ghp_abcdefghY123…' rejected", ['ghp_abcdefghXXXXXXXXXX', 'ghp_abcdefghY123456789']),
    ).toBe("token '***…' rejected");
  });

  it('scrubs every token in effect: env aliases and tokens the caller names', () => {
    const saved = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GIT_TOKEN: process.env.GIT_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
    };
    process.env.GITHUB_TOKEN = 'ghp_fromgithubenv';
    process.env.GIT_TOKEN = 'glpat_fromenv';
    process.env.GH_TOKEN = 'gho_legacyenv';
    try {
      expect(
        redactSecret('a glpat_fromenv b ghp_fromsettings c gho_legacyenv d ghp_fromgithubenv', [
          'ghp_fromsettings',
          '',
          null,
        ]),
      ).toBe('a *** b *** c *** d ***');
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
