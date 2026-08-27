import { describe, it, expect } from 'vitest';
import { normalizeToolManual } from '../tool-manuals.service.js';

/**
 * The `healthCheck:` block is a URL this SERVER will fetch with the caller's
 * credential attached, unattended, on every save and re-check. That makes it a
 * second fetch target on the same footing as the manual's own `url`, so it is
 * policed by the same SSRF rule — and held to one extra rule of its own: it may
 * not mutate.
 */

const toolFile = (body: string) => `---
name: acme
type: http
url: https://api.acme.test/utcp
headers:
  Authorization: Bearer \${API_KEY}
${body}---
notes
`;

const parse = (body: string) => normalizeToolManual('acme', 'Plugins/acme.tool', toolFile(body));

describe('`.tool` healthCheck', () => {
  it('is absent when nothing is declared — the tool is simply unverifiable', () => {
    expect(parse('').healthCheck).toBeUndefined();
  });

  it('inherits the manual\'s headers, so a one-line declaration still authenticates', () => {
    // This is what makes the common case cheap: the credential already lives in
    // `headers`, and re-typing it on the probe would be a chance to get it wrong.
    expect(parse('healthCheck:\n  url: https://api.acme.test/me\n').healthCheck).toEqual({
      url: 'https://api.acme.test/me',
      headers: { Authorization: 'Bearer ${API_KEY}' },
    });
  });

  it('keeps its own headers when it declares them', () => {
    const hc = parse('healthCheck:\n  url: https://api.acme.test/me\n  headers:\n    X-Key: ${API_KEY}\n').healthCheck;
    expect(hc?.headers).toEqual({ 'X-Key': '${API_KEY}' });
  });

  it("inherits an INLINE manual's headers too, which only the url branch used to set", () => {
    // `descriptor.headers` is populated only on the url-bearing branch, so
    // inheriting from it left an inline probe sending nothing and testing an
    // unauthenticated request — a pass that proved the opposite of what it claimed.
    const inline = normalizeToolManual(
      'acme',
      'Plugins/acme.tool',
      `---
name: acme
type: inline
headers:
  Authorization: Bearer \${API_KEY}
healthCheck:
  url: https://api.acme.test/me
tools: []
---
`,
    );
    expect(inline.healthCheck?.headers).toEqual({ Authorization: 'Bearer ${API_KEY}' });
  });

  it('refuses a method that could mutate', () => {
    // Silently downgrading POST to GET would leave the author believing they had
    // declared something we are not doing.
    expect(() => parse('healthCheck:\n  url: https://api.acme.test/me\n  method: POST\n')).toThrow(
      /may not mutate/,
    );
  });

  it('refuses a probe pointed at an internal host', () => {
    expect(() => parse('healthCheck:\n  url: http://169.254.169.254/latest/meta-data\n')).toThrow(
      /not allowed/,
    );
  });

  it('refuses a declaration with no url', () => {
    expect(() => parse('healthCheck:\n  method: GET\n')).toThrow(/must have a `url`/);
  });

  /**
   * A local-only `.tool` is never fetched by this server, so its probe is exempt
   * from the guard for exactly the same reason its `url` is.
   */
  it('exempts a local-only tool, as it does for the manual url', () => {
    const local = normalizeToolManual(
      'acme',
      'Plugins/acme.tool',
      `---
name: acme
type: http
remote: false
url: http://localhost:9000/utcp
healthCheck:
  url: http://localhost:9000/me
---
`,
    );
    expect(local.healthCheck?.url).toBe('http://localhost:9000/me');
  });
});
