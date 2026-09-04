import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT, configureKbLayout } from '@bevel-software/platform-shared';
import { BundlePluginSource } from '../bundle.source.js';

/**
 * The customer's tree, in their own root names (lowercase `plugins/` and
 * `skills/`), with the four ownership scopes they use and a registry with an
 * `extends` chain. The dialect must read it as plugins that link skills.
 */

const REGISTRY = {
  servers: [
    { id: 'jira', name: 'Jira', config: { command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_URL: 'https://j' } } },
    { id: 'confluence', name: 'Confluence', config: { type: 'http', url: 'https://mcp.confluence.example' } },
    { id: 'flat-http', type: 'http', url: 'https://flat.example' },
  ],
  profiles: [
    { id: 'base', servers: ['jira'] },
    { id: 'global', servers: ['confluence', 'ghost'], extends: 'base' },
    { id: 'loop-a', servers: ['flat-http'], extends: 'loop-b' },
    { id: 'loop-b', servers: [], extends: 'loop-a' },
    { id: 'empty', servers: [] },
  ],
};

describe('BundlePluginSource', () => {
  let kb: string;
  const write = async (rel: string, text: string) => {
    const abs = path.join(kb, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  beforeEach(async () => {
    kb = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bundle-'));
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    await write('configs/mcp/registry.json', JSON.stringify(REGISTRY));
    await write(
      'plugins/functional/cluster-a/example-plugin/plugin.bundle.json',
      JSON.stringify({
        name: 'example-plugin',
        version: '1.3.1',
        description: 'What this plugin is for',
        mcpProfile: 'global',
        interface: { displayName: 'Example Plugin', category: 'Productivity' },
        sourceSkillRoots: ['skills/departments/engineering/shared/cluster-a', 'skills/functional/cluster-a/one-skill'],
      }),
    );
    await write(
      'plugins/departments/business/finance/close/plugin.bundle.json',
      JSON.stringify({ name: 'close', version: '0.1.0', mcpProfile: 'empty', sourceSkillRoots: ['skills/departments/business/finance'] }),
    );
    await write('plugins/departments/engineering/shared/unnamed/plugin.bundle.json', JSON.stringify({ sourceSkillRoots: ['../escape', 'skills/x'] }));
    await write('plugins/broken/plugin.bundle.json', '{ not json');
  });
  afterEach(async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT });
    await fs.rm(kb, { recursive: true, force: true });
  });

  it('finds bundles at any depth and reads them as plugins that link skill roots', async () => {
    const { plugins, warnings } = await new BundlePluginSource().discover(kb);
    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(['close', 'example-plugin', 'unnamed']);

    const example = byName.get('example-plugin')!;
    expect(example.folder).toBe('plugins/functional/cluster-a/example-plugin');
    expect(example.relFolder).toBe('functional/cluster-a/example-plugin');
    expect(example.exists).toBe(true);
    expect(example.linksAreManaged).toBe(false);
    expect(example.linkedRoots).toEqual([
      'skills/departments/engineering/shared/cluster-a',
      'skills/functional/cluster-a/one-skill',
    ]);
    expect(example.manifest).toEqual({
      name: 'example-plugin',
      version: '1.3.1',
      description: 'What this plugin is for',
      displayName: 'Example Plugin',
    });
    // An unnamed bundle takes its folder's name; a bad root is dropped with a warning.
    expect(byName.get('unnamed')!.linkedRoots).toEqual(['skills/x']);
    expect(warnings.some((w) => w.includes('../escape'))).toBe(true);
    expect(warnings.some((w) => w.includes('plugins/broken'))).toBe(true);
  });

  it('expands mcpProfile through the registry, following extends and reporting unknowns', async () => {
    const { plugins, warnings } = await new BundlePluginSource().discover(kb);
    const example = plugins.find((p) => p.name === 'example-plugin')!;
    expect(example.mcpServers).toEqual({
      confluence: { type: 'streamable-http', url: 'https://mcp.confluence.example' },
      jira: { type: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_URL: 'https://j' } },
    });
    expect(JSON.parse(example.mcpJsonText!)).toEqual({ mcpServers: example.mcpServers });
    expect(warnings.some((w) => w.includes('unknown server "ghost"'))).toBe(true);
    // An empty profile is valid and selects nothing.
    expect(plugins.find((p) => p.name === 'close')!.mcpServers).toBeNull();
  });

  it('cuts an extends cycle instead of hanging, and keeps what it collected', async () => {
    await write('plugins/loop/plugin.bundle.json', JSON.stringify({ name: 'loop', mcpProfile: 'loop-a' }));
    const { plugins, warnings } = await new BundlePluginSource().discover(kb);
    const loop = plugins.find((p) => p.name === 'loop')!;
    expect(loop.mcpServers).toEqual({ 'flat-http': { type: 'streamable-http', url: 'https://flat.example' } });
    expect(warnings.some((w) => w.includes('cycle'))).toBe(true);
  });

  it('a missing registry leaves the plugins standing, servers-less, with a warning per profile', async () => {
    await fs.rm(path.join(kb, 'configs'), { recursive: true });
    const { plugins, warnings } = await new BundlePluginSource().discover(kb);
    expect(plugins.find((p) => p.name === 'example-plugin')!.mcpServers).toBeNull();
    expect(warnings.some((w) => w.includes('no registry'))).toBe(true);
  });
});
