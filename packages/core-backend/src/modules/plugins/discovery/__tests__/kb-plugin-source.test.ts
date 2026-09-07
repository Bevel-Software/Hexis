import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    // A bundle whose name is not its folder's, with no display name of its own.
    await write('plugins/departments/business/finance/ledger-folder/plugin.bundle.json', JSON.stringify({ name: 'ledger' }));
    await write('plugins/broken/plugin.bundle.json', '{ not json');
  });
  afterEach(async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT });
    await fs.rm(kb, { recursive: true, force: true });
  });

  it('finds bundles at any depth and reads them as plugins that link skill roots', async () => {
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect([...byName.keys()].sort()).toEqual(['close', 'example-plugin', 'ledger', 'unnamed']);
    // The shared contract: a declared display name, else the FOLDER — never the identity.
    expect(byName.get('example-plugin')!.displayName).toBe('Example Plugin');
    expect(byName.get('ledger')!.displayName).toBe('ledger-folder');

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
          // The client speaks no sse; shipping it would install a server nothing can use.
          { id: 'events', config: { type: 'sse', url: 'https://events.example' } },
          // A name that cannot be a server name (the secret namespace, the route slug).
          { id: 'Bad Id', config: { command: 'x' } },
        ],
        profiles: [
          { id: 'global', servers: ['jira', 'no-url', 'blank-url', 'odd', 'launch', 'untyped-launch', 'events', 'Bad Id'] },
        ],
      }),
    );
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    const example = plugins.find((p) => p.name === 'example-plugin')!;
    expect(example.mcpServers).toEqual({
      jira: { type: 'stdio', command: 'npx', args: ['-y', 'jira-mcp'] },
      launch: { type: 'stdio', command: 'run-it', args: [] },
      'untyped-launch': { type: 'stdio', command: 'run-it', args: [] },
    });
    expect(warnings.some((w) => w.includes('"jira" is declared twice'))).toBe(true);
    // The reasons are the shared judgement's — the same words an mcp.json entry gets.
    expect(warnings.some((w) => w.includes('"no-url" no url'))).toBe(true);
    expect(warnings.some((w) => w.includes('"blank-url" has neither a url nor a command'))).toBe(true);
    expect(warnings.some((w) => w.includes('"odd" unknown type "grpc"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"events" the MCP client has no `sse` transport'))).toBe(true);
    expect(warnings.some((w) => w.includes('"Bad Id" the name is the secret namespace'))).toBe(true);
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
      ['both', 'Plugins/Both', true, false],
      ['example', 'Plugins/functional/cluster/example', false, true],
      ['gtm', 'Plugins/GTM', true, true],
      ['deep', 'Plugins/teams/deep', true, false],
    ]);
    expect(plugins.find((p) => p.name === 'gtm')?.linkedRoots).toEqual(['Skills/Eng']);
    expect(plugins.find((p) => p.name === 'both')?.linkedRoots).toEqual([]);
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
      'Plugins/b/GTM: plugin name "gtm" is already used by Plugins/a/GTM — plugin skipped',
      'Plugins/c/gtm: plugin name "gtm" is already used by Plugins/a/GTM — plugin skipped',
    ]);
  });

  it('the manifest name is the identity and the folder only the label — unless the name is no identifier', async () => {
    await write('Plugins/GTM/plugin.json', JSON.stringify({ name: 'go-to-market', displayName: 'Go To Market' }));
    await write('Plugins/Numeric/plugin.json', '{"name":42}');
    await write('Plugins/Ops/plugin.json', JSON.stringify({ name: 'Not An Identifier' }));
    await write('Plugins/Plain/plugin.json', '{}');
    const { plugins, warnings } = await new KbPluginSource().discover(kb);
    expect(plugins.map((p) => [p.name, p.displayName, p.folder])).toEqual([
      ['go-to-market', 'Go To Market', 'Plugins/GTM'],
      ['numeric', 'Numeric', 'Plugins/Numeric'],
      ['ops', 'Ops', 'Plugins/Ops'],
      ['plain', 'Plain', 'Plugins/Plain'],
    ]);
    // Every PRESENT name that is no identifier is said out loud — whatever its type.
    expect(warnings).toEqual([
      'Plugins/Numeric/plugin.json names 42, which is not a plugin identifier (lowercase kebab-case) — the folder stands in as "numeric"',
      'Plugins/Ops/plugin.json names "Not An Identifier", which is not a plugin identifier (lowercase kebab-case) — the folder stands in as "ops"',
    ]);
  });

  it('counts what exists but could not be read — a folder, a manifest — so a writer can tell a hole from an absence', async () => {
    await write('Plugins/GTM/plugin.json', '{"name":"gtm"}');
    // An optional file that cannot be read carries no identity: a warning, never a hole.
    await write('Plugins/GTM/mcp.json', '{"mcpServers":{}}');
    await write('Plugins/Hidden/plugin.json', '{"name":"hidden-identity"}');
    await write('Plugins/teams/Deep/plugin.json', '{"name":"deep"}');
    const realReaddir = fs.readdir;
    const realReadFile = fs.readFile;
    const eacces = () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const spies = [
      vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
        String(dir).endsWith('teams') ? eacces() : (realReaddir as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never),
      vi.spyOn(fs, 'readFile').mockImplementation(((file: string, opts: unknown) =>
        (String(file).includes('Hidden') && String(file).endsWith('plugin.json')) || String(file).endsWith('mcp.json')
          ? eacces()
          : (realReadFile as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never),
    ];
    try {
      const { plugins, warnings, unreadable } = await new KbPluginSource().discover(kb);
      // The container could not be listed: nothing beneath it was seen. The
      // manifest could not be read: an identity nobody could see, so the
      // plugin is not listed under a guessed one. Both are holes, not absence.
      expect(unreadable).toEqual(['Plugins/Hidden/plugin.json', 'Plugins/teams']);
      expect(plugins.map((p) => p.name)).toEqual(['gtm']);
      expect(warnings.some((w) => w.startsWith('Plugins/Hidden/plugin.json could not be read'))).toBe(true);
      expect(warnings.some((w) => w.startsWith('Plugins/teams: could not be read'))).toBe(true);
      // The unreadable mcp.json is said, and GTM stands without it.
      expect(warnings.some((w) => w.startsWith('Plugins/GTM/mcp.json could not be read'))).toBe(true);
      expect(plugins[0]!.mcpServers).toBeNull();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('an identity file that cannot even be probed is a hole: the folder is neither listed nor descended into', async () => {
    await write('Plugins/GTM/plugin.json', '{"name":"gtm"}');
    await write('Plugins/Hidden/plugin.json', '{"name":"hidden"}');
    // Beneath the unprobeable folder: must stay unseen, not surface as a plugin of its own.
    await write('Plugins/Hidden/Sub/plugin.json', '{"name":"sub"}');
    const realStat = fs.stat;
    const spy = vi.spyOn(fs, 'stat').mockImplementation(((file: string, opts: unknown) =>
      String(file).endsWith(path.join('Hidden', 'plugin.json'))
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (realStat as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never);
    try {
      const { plugins, unreadable } = await new KbPluginSource().discover(kb);
      expect(unreadable).toEqual(['Plugins/Hidden/plugin.json']);
      expect(plugins.map((p) => p.name)).toEqual(['gtm']);
    } finally {
      spy.mockRestore();
    }
  });

  it('a manifest that vanishes between the probe and the read is no plugin — never one under a guessed name', async () => {
    await write('Plugins/GTM/plugin.json', '{"name":"gtm"}');
    await write('Plugins/Gone/plugin.json', '{"name":"gone"}');
    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: string, opts: unknown) =>
      String(file).endsWith(path.join('Gone', 'plugin.json'))
        ? Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
        : (realReadFile as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never);
    try {
      const { plugins, unreadable } = await new KbPluginSource().discover(kb);
      expect(plugins.map((p) => p.name)).toEqual(['gtm']);
      expect(unreadable).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a knowledge base without a plugins root has no plugins and no complaint', async () => {
    const { plugins, warnings, unreadable } = await new KbPluginSource().discover(kb);
    expect(plugins).toEqual([]);
    expect(warnings).toEqual([]);
    expect(unreadable).toEqual([]);
  });
});
