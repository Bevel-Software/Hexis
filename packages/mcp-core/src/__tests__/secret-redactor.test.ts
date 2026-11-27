import { describe, expect, it } from 'vitest';
import type { CallTemplate } from '@utcp/sdk';
import { SecretRedactor, rememberCallCredentials, rememberCredentialQuery } from '../secret-redactor.js';

describe('SecretRedactor', () => {
  it('takes out a whole value and, in the same text, a masked head of it', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-1234567890abcdef');
    expect(redactor.redact('key sk-live-1234567890abcdef, shown as sk-live-1234… in the log')).toBe(
      'key [redacted], shown as [redacted]… in the log',
    );
  });

  it("takes out two values that share a head, whole, without one's head pass printing the other's tail", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-aaaa1111');
    redactor.remember('sk-live-bbbb2222');
    expect(redactor.redact('first sk-live-bbbb2222, then sk-live-aaaa1111, then sk-live-bbbb…')).toBe(
      'first [redacted], then [redacted], then [redacted]…',
    );
  });

  it('takes out a short known credential wherever it appears, glued to other text included', () => {
    const asCredential = new SecretRedactor();
    asCredential.remember('a9B2');
    const asCredentialVariable = new SecretRedactor();
    asCredentialVariable.rememberSubstituted('API_KEY', 'a9B2');
    for (const redactor of [asCredential, asCredentialVariable]) {
      expect(redactor.redact('key a9B2 in xa9B2y')).toBe('key [redacted] in x[redacted]y');
    }
  });

  it('matches a short substituted value not named as a credential only where it stands alone', () => {
    const redactor = new SecretRedactor();
    redactor.rememberSubstituted('REGION', 'us');
    expect(redactor.redact('region us, status 401 for users')).toBe('region [redacted], status 401 for users');
  });

  it.each(['PIN', 'DB_PASSCODE', 'JWT', 'SESSION_ID', 'BEARER', 'OTP', 'dbPass', 'serviceCreds', 'client_cred', 'APIPin', 'GHPat'])('counts a `${%s}` as a credential', (name) => {
    const redactor = new SecretRedactor();
    redactor.rememberSubstituted(name, 'a9B2');
    expect(redactor.redact('xa9B2y')).toBe('x[redacted]y');
  });

  it.each(['BYPASS_CACHE', 'PRIVATE_REPO', 'CREDIT_LIMIT'])('does not count a `${%s}` as a credential', (name) => {
    const redactor = new SecretRedactor();
    redactor.rememberSubstituted(name, 'true');
    expect(redactor.redact('untrue: true')).toBe('untrue: [redacted]');
  });

  it('remembers a value that cannot be url-encoded, without throwing', () => {
    const redactor = new SecretRedactor();
    redactor.remember('\ud800lone-surrogate');
    expect(redactor.redact('sent \ud800lone-surrogate')).toBe('sent [redacted]');
  });

  it('takes out the spellings a value travels in: trimmed, url-encoded and JSON-escaped', () => {
    const redactor = new SecretRedactor();
    redactor.remember('a b/c"d1234567');
    redactor.remember('a9B2\n');
    expect(redactor.redact('sent a%20b%2Fc%22d1234567, read "a b\\/c\\"d1234567", then xa9B2y')).toBe(
      'sent [redacted], read "[redacted]", then x[redacted]y',
    );
  });

  it('takes out two echoes that overlap, both of them', () => {
    const redactor = new SecretRedactor();
    redactor.remember('abcdefgh1234');
    redactor.remember('1234wxyz5678');
    expect(redactor.redact('got abcdefgh1234wxyz5678.')).toBe('got [redacted].');
  });

  it("takes out every repeat of the caller's own text, so a guess or a candidate comes back the same right or wrong", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    redactor.remember('a9B2');
    // A guess at a head of the key, echoed back: right and wrong read the same.
    expect(redactor.redact("Project 'sk-live-Q7xZ' not found", ['sk-live-Q7xZ'])).toBe("Project '[redacted]' not found");
    expect(redactor.redact("Project 'sk-live-Q7xA' not found", ['sk-live-Q7xA'])).toBe("Project '[redacted]' not found");
    // The server quoting the key itself: the same with or without the right candidate among the caller's strings
    // (when the caller's text was exempt, the right candidate printed the key).
    expect(redactor.redact('key a9B2 refused', ['a9B2', 'zzzz'])).toBe('key [redacted] refused');
    expect(redactor.redact('key a9B2 refused', ['a9B3', 'zzzz'])).toBe('key [redacted] refused');
    // A server that shortens what it quotes: the part it kept, right guess or wrong.
    expect(redactor.redact("Project 'sk-live-Q7xZ-and-…' not found", ['sk-live-Q7xZ-and-some-padding'])).toBe(
      "Project '[redacted]…' not found",
    );
    expect(redactor.redact("Project 'sk-live-Q7xA-and-…' not found", ['sk-live-Q7xA-and-some-padding'])).toBe(
      "Project '[redacted]…' not found",
    );
    // Text the caller sent that no secret is in is taken out all the same.
    expect(redactor.redact("No page named 'Quarterly plan'", ['Quarterly plan'])).toBe("No page named '[redacted]'");
    // Shorter than four characters, the caller's text is left to the other rules.
    expect(redactor.redact('field id is wrong', ['id'])).toBe('field id is wrong');
  });

  it('never matches a value inside a marker it has already put in', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-1234567890');
    redactor.remember('act');
    expect(redactor.redact('sent sk-live-1234567890, then act')).toBe('sent [redacted], then [redacted]');
  });

  it('reads a query name as URLSearchParams does, a malformed escape included', () => {
    const redactor = new SecretRedactor();
    rememberCredentialQuery('https://x.example/mcp?%74oken%FF=ab%FFverysecret-tail', redactor);
    expect(redactor.redact('sent ab%FFverysecret-tail')).toBe('sent [redacted]');
  });

  it('takes out a query credential in both spellings, as sent and as read', () => {
    const redactor = new SecretRedactor();
    rememberCredentialQuery('https://x.example/mcp?region=eu&api_key=a%2Bb%2Fc1234567', redactor);
    expect(redactor.redact('sent a%2Bb%2Fc1234567, read a+b/c1234567, region eu')).toBe(
      'sent [redacted], read [redacted], region eu',
    );
  });
});

describe('rememberCallCredentials', () => {
  it('remembers the credentials a template spells out in full, and nothing public', () => {
    const redactor = new SecretRedactor();
    const template = {
      name: 'n',
      call_template_type: 'mcp',
      auth: { auth_type: 'api_key', api_key: 'auth-key-1234567890', var_name: 'X-Key' },
      config: {
        mcpServers: {
          web: {
            url: 'https://api.example.com/mcp?token=query-token-123456',
            headers: { Authorization: 'Bearer header-token-123456' },
          },
          local: { command: 'node', env: { API_TOKEN: 'env-token-1234567', LOG_LEVEL: 'debugging' } },
        },
      },
    };
    rememberCallCredentials(redactor, template as unknown as CallTemplate);
    expect(
      redactor.redact(
        'https://api.example.com/mcp refused header-token-123456, query-token-123456, env-token-1234567 and auth-key-1234567890 at debugging',
      ),
    ).toBe('https://api.example.com/mcp refused [redacted], [redacted], [redacted] and [redacted] at debugging');
  });
});
