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
    expect(redactor.redact("Project 'sk-live-Q7xZ' not found", ['sk-live-Q7xZ'])).toBe('Project [redacted] not found');
    expect(redactor.redact("Project 'sk-live-Q7xA' not found", ['sk-live-Q7xA'])).toBe('Project [redacted] not found');
    // The server quoting the key itself: the same with or without the right candidate among the caller's strings
    // (when the caller's text was exempt, the right candidate printed the key).
    expect(redactor.redact('key a9B2 refused', ['a9B2', 'zzzz'])).toBe('key [redacted] refused');
    expect(redactor.redact('key a9B2 refused', ['a9B3', 'zzzz'])).toBe('key [redacted] refused');
    // A server that shortens what it quotes: the part it kept, right guess or wrong.
    expect(redactor.redact("Project 'sk-live-Q7xZ-and-…' not found", ['sk-live-Q7xZ-and-some-padding'])).toBe(
      'Project [redacted] not found',
    );
    expect(redactor.redact("Project 'sk-live-Q7xA-and-…' not found", ['sk-live-Q7xA-and-some-padding'])).toBe(
      'Project [redacted] not found',
    );
    // A server that keeps only the end or the middle of what it quotes, or re-cases it.
    expect(redactor.redact("Project '…sk-live-Q7xZ' not found", ['padding-padding-sk-live-Q7xZ'])).toBe('Project [redacted] not found');
    expect(redactor.redact("Project '…sk-live-Q7xA' not found", ['padding-padding-sk-live-Q7xA'])).toBe('Project [redacted] not found');
    expect(redactor.redact("near 'sk-live-Q7xZ' only", ['aaaa-sk-live-Q7xZ-bbbb'])).toBe('near [redacted] only');
    expect(redactor.redact('SK-LIVE-Q7XZ refused', ['sk-live-q7xz'])).toBe('[redacted] refused');
    // Case changes that change a character's length: `ß` upper-cased is `SS`, `İ` lower-cased is `i̇`.
    expect(redactor.redact('no STRASSE here', ['straße'])).toBe('no [redacted] here');
    expect(redactor.redact('no i̇stanbul here', ['İSTANBUL'])).toBe('no [redacted] here');
    // A text of three characters whose folding makes four.
    expect(redactor.redact('ßxx', ['SSxx'])).toBe('[redacted]');
    // Text the caller sent that no secret is in is taken out all the same.
    expect(redactor.redact("No page named 'Quarterly plan'", ['Quarterly plan'])).toBe('No page named [redacted]');
    // A short string of the caller's is taken out where it stands alone, not inside other words.
    expect(redactor.redact('Invalid value: 42 (max 420)', ['42'])).toBe('Invalid value: [redacted] (max 420)');
  });

  it('takes out a long echoed run of one character without going over its bound', () => {
    const redactor = new SecretRedactor();
    const run = 'a'.repeat(20_000);
    expect(redactor.redact(`bad value ${run}`, [run])).toBe('bad value [redacted]');
  });

  it('quotes nothing when what the caller sent is too long to read', () => {
    const redactor = new SecretRedactor();
    expect(redactor.redact('bad value', ['z'.repeat(4_000_001)])).toBe('[redacted]');
  });

  it('quotes nothing with the caller\'s text about while a credential shorter than four characters is held', () => {
    for (const short of ['ab1', 'a!']) {
      const redactor = new SecretRedactor();
      redactor.remember(short);
      for (const guess of [short, 'zz9', 'b!']) {
        expect(redactor.redact(`PIN ${guess} is wrong`, [guess])).toBe('[redacted]');
        expect(redactor.redact(`no x${guess}y here`, [guess])).toBe('[redacted]');
      }
    }
  });

  it('answers a short guess at a value the same right or wrong, alone, glued or with punctuation', () => {
    const redactor = new SecretRedactor();
    redactor.rememberSubstituted('REGION', 'us');
    redactor.rememberSubstituted('SEP', '.!');
    for (const guess of ['us', 'eu']) {
      expect(redactor.redact(`region ${guess} is closed`, [guess])).toBe('region [redacted] is closed');
      expect(redactor.redact(`no x${guess}y here`, [guess])).toBe(`no x${guess}y here`);
    }
    for (const guess of ['.!', '?!']) expect(redactor.redact(`sep ${guess} refused`, [guess])).toBe('sep [redacted] refused');
    // A text that is nothing but the caller's punctuation.
    expect(redactor.redact('?', ['?'])).toBe('[redacted]');
    // A letter outside the basic plane is a letter: `a` glued to one does not stand alone.
    expect(redactor.redact('𐐀a and a𐐀, then a', ['a'])).toBe('𐐀a and a𐐀, then [redacted]');
  });

  it('takes out a credential shorter than four characters inside other words too', () => {
    const redactor = new SecretRedactor();
    redactor.remember('ab1');
    expect(redactor.redact('key xab1y refused')).toBe('key x[redacted]y refused');
  });

  it('looks for many short strings of the caller in one walk over a long text', () => {
    const redactor = new SecretRedactor();
    const words = 'word '.repeat(4_000);
    expect(redactor.redact(`${words}? end`, Array.from({ length: 200_000 }, () => '?'))).toBe(`${words}[redacted] end`);
  });

  it('reads the same right or wrong when the server glues its own words to the guess', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    for (const guess of ['sk-live-Q7xZ', 'sk-live-Q7xA']) {
      expect(redactor.redact(`${guess}2abcdefgh!`, [guess])).toBe('[redacted]!');
      expect(redactor.redact(`${guess}2ab!`, [guess])).toBe('[redacted]');
    }
  });

  it('takes out the rest of a key whose start the caller sent', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abcdefgh');
    expect(redactor.redact('key sk-live-Q7xZ2abcdefgh refused', ['sk-l'])).toBe('key [redacted] refused');
  });

  it('leaves nothing of a key the caller\'s text cuts into short pieces', () => {
    const redactor = new SecretRedactor();
    redactor.remember('sk-live-Q7xZ2abc');
    expect(redactor.redact('key sk-live-Q7xZ2abc refused', ['live-Q7xZ'])).toBe('key [redacted] refused');
    expect(redactor.redact('key sk-live-Q7xZ2abc refused', ['Q7xZ2a'])).toBe('key [redacted] refused');
  });

  it("hides what the caller's text leaves of a word, punctuation too, so a guess at a key ending in it reads the same", () => {
    const redactor = new SecretRedactor();
    redactor.remember('abcd!?');
    expect(redactor.redact('key abcd!? refused', ['abcd'])).toBe('key [redacted] refused');
    expect(redactor.redact('key abcd!? refused', ['abce'])).toBe('key [redacted] refused');
  });

  it('counts what is left of a word in characters, so seven with one outside the BMP go too', () => {
    const redactor = new SecretRedactor();
    expect(redactor.redact('key sk-live-Q7xZ\u{10400}bcdefg refused', ['sk-live-Q7xZ'])).toBe('key [redacted] refused');
    expect(redactor.redact('key sk-live-Q7xZ\u{10400}bcdefgh refused', ['sk-live-Q7xZ'])).toBe('key [redacted]\u{10400}bcdefgh refused');
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
