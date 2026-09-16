import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expandProfile, parseRegistry } from '../discovery/bundle-dialect/registry.js';
import { readBundlePlugin } from '../discovery/bundle-dialect/bundle.source.js';

/**
 * The customer's registry and bundle, read as they mean them: a server is
 * CALLED by its `name` (the `mcp__<name>__*` namespace skills are written
 * against) and selected by its `id`; every field of a server the platform
 * does not know rides along; a server the registry could not keep is named
 * with the reason wherever a profile asks for it; and what a bundle says
 * about itself beyond name, version and description survives to the
 * compiled plugin. Driven through the two public readers, on crafted input.
 */

const registryText = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    servers: [
      { id: 'ado', name: 'ado', config: { command: 'npx', args: ['-y', '@azure-devops/mcp', 'acme'], startup_timeout_sec: 120 } },
      { id: 'figma-stdio', name: 'figma', config: { command: 'npx', args: ['-y', 'figma-mcp'] } },
      { id: 'figma-remote', name: 'figma', config: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
      { id: 'docs', name: 'acme-docs', config: { command: 'node', args: ['server.js', { $fromFile: 'x.json' }] } },
    ],
    profiles: [
      { id: 'global', servers: ['ado', 'figma-stdio', 'docs'] },
      { id: 'remote', extends: 'global', servers: ['figma-remote'] },
    ],
    ...extra,
  });

describe('registry: servers are called by name, selected by id', () => {
  it('keys an expanded profile by the running name, with the id as the name when none is given', () => {
    const registry = parseRegistry(
      JSON.stringify({
        servers: [
          { id: 'figma-stdio', name: 'figma', config: { command: 'npx', args: ['-y', 'figma-mcp'] } },
          { id: 'jira', config: { command: 'npx', args: ['-y', 'jira-mcp'] } },
        ],
        profiles: [{ id: 'global', servers: ['figma-stdio', 'jira'] }],
      }),
    );
    const { mcpServers, warnings } = expandProfile(registry, 'global');
    expect(Object.keys(mcpServers).sort()).toEqual(['figma', 'jira']);
    expect(warnings).toEqual([]);
  });

  it('carries every field it does not read — the customer\'s startup_timeout_sec survives', () => {
    const registry = parseRegistry(registryText());
    const { mcpServers } = expandProfile(registry, 'global');
    expect(mcpServers.ado).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@azure-devops/mcp', 'acme'],
      startup_timeout_sec: 120,
    });
  });

  it('two transports of one server: a profile picks one, and picking both is a reported conflict the nearer profile wins', () => {
    const registry = parseRegistry(registryText());
    // `remote` extends `global`: its own figma-remote is nearer than global's figma-stdio.
    const remote = expandProfile(registry, 'remote');
    expect(remote.mcpServers.figma).toMatchObject({ type: 'streamable-http', url: 'https://mcp.figma.com/mcp' });
    expect(remote.warnings).toContainEqual(
      expect.stringContaining('selects both "figma-remote" and "figma-stdio", which are both named "figma" — "figma-stdio" left out'),
    );
    const global = expandProfile(registry, 'global');
    expect(global.mcpServers.figma).toMatchObject({ type: 'stdio', command: 'npx' });
  });

  it('names a selected server the registry could not keep, with the reason, where the profile asks for it', () => {
    const registry = parseRegistry(registryText());
    expect(registry.rejected.get('docs')).toBe('args must be a list of strings');
    const { mcpServers, warnings } = expandProfile(registry, 'global');
    expect(mcpServers['acme-docs']).toBeUndefined();
    expect(warnings).toContainEqual(
      'registry.json: profile "global" selects server "docs", which was left out — args must be a list of strings',
    );
  });

  it('a name a client cannot key on does not lose the server: it runs under its id, and the author is told', () => {
    const registry = parseRegistry(
      JSON.stringify({
        servers: [{ id: 'ok-id', name: 'Not A Name', config: { command: 'x' } }],
        profiles: [{ id: 'p', servers: ['ok-id'] }],
      }),
    );
    expect(registry.warnings).toEqual([
      'registry.json: server "ok-id" is named "Not A Name", which cannot be a server name (lowercase alphanumeric with `_`/`-`) — it runs as "ok-id"',
    ]);
    expect(Object.keys(expandProfile(registry, 'p').mcpServers)).toEqual(['ok-id']);
  });

  it('a rejected server carries the reason the entry failed, not its name', () => {
    const registry = parseRegistry(
      JSON.stringify({ servers: [{ id: 'docs', name: 'acme-docs', config: { command: 'node', args: [{ x: 1 }] } }] }),
    );
    expect(registry.rejected.get('docs')).toBe('args must be a list of strings');
  });
});

describe('bundle: what it says about itself survives', () => {
  it('carries author, keywords and the interface block into the manifest, beside name, version and description', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bundle-'));
    try {
      const dir = path.join(root, 'plugins', 'ado');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'plugin.bundle.json'),
        JSON.stringify({
          name: 'ado',
          version: '1.3.5',
          description: 'Azure DevOps skills.',
          author: { name: 'acme' },
          keywords: ['ado', 'mcp'],
          interface: { displayName: 'Azure DevOps', category: 'Productivity', brandColor: '#2563EB', defaultPrompt: ['Show my work.'] },
          sourceSkillRoots: ['skills/ado'],
        }),
      );
      const warnings: string[] = [];
      const plugin = await readBundlePlugin(dir, 'plugins/ado', 'ado', null, warnings, []);
      expect(plugin?.manifest).toEqual({
        name: 'ado',
        version: '1.3.5',
        description: 'Azure DevOps skills.',
        displayName: 'Azure DevOps',
        author: { name: 'acme' },
        keywords: ['ado', 'mcp'],
        interface: { displayName: 'Azure DevOps', category: 'Productivity', brandColor: '#2563EB', defaultPrompt: ['Show my work.'] },
      });
      expect(plugin?.displayName).toBe('Azure DevOps');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
