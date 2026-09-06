import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT, configureKbLayout } from '@bevel-software/platform-shared';
import { KbPluginSource } from '../kb-plugin-source.js';

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

describe('KbPluginSource — bundles', () => {
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
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
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
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
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

  it('skips a registry server that could not work, and the second of two declarations with one id', async () => {
    await write(
      'configs/mcp/registry.json',
      JSON.stringify({
        servers: [
          { id: 'jira', config: { command: 'npx', args: ['-y', 'jira-mcp'] } },
          { id: 'jira', config: { command: 'something-else' } },
          { id: 'no-url', config: { type: 'http' } },
          { id: 'blank-url', config: { url: '  ' } },
          { id: 'odd', config: { type: 'grpc', url: 'https://x' } },
          // A stray blank url beside a real command is still a stdio server.
          { id: 'launch', config: { type: 'stdio', command: 'run-it', url: '' } },
          { id: 'untyped-launch', config: { command: 'run-it', url: '' } },
        ],
        profiles: [{ id: 'global', servers: ['jira', 'no-url', 'blank-url', 'odd', 'launch', 'untyped-launch'] }],
      }),
    );
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    const example = plugins.find((p) => p.name === 'example-plugin')!;
    expect(example.mcpServers).toEqual({
      jira: { type: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'] },
      launch: { type: 'stdio', command: 'run-it' },
      'untyped-launch': { type: 'stdio', command: 'run-it' },
    });
    expect(warnings.some((w) => w.includes('"jira" is declared twice'))).toBe(true);
    expect(warnings.some((w) => w.includes('"no-url" has transport "http" but no url'))).toBe(true);
    expect(warnings.some((w) => w.includes('"blank-url" has neither a url nor a command'))).toBe(true);
    expect(warnings.some((w) => w.includes('"odd" has an unknown transport'))).toBe(true);
  });

  it('cuts an extends cycle instead of hanging, and keeps what it collected', async () => {
    await write('plugins/loop/plugin.bundle.json', JSON.stringify({ name: 'loop', mcpProfile: 'loop-a' }));
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    const loop = plugins.find((p) => p.name === 'loop')!;
    expect(loop.mcpServers).toEqual({ 'flat-http': { type: 'streamable-http', url: 'https://flat.example' } });
    expect(warnings.some((w) => w.includes('cycle'))).toBe(true);
  });

  it('a missing registry leaves the plugins standing, servers-less, with a warning per profile', async () => {
    await fs.rm(path.join(kb, 'configs'), { recursive: true });
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    expect(plugins.find((p) => p.name === 'example-plugin')!.mcpServers).toBeNull();
    expect(warnings.some((w) => w.includes('no registry'))).toBe(true);
  });
});

describe('KbPluginSource — one walk, both shapes', () => {
  let kb: string;
  const write = async (rel: string, text: string) => {
    const abs = path.join(kb, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  beforeEach(async () => {
    kb = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-mixed-'));
  });
  afterEach(async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT });
    await fs.rm(kb, { recursive: true, force: true });
  });

  it('reads native manifests and bundles side by side, at any depth, and stops at a plugin folder', async () => {
    // A native plugin directly under the root, with a skill inside — the
    // skill folder must not be mistaken for a nested plugin.
    await write('Plugins/GTM/plugin.json', JSON.stringify({ name: 'gtm', extensions: { 'software.bevel.hexis': { skills: ['Skills/Eng'] } } }));
    await write('Plugins/GTM/access.md', '---\n---\nread:\n  - everyone\n');
    await write('Plugins/GTM/skills/outreach/SKILL.md', '---\ndescription: x\n---\n');
    await write('Plugins/GTM/skills/outreach/plugin.json', '{"name":"not-a-plugin"}');
    // A pre-manifest folder (access.md only) directly under the root: NOT a
    // plugin to discovery — the boot step gives it a manifest first.
    await write('Plugins/Legacy/access.md', '---\n---\nread:\n  - everyone\n');
    // A bundle three folders down, and a native manifest two folders down.
    await write('Plugins/functional/cluster/example/plugin.bundle.json', JSON.stringify({ name: 'example', sourceSkillRoots: ['Skills/x'] }));
    await write('Plugins/teams/deep/plugin.json', JSON.stringify({ name: 'deep' }));
    // A folder with BOTH files: the manifest wins.
    await write('Plugins/Both/plugin.json', JSON.stringify({ name: 'both' }));
    await write('Plugins/Both/plugin.bundle.json', JSON.stringify({ name: 'both-bundle', sourceSkillRoots: ['Skills/y'] }));
    // A deeper folder that is only a container: walked through, never a plugin.
    await write('Plugins/teams/empty-container/README.md', 'nothing here');
    // A level-one scope that carries an access.md of its own AND plugins
    // beneath: a container, not a plugin.
    await write('Plugins/functional/access.md', '---\n---\nread:\n  - everyone\n');

    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    // Folders are visited in locale order (case-insensitive), depth first.
    // Position means nothing: only the two files make a plugin.
    expect(plugins.map((p) => [p.name, p.folder, p.linksAreManaged, p.exists])).toEqual([
      ['Both', 'Plugins/Both', true, false],
      ['example', 'Plugins/functional/cluster/example', false, true],
      ['GTM', 'Plugins/GTM', true, true],
      ['deep', 'Plugins/teams/deep', true, false],
    ]);
    expect(plugins.find((p) => p.name === 'GTM')?.linkedRoots).toEqual(['Skills/Eng']);
    expect(plugins.find((p) => p.name === 'Both')?.linkedRoots).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('keeps the first of two plugins whose names fold to one slug, and says which was skipped', async () => {
    await write('Plugins/a/GTM/plugin.json', '{}');
    await write('Plugins/b/GTM/plugin.json', '{}');
    // Different spelling, same manifest slug: still one plugin.
    await write('Plugins/c/gtm/plugin.json', '{}');
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    expect(plugins.map((p) => p.folder)).toEqual(['Plugins/a/GTM']);
    expect(warnings).toEqual([
      'Plugins/b/GTM: plugin name "GTM" is already used by Plugins/a/GTM — plugin skipped',
      'Plugins/c/gtm: plugin name "gtm" is already used by Plugins/a/GTM — plugin skipped',
    ]);
  });

  it('a knowledge base without a plugins root has no plugins and no complaint', async () => {
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    expect(plugins).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
