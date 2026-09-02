import { describe, expect, it, vi, afterEach } from 'vitest';
import { descriptorsFromMcpJson } from '../mcp-json-discovery.js';

afterEach(() => vi.restoreAllMocks());

const MANIFEST = JSON.stringify({
  name: 'gtm',
  extensions: {
    'software.bevel.hexis': {
      mcpServers: {
        vendor: {
          headers: { Authorization: 'Bearer ${VENDOR_KEY}' },
          variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
          description: 'Vendor API',
        },
        localbox: { local: true },
      },
    },
  },
});

describe('descriptorsFromMcpJson', () => {
  it('synthesizes descriptors keyed by server name, path at mcp.json', () => {
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({ mcpServers: { notion: { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' } } }),
      null,
    );
    expect(out).toEqual([
      {
        slug: 'notion',
        name: 'notion',
        path: 'Plugins/GTM/mcp.json',
        type: 'mcp',
        url: 'https://mcp.notion.com/mcp',
      },
    ]);
  });

  it('refuses an sse server rather than rebuilding it as a transport it is not', () => {
    // The pinned MCP client has no sse transport; emitting `http` for an sse
    // server configures a handshake the server does not speak.
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({ mcpServers: { legacy: { type: 'sse', url: 'https://mcp.legacy.example/sse' } } }),
      null,
    );
    expect(out).toEqual([]);
  });

  it('merges extension auth over mcp.json literals and carries variables + description', () => {
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({
        mcpServers: { vendor: { type: 'streamable-http', url: 'https://v.example/mcp', headers: { 'X-V': '2' } } },
      }),
      MANIFEST,
    );
    expect(out[0]).toMatchObject({
      headers: { 'X-V': '2', Authorization: 'Bearer ${VENDOR_KEY}' },
      variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
      description: 'Vendor API',
    });
  });

  it('marks extension-flagged servers and every stdio server local-only', () => {
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({
        mcpServers: {
          localbox: { type: 'streamable-http', url: 'http://localhost:9000/mcp' },
          indexer: { type: 'stdio', command: 'npx', args: ['-y', 'indexer'] },
        },
      }),
      MANIFEST,
    );
    expect(out.find((d) => d.name === 'localbox')?.remote).toBe(false);
    const stdio = out.find((d) => d.name === 'indexer');
    expect(stdio?.remote).toBe(false);
    expect(stdio?.stdio).toEqual({ command: 'npx', args: ['-y', 'indexer'], env: undefined, cwd: undefined });
  });

  it('skips a malformed entry without losing its siblings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({
        mcpServers: {
          'Bad Name!': { type: 'streamable-http', url: 'https://x.example' },
          nourl: { type: 'streamable-http' },
          odd: { type: 'carrier-pigeon' },
          ok: { type: 'streamable-http', url: 'https://ok.example/mcp' },
        },
      }),
      null,
    );
    expect(out.map((d) => d.name)).toEqual(['ok']);
  });

  it('ignores malformed extension headers instead of spreading them into keys', () => {
    // A string spread into the merge would scatter its indices ('0', '1', …)
    // into header names; a malformed extension must cost its own data only.
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({
        mcpServers: { vendor: { type: 'streamable-http', url: 'https://v.example/mcp', headers: { 'X-V': '2' } } },
      }),
      JSON.stringify({
        name: 'gtm',
        extensions: { 'software.bevel.hexis': { mcpServers: { vendor: { headers: 'Bearer oops' } } } },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].headers).toEqual({ 'X-V': '2' });
  });

  it('skips a server whose variables declaration is malformed, keeping siblings', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A dropped declaration would silently re-scope a credential (undeclared
    // defaults to the shared admin row), so a bad entry takes the SERVER
    // offline — never just the entry, and never its siblings.
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({
        mcpServers: {
          vendor: { type: 'streamable-http', url: 'https://v.example/mcp' },
          ok: { type: 'streamable-http', url: 'https://ok.example/mcp' },
        },
      }),
      JSON.stringify({
        name: 'gtm',
        extensions: {
          'software.bevel.hexis': {
            mcpServers: { vendor: { variables: [{ name: 'bad name!', scope: 'user' }] } },
          },
        },
      }),
    );
    expect(out.map((d) => d.name)).toEqual(['ok']);
  });

  it('applies the .tool declaration rules: no reserved names, no duplicates, gated OAuth URLs, string authParams', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const declare = (variables: unknown) =>
      descriptorsFromMcpJson(
        'GTM',
        JSON.stringify({ mcpServers: { vendor: { type: 'streamable-http', url: 'https://v.example/mcp' } } }),
        JSON.stringify({
          name: 'gtm',
          extensions: { 'software.bevel.hexis': { mcpServers: { vendor: { variables } } } },
        }),
      ).map((d) => d.name);
    // A re-declared platform-seeded name would shadow the seeding; a
    // duplicate makes scope resolution order-dependent.
    expect(declare([{ name: 'CONNECTION_KEY', scope: 'user' }])).toEqual([]);
    expect(declare([{ name: 'K', scope: 'user' }, { name: 'K', scope: 'admin' }])).toEqual([]);
    const oauth = { tokenUrl: 'https://v.example/token', clientId: 'c' };
    // Same https + SSRF gate the .tool parser runs on OAuth endpoints.
    expect(declare([{ name: 'T', scope: 'user', oauth: { ...oauth, authorizationUrl: 'http://v.example/auth' } }])).toEqual([]);
    expect(declare([{ name: 'T', scope: 'user', oauth: { ...oauth, authorizationUrl: 'https://169.254.169.254/auth' } }])).toEqual([]);
    // authParams travel verbatim as query params — non-strings are malformed.
    expect(
      declare([{ name: 'T', scope: 'user', oauth: { ...oauth, authorizationUrl: 'https://v.example/auth', authParams: { p: 1 } } }]),
    ).toEqual([]);
    expect(
      declare([{ name: 'T', scope: 'user', oauth: { ...oauth, authorizationUrl: 'https://v.example/auth', authParams: { p: 'x' } } }]),
    ).toEqual(['vendor']);
    // `clientId` must be non-empty after trimming, as in the `.tool` parser:
    // a whitespace-only value would pass discovery only to fail the owner's
    // client-secret setup later with "clientId is required".
    expect(
      declare([{ name: 'T', scope: 'user', oauth: { tokenUrl: 'https://v.example/token', authorizationUrl: 'https://v.example/auth', clientId: '   ' } }]),
    ).toEqual([]);
  });

  it('trims a padded oauth clientId like the .tool parser does', () => {
    const out = descriptorsFromMcpJson(
      'GTM',
      JSON.stringify({ mcpServers: { vendor: { type: 'streamable-http', url: 'https://v.example/mcp' } } }),
      JSON.stringify({
        name: 'gtm',
        extensions: {
          'software.bevel.hexis': {
            mcpServers: {
              vendor: {
                variables: [
                  {
                    name: 'T',
                    scope: 'user',
                    oauth: { authorizationUrl: 'https://v.example/auth', tokenUrl: 'https://v.example/token', clientId: '  c-1  ' },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    expect(out[0]?.variables?.[0]?.oauth?.clientId).toBe('c-1');
  });

  it('accepts a client-id-only sign-in (endpoints discovered later), refuses half a pair, carries pkce/resource', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const declare = (oauth: unknown) =>
      descriptorsFromMcpJson(
        'GTM',
        JSON.stringify({ mcpServers: { vendor: { type: 'streamable-http', url: 'https://v.example/mcp' } } }),
        JSON.stringify({
          name: 'gtm',
          extensions: {
            'software.bevel.hexis': { mcpServers: { vendor: { variables: [{ name: 'T', scope: 'user', oauth }] } } },
          },
        }),
      )[0]?.variables?.[0]?.oauth;
    // An MCP server publishes its endpoints — the client id alone is a complete declaration here.
    expect(declare({ clientId: 'c' })).toEqual({ clientId: 'c' });
    // …but half a pair is a broken declaration, not a discoverable one.
    expect(declare({ clientId: 'c', authorizationUrl: 'https://v.example/auth' })).toBeUndefined();
    expect(declare({ clientId: 'c', tokenUrl: 'https://v.example/token' })).toBeUndefined();
    // An emptied editor field reads as absent, not as a malformed URL.
    expect(declare({ clientId: 'c', authorizationUrl: '', tokenUrl: ' ' })).toEqual({ clientId: 'c' });
    // PKCE is on by default: only the opt-out is stored, and it must be a boolean.
    expect(declare({ clientId: 'c', pkce: true })).toEqual({ clientId: 'c' });
    expect(declare({ clientId: 'c', pkce: false })).toEqual({ clientId: 'c', pkce: false });
    expect(declare({ clientId: 'c', pkce: 'no' })).toBeUndefined();
    // The resource indicator names the remote server — same https/SSRF bar as the endpoints.
    expect(declare({ clientId: 'c', resource: 'https://v.example/mcp' })).toEqual({
      clientId: 'c',
      resource: 'https://v.example/mcp',
    });
    expect(declare({ clientId: 'c', resource: 'http://v.example/mcp' })).toBeUndefined();
    expect(declare({ clientId: 'c', resource: 'https://169.254.169.254/mcp' })).toBeUndefined();
    // A secret in a portable file never loads — same keys the `.tool` parser
    // refuses, and the whole server is dropped rather than the key ignored.
    expect(declare({ clientId: 'c', clientSecret: 'shh' })).toBeUndefined();
    expect(declare({ clientId: 'c', client_secret: 'shh' })).toBeUndefined();
    expect(declare({ clientId: 'c', secret: 'shh' })).toBeUndefined();
  });

  it('yields nothing for an unparsable file, quietly for an absent extensions block', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(descriptorsFromMcpJson('GTM', '{ not json', null)).toEqual([]);
    expect(
      descriptorsFromMcpJson('GTM', JSON.stringify({ mcpServers: {} }), '{ also not json'),
    ).toEqual([]);
  });
});
