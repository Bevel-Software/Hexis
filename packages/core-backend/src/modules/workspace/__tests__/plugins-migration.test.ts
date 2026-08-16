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
    expect(await migrateGroupsToPlugins(repo)).toEqual({
      migrated: false,
      renamed: false,
      ignoreRewritten: false,
      notes: [],
    });
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
    // The mcp manual CONVERTED (mcp.json is authoritative); http/inline moved.
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/notion.tool')).toBe(false);
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

  it('converts mcp-type manuals into mcp.json entries and leaves the others out of it', async () => {
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

  it('splits headers: literals into mcp.json, credential references into plugin.json extensions', async () => {
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/vendor.tool',
      JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        headers: { Authorization: 'Bearer ${VENDOR_KEY}', 'X-Api-Version': '2' },
      }),
    );
    await migrateGroupsToPlugins(repo);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    // The spec forbids credentials in `headers` and forbids expanding anything
    // but ${PLUGIN_ROOT}/${PLUGIN_DATA} — a copied ${VENDOR_KEY} would be sent
    // literally by a conformant client.
    expect(mcp.mcpServers.vendor.headers).toEqual({ 'X-Api-Version': '2' });
    // The reference lives on in the extensions block, which is ours to interpret.
    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.extensions['software.bevel.hexis'].mcpServers.vendor.headers).toEqual({
      Authorization: 'Bearer ${VENDOR_KEY}',
    });
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(false);
  });

  it('omits headers entirely when every one of them was a credential reference', async () => {
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/vendor.tool',
      JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        headers: { Authorization: 'Bearer ${VENDOR_KEY}' },
      }),
    );
    await migrateGroupsToPlugins(repo);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    // An empty `headers` object would assert "this server needs no auth".
    // Saying nothing is the honest shape: where it is, not how to reach it.
    expect(mcp.mcpServers.vendor).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.vendor.example/mcp',
    });
  });

  it('converts an mcp .tool a previous run parked in the extension dir, second sweep', async () => {
    // The earlier migration shape MOVED mcp .tools here and projected mcp.json;
    // now that mcp.json is authoritative, a parked twin must convert away.
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/plugin.json', '{ "name": "gtm" }');
    await write(
      'Plugins/GTM/software.bevel.hexis/tools/notion.tool',
      JSON.stringify({ name: 'notion', type: 'mcp', url: 'https://mcp.notion.com/mcp' }),
    );
    const result = await migrateGroupsToPlugins(repo);
    expect(result.migrated).toBe(true);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/notion.tool')).toBe(false);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    expect(mcp.mcpServers.notion.url).toBe('https://mcp.notion.com/mcp');
  });

  it('moves declared variables and the local flag into the plugin.json extensions block', async () => {
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/plugin.json', '{ "name": "gtm" }');
    await write(
      'Plugins/GTM/vendor.tool',
      JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'http://localhost:9000/mcp',
        remote: false,
        variables: [{ name: 'VENDOR_KEY', scope: 'user', label: 'Your key' }],
      }),
    );
    await migrateGroupsToPlugins(repo);
    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.extensions['software.bevel.hexis'].mcpServers.vendor).toEqual({
      variables: [{ name: 'VENDOR_KEY', scope: 'user', label: 'Your key' }],
      local: true,
    });
  });

  it('is idempotent — a second run changes nothing', async () => {
    await seedLegacyKb();
    await migrateGroupsToPlugins(repo);
    const before = await read('Plugins/GTM/plugin.json');
    expect(await migrateGroupsToPlugins(repo)).toEqual({
      migrated: false,
      renamed: false,
      ignoreRewritten: false,
      notes: [],
    });
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
    expect(await migrateGroupsToPlugins(repo)).toEqual({
      migrated: false,
      renamed: false,
      ignoreRewritten: false,
      notes: [],
    });
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

  it('merges into an existing mcp.json without clobbering what is already there', async () => {
    await seedLegacyKb();
    await write(
      'Groups/GTM/mcp.json',
      JSON.stringify({ mcpServers: { notion: { type: 'streamable-http', url: 'https://hand.example/mcp' } } }),
    );
    await migrateGroupsToPlugins(repo);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    // The hand-written notion entry WINS; the converted .tool is gone either way.
    expect(mcp.mcpServers.notion.url).toBe('https://hand.example/mcp');
    expect(await exists('Plugins/GTM/notion.tool')).toBe(false);
  });

  it('leaves a personal folder a valid plugin', async () => {
    await write('Groups/personal-u-123/access.md', 'write:\n  - Ali <ali@x.com>\n');
    await migrateGroupsToPlugins(repo);
    const manifest = JSON.parse(await read('Plugins/personal-u-123/plugin.json'));
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  it('routes anything the substitutor would expand to the extensions block — non-name ${…} stays literal', async () => {
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/vendor.tool',
      JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        // The substitutor's grammar decides: bare `$VENDOR_KEY` and the
        // digit-leading `$5` in the price BOTH expand, so both route to the
        // non-portable half; `${not-a-name}` is not expandable and stays.
        headers: {
          Authorization: 'Bearer $VENDOR_KEY',
          'X-Price': '$5 per call',
          'X-Tag': 'v ${not-a-name}',
        },
      }),
    );
    await migrateGroupsToPlugins(repo);
    const mcp = JSON.parse(await read('Plugins/GTM/mcp.json'));
    expect(mcp.mcpServers.vendor.headers).toEqual({ 'X-Tag': 'v ${not-a-name}' });
    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.extensions['software.bevel.hexis'].mcpServers.vendor.headers).toEqual({
      Authorization: 'Bearer $VENDOR_KEY',
      'X-Price': '$5 per call',
    });
  });

  it('does not follow a symlinked extension tools dir in the second sweep', async () => {
    // The second sweep DELETES what it converts — following a link would
    // convert-and-delete `.tool` files from wherever the link really points.
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/plugin.json', '{ "name": "gtm" }');
    await write(
      'elsewhere/tools/notion.tool',
      JSON.stringify({ name: 'notion', type: 'mcp', url: 'https://mcp.notion.com/mcp' }),
    );
    await fs.mkdir(path.join(repo, 'Plugins/GTM/software.bevel.hexis'), { recursive: true });
    // 'junction' so the link is creatable without privileges on Windows; on
    // POSIX the type argument is ignored and a plain dir symlink is made.
    await fs.symlink(
      path.join(repo, 'elsewhere/tools'),
      path.join(repo, 'Plugins/GTM/software.bevel.hexis/tools'),
      'junction',
    );
    const result = await migrateGroupsToPlugins(repo);
    // The linked-to file is untouched — not converted, not deleted.
    expect(await exists('elsewhere/tools/notion.tool')).toBe(true);
    expect(await exists('Plugins/GTM/mcp.json')).toBe(false);
    expect(result.notes.join(' ')).not.toContain('notion');
  });

  it('refuses to convert an mcp .tool whose url is not directly parseable http(s)', async () => {
    // A templated url (`${VENDOR_BASE}/mcp`) is legal in a `.tool`, where the
    // substitutor expands it — but the mcp.json loader validates `new URL`
    // and skips the entry, so converting would delete the source and write a
    // dead entry: the integration would simply vanish.
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/vendor.tool',
      JSON.stringify({ name: 'vendor', type: 'mcp', url: '${VENDOR_BASE}/mcp' }),
    );
    await write(
      'Groups/GTM/socket.tool',
      JSON.stringify({ name: 'socket', type: 'mcp', url: 'wss://mcp.vendor.example/mcp' }),
    );
    await migrateGroupsToPlugins(repo);
    // Both stay `.tool` files (moved with the other unconvertibles), and no
    // mcp.json is invented for them.
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(true);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/socket.tool')).toBe(true);
    expect(await exists('Plugins/GTM/mcp.json')).toBe(false);
  });

  it('refuses to convert an mcp .tool whose url carries userinfo', async () => {
    // `https://user:pass@…` copied into mcp.json would put a credential in
    // the PORTABLE file — the exact thing the header split exists to prevent
    // — and stripping it would break the server. The manual keeps its
    // `.tool` form, where the credential stays platform-internal.
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/vendor.tool',
      JSON.stringify({ name: 'vendor', type: 'mcp', url: 'https://user:pass@mcp.vendor.example/mcp' }),
    );
    await migrateGroupsToPlugins(repo);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/vendor.tool')).toBe(true);
    expect(await exists('Plugins/GTM/mcp.json')).toBe(false);
  });

  it('refuses to convert an mcp .tool that gates itself with frontmatter access verbs', async () => {
    // The access resolver reads a `.tool`'s own verbs from the file itself;
    // an mcp.json entry has no per-server home for them, so converting would
    // silently widen who may configure and run the server.
    await write('Groups/GTM/access.md', 'write:\n  - Admin\n');
    await write(
      'Groups/GTM/gated.tool',
      '---\nname: gated\ntype: mcp\nurl: https://mcp.vendor.example/mcp\nwrite:\n  - Product Team\n---\n',
    );
    await migrateGroupsToPlugins(repo);
    expect(await exists('Plugins/GTM/software.bevel.hexis/tools/gated.tool')).toBe(true);
    expect(await exists('Plugins/GTM/mcp.json')).toBe(false);
    // The verbs travel with the file — the moved copy still declares them.
    expect(await read('Plugins/GTM/software.bevel.hexis/tools/gated.tool')).toContain('Product Team');
  });

  it('reports a note-only run as not migrated — there is nothing to commit', async () => {
    // An unparsable manifest blocks conversion of a manual that carries
    // extension data; the refusal is a NOTE, not a file change, and saying
    // `migrated` anyway would send the caller into an empty commit every boot.
    await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
    await write('Plugins/GTM/plugin.json', '{ not json at all');
    await write(
      'Plugins/GTM/vendor.tool',
      JSON.stringify({
        name: 'vendor',
        type: 'mcp',
        url: 'https://mcp.vendor.example/mcp',
        variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await migrateGroupsToPlugins(repo);
    warn.mockRestore();
    expect(result.migrated).toBe(false);
    expect(result.notes.join(' ')).toContain('NOT converted');
    // The source stays, ready for the run after the manifest is fixed.
    expect(await exists('Plugins/GTM/vendor.tool')).toBe(true);
  });

  describe('the .bevelignore root rule', () => {
    it('follows the rename, preserving every other line', async () => {
      await seedLegacyKb();
      await write('.bevelignore', '# mine\nGroups/\nMy-Own-Rule/\n');
      const result = await migrateGroupsToPlugins(repo);
      expect(result.ignoreRewritten).toBe(true);
      const ignore = await read('.bevelignore');
      expect(ignore.split('\n')).toContain('Plugins/');
      expect(ignore).not.toContain('Groups/');
      expect(ignore).toContain('# mine');
      expect(ignore).toContain('My-Own-Rule/');
    });

    it('is left alone when Plugins/ is already listed', async () => {
      await seedLegacyKb();
      await write('.bevelignore', 'Groups/\nPlugins/\n');
      const result = await migrateGroupsToPlugins(repo);
      expect(result.ignoreRewritten).toBe(false);
      // The stale line is harmlessly dead; deleting it would be editing the
      // operator's file beyond what the rename made stale.
      expect(await read('.bevelignore')).toBe('Groups/\nPlugins/\n');
    });

    it('is not touched by a run that does not rename', async () => {
      await write('Plugins/GTM/access.md', 'write:\n  - Admin\n');
      await write('Plugins/GTM/outreach/SKILL.md', '# Outreach\n');
      await write('.bevelignore', 'Groups/\n');
      const result = await migrateGroupsToPlugins(repo);
      expect(result.ignoreRewritten).toBe(false);
      expect(await read('.bevelignore')).toBe('Groups/\n');
    });
  });
});
