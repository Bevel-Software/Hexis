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

  it("withholds a quote that repeats the caller's text, so a guess or a candidate comes back the same right or wrong", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    redactor.remember('a9B2');
    const cases: Array<readonly [string, readonly string[]]> = [
      // A guess at a head of the key, echoed back, right and wrong.
      ["Project 'sk-live-Q7xZ' not found", ['sk-live-Q7xZ']],
      ["Project 'sk-live-Q7xA' not found", ['sk-live-Q7xA']],
      // The server quoting the key itself, with or without the right candidate among the caller's strings.
      ['key a9B2 refused', ['a9B2', 'zzzz']],
      ['key a9B2 refused', ['a9B3', 'zzzz']],
      // A server that shortens what it quotes, keeps only its end or middle, or re-cases it.
      ["Project 'sk-live-Q7xZ-and-…' not found", ['sk-live-Q7xZ-and-some-padding']],
      ["Project '…sk-live-Q7xA' not found", ['padding-padding-sk-live-Q7xA']],
      ["near 'sk-live-Q7xZ' only", ['aaaa-sk-live-Q7xZ-bbbb']],
      ['SK-LIVE-Q7XZ refused', ['sk-live-q7xz']],
      // Case changes that change a character's length: `ß` upper-cased is `SS`, `İ` lower-cased is `i̇`.
      ['no STRASSE here', ['straße']],
      ['no i̇stanbul here', ['İSTANBUL']],
      ['ßxx', ['SSxx']],
      // Text the caller sent that no secret is in.
      ["No page named 'Quarterly plan'", ['Quarterly plan']],
    ];
    for (const [text, sent] of cases) expect(redactor.redact(text, sent)).toBe('[redacted]');
  });

  it("withholds the quote whatever part of a key the caller's text covered, so it reads the same right or wrong", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    redactor.remember('abcd!?');
    redactor.remember('alpha be gamma');
    redactor.remember('alpha \u{10400}b');
    const cases: Array<readonly [string, readonly string[]]> = [
      // The server's words glued to a guess, right and wrong.
      ['sk-live-Q7xZ2abcdefgh!', ['sk-live-Q7xZ']],
      ['sk-live-Q7xA2ab!', ['sk-live-Q7xA']],
      // The key printed whole or in part, next to a guess at its start, middle or end, or at none of it.
      ['key sk-live-Q7xZ2abcdefgh refused', ['sk-l']],
      ['key sk-live-Q7xZ2ab refused', ['sk-live-XXXX']],
      ['key sk-live-Q7xZ2ab refused', ['zzzzzzzzzzzz']],
      ['key abcd!? refused', ['abcd']],
      ['key abcd!? refused', ['abce']],
      ['key alpha be gamma refused', ['alpha', 'gamma']],
      ['key alpha be gamma refused', ['zzzzz', 'yyyyy']],
      ['key zzzzz be yyyyy refused', ['zzzzz', 'yyyyy']],
      ['key alpha \u{10400}b refused', ['alpha']],
    ];
    for (const [text, sent] of cases) expect(redactor.redact(text, sent)).toBe('[redacted]');
  });

  it('answers the same whether a stretch the caller places next to their text is in a key', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    // A short argument the server glues to a longer one, or two short ones glued together, in the key or not.
    for (const probe of ['Q7x', 'ABC']) expect(redactor.redact(`no zzzz${probe} here`, ['zzzz', probe])).toBe('[redacted]');
    for (const [a, b] of [['Q7', 'xZ'], ['AB', 'CD']]) expect(redactor.redact(`no ${a}${b} here`, [a, b])).toBe('[redacted]');
  });

  it('answers the same whether a short guess the server glues its own characters to completes a key', () => {
    const redactor = new SecretRedactor();
    redactor.remember('a9B2');
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    for (const guess of ['a9B', 'a9C']) expect(redactor.redact(`no ${guess}2 here`, [guess])).toBe('[redacted]');
    for (const guess of ['sk', 'zz']) expect(redactor.redact(`no ${guess}-live-Q7xZ here`, [guess])).toBe('[redacted]');
  });

  it("passes a quote on as it came when it repeats none of the caller's text and holds no secret", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    const text = 'This tool requires a Business plan or higher.';
    expect(redactor.redact(text, ['Quarterly review', 'limit', 50].map(String))).toBe(text);
    // A short string of the caller's counts wherever it appears, glued to other text or not.
    expect(redactor.redact('Invalid value: 42 (max 420)', ['2'])).toBe('[redacted]');
    expect(redactor.redact(text, ['hi'])).toBe('[redacted]');
  });

  it("withholds a quote that holds a secret while the caller's text is about, and takes it out of one quoted without", () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    expect(redactor.redact('Unauthorized: sk-live-Q7xZ2abcdefgh', ['hi'])).toBe('[redacted]');
    expect(redactor.redact('Unauthorized: sk-live-Q7xZ2abcdefgh')).toBe('Unauthorized: [redacted]');
  });

  it("quotes the caller's text as it came when no secret is held: there is nothing to keep", () => {
    expect(new SecretRedactor().redact("No page named 'Quarterly plan'", ['Quarterly plan'])).toBe("No page named 'Quarterly plan'");
  });

  it('withholds a long echoed run of one character without going over its bound', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    const run = 'a'.repeat(20_000);
    expect(redactor.redact(`bad value ${run}`, [run])).toBe('[redacted]');
  });

  it('quotes nothing when what the caller sent is too long to read', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    expect(redactor.redact('bad value', ['z'.repeat(4_000_001)])).toBe('[redacted]');
  });

  it("quotes nothing with the caller's text about while a secret shorter than four characters is held, a substituted value too", () => {
    for (const short of ['ab1', 'a!']) {
      const redactor = new SecretRedactor();
      redactor.remember(short);
      for (const guess of [short, 'zz9', 'b!']) {
        expect(redactor.redact(`PIN ${guess} is wrong`, [guess])).toBe('[redacted]');
        expect(redactor.redact(`no x${guess}y here`, [guess])).toBe('[redacted]');
      }
    }
    const redactor = new SecretRedactor();
    redactor.rememberSubstituted('REGION', 'us');
    // A guess the server shortens to the value's length, right or wrong, and one that is nowhere in the quote.
    expect(redactor.redact('region us is closed', ['uspadding'])).toBe('[redacted]');
    expect(redactor.redact('region eu is closed', ['eupadding'])).toBe('[redacted]');
    expect(redactor.redact('This tool requires a Business plan.', ['Quarterly review'])).toBe('[redacted]');
    // Without the caller's text about, the value is taken out where it stands alone, as before.
    expect(redactor.redact('region us is closed')).toBe('region [redacted] is closed');
  });

  it('takes out a credential shorter than four characters inside other words too', () => {
    const redactor = new SecretRedactor();
    redactor.remember('ab1');
    expect(redactor.redact('key xab1y refused')).toBe('key x[redacted]y refused');
  });

  it('looks for many short strings of the caller in one walk over a long text', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    const words = 'word '.repeat(4_000);
    expect(redactor.redact(`${words}! end`, Array.from({ length: 200_000 }, () => '?'))).toBe(`${words}! end`);
    expect(redactor.redact(`${words}? end`, Array.from({ length: 200_000 }, () => '?'))).toBe('[redacted]');
  });

  it('fills overlapping pieces once, so a megabyte of echoes stays fast', () => {
    const redactor = new SecretRedactor();
    redactor.remember('a'.repeat(1_000_000));
    const started = performance.now();
    expect(redactor.redact(`${'a'.repeat(1_000_000)} tail`)).toBe('[redacted] tail');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('matches a long repetitive secret in a long text without giving up on the text', () => {
    const redactor = new SecretRedactor();
    redactor.remember('ab'.repeat(500));
    expect(redactor.redact(`${'ab'.repeat(20_000)} tail`)).toBe('[redacted] tail');
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
