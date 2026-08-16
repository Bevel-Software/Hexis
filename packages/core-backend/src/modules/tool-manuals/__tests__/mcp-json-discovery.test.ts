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

  it('yields nothing for an unparsable file, quietly for an absent extensions block', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(descriptorsFromMcpJson('GTM', '{ not json', null)).toEqual([]);
    expect(
      descriptorsFromMcpJson('GTM', JSON.stringify({ mcpServers: {} }), '{ also not json'),
    ).toEqual([]);
  });
});
