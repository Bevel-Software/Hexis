import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateGroupsToPlugins } from '../plugins-migration.js';

let repo: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(repo, rel), 'utf-8');
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(repo, rel));
    return true;
  } catch {
    return false;
  }
}

/** A knowledge base as every deployment looks today, pre-migration. */
async function seedLegacyKb(): Promise<void> {
  await write('Groups/GTM/access.md', '---\nread:\n  - everyone\n---\nwrite:\n  - Admin\n');
  await write('Groups/GTM/outreach/SKILL.md', '---\ndescription: Outreach.\n---\n# Outreach\n');
  await write('Groups/GTM/outreach/scripts/run.py', 'print("hi")\n');
  await write(
    'Groups/GTM/notion.tool',
    JSON.stringify({ name: 'notion', type: 'mcp', url: 'https://mcp.notion.com/mcp' }, null, 2),
  );
  await write(
    'Groups/GTM/web-search.tool',
    JSON.stringify(
      { name: 'web_search', type: 'inline', tools: [{ name: 'search' }] },
      null,
      2,
    ),
  );
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-plugins-'));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('migrateGroupsToPlugins', () => {
  it('does nothing to a knowledge base that has neither root', async () => {
    await write('KnowledgeBase/.gitkeep', '');
    expect(await migrateGroupsToPlugins(repo)).toEqual({ migrated: false, notes: [] });
  });

  it('moves the root, the skills and the tools, and writes the manifest', async () => {
    await seedLegacyKb();
    const result = await migrateGroupsToPlugins(repo);
    expect(result.migrated).toBe(true);

    expect(await exists('Groups')).toBe(false);
    // access.md stays at the PLUGIN ROOT — one level down it would govern only
    // its own subtree, silently narrowing what it protects.
    expect(await exists('Plugins/GTM/access.md')).toBe(true);
    expect(await exists('Plugins/GTM/skills/outreach/SKILL.md')).toBe(true);
    // A skill folder moves whole; its bundled assets are part of the skill.
    expect(await exists('Plugins/GTM/skills/outreach/scripts/run.py')).toBe(true);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/notion.tool')).toBe(true);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/web-search.tool')).toBe(true);
  });

  it('writes a manifest a conformant client accepts', async () => {
    await seedLegacyKb();
    await migrateGroupsToPlugins(repo);
    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(manifest.name).toBe('gtm');
    // The closed field set: anything else is a top-level field the spec does
    // not permit, and inventing metadata about a folder is asserting things
    // nobody said.
    expect(Object.keys(manifest).sort()).toEqual(['$schema', 'name']);
  });

  it('projects mcp-type manuals into mcp.json and leaves the others out of it', async () => {
    await seedLegacyKb();
    await migrateGroupsToPlugins(repo);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(mcp.mcpServers).toEqual({
      notion: { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
    });
    // `inline` has no representation in the spec, so it exists only as a
    // `.tool` under our namespace.
    expect(mcp.mcpServers.web_search).toBeUndefined();
  });

  it('keeps the .tool file for an mcp manual — mcp.json cannot carry its access verbs or secret namespace', async () => {
    await seedLegacyKb();
    await migrateGroupsToPlugins(repo);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/notion.tool')).toBe(true);
  });

  it('is idempotent — a second run changes nothing', async () => {
    await seedLegacyKb();
    await migrateGroupsToPlugins(repo);
    const before = await read('Plugins/GTM/plugin.json');
    expect(await migrateGroupsToPlugins(repo)).toEqual({ migrated: false, notes: [] });
    expect(await read('Plugins/GTM/plugin.json')).toBe(before);
  });

  it('finishes a half-done migration rather than skipping it', async () => {
    // The rename landed but the process died before the reorganisation.
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/outreach/SKILL.md', '# Outreach\n');
    const result = await migrateGroupsToPlugins(repo);
    expect(result.migrated).toBe(true);
    expect(await exists('Plugins/GTM/skills/outreach/SKILL.md')).toBe(true);
    expect(await exists('Plugins/GTM/plugin.json')).toBe(true);
  });

  it('refuses to guess when both roots exist, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    expect(await migrateGroupsToPlugins(repo)).toEqual({ migrated: false, notes: [] });
    // Both left exactly as they were — merging would pick a winner nobody chose.
    expect(await exists('Groups/GTM/access.md')).toBe(true);
    expect(await exists('Plugins/GTM/access.md')).toBe(true);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/both .*exist/i);
  });

  it('moves a malformed .tool without letting it stop the migration', async () => {
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write('Groups/GTM/broken.tool', '{ not json at all');
    const result = await migrateGroupsToPlugins(repo);
    expect(result.migrated).toBe(true);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/broken.tool')).toBe(true);
    // Nothing to project, so no mcp.json is invented.
    expect(await exists('Plugins/GTM/mcp.json')).toBe(false);
  });

  it('never overwrites an mcp.json somebody already wrote', async () => {
    await seedLegacyKb();
    await write('Groups/GTM/mcp.json', '{ "hand": "written" }');
    await migrateGroupsToPlugins(repo);
    expect(JSON.parse(await read('Plugins/GTM/mcp.json'))).toEqual({ hand: 'written' });
  });

  it('leaves a personal folder a valid plugin', async () => {
    await write('Groups/personal-u-123/access.md', 'write:\n  - Ali <ali@x.com>\n');
    await migrateGroupsToPlugins(repo);
    const manifest = JSON.parse(await read('Plugins/personal-u-123/plugin.json'));
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });
});
