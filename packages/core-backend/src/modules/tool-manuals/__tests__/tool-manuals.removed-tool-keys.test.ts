import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, unlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { realDisk, realPluginSource } from '../../../__tests__/real-disk.js';
import type { PluginSource } from '../../plugins/index.js';
import { ToolManualService } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { utcpNamespacePrefix, utcpNamespacedKey } from '../../../shared/utcp-namespace.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * A DELETED TOOL'S KEY IS NEVER HANDED TO A LATER TOOL WITH THE SAME ID.
 *
 * Vault rows are keyed `<manual namespace><VAR>`, so a key stored for
 * `qa_keyed` would resolve for ANY later manual named `qa_keyed`. The catalog
 * owns the answer to "is this tool still here", so it is the catalog that
 * retires a namespace the moment a scan finds its tool gone, and withholds a
 * tool reusing the name until the wipe has landed.
 *
 * The vault here is a map of shared rows; its `removeNamespace` stands in for
 * the real one (which has its own tests). What these tests pin is WHEN the
 * catalog asks for the wipe: after a removal, before a reuse is listed, never
 * on a move or a typo, and never for an absence a scan could not see.
 */

const disk = realDisk();
const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
const KEY = utcpNamespacedKey('qa_keyed', 'API_KEY');

const keyedTool = (url: string) =>
  `---\nid: qa_keyed\ntype: http\nurl: ${url}\nheaders:\n  Authorization: "Bearer \${API_KEY}"\n---\n`;
/** Unparseable YAML: the file cannot even say which manual it is. */
const NAMELESS = '---\nid: broken\ntype: http\nurl: https://x.example.com\n  headers: oops\n---\n';
/** Parses as YAML, refused by the normalizer, but still says it is `qa_keyed`. */
const NAMED_BUT_REFUSED =
  '---\nid: qa_keyed\ntype: http\nurl: https://a.example.com/utcp\nheaders:\n  Authorization: "Bearer ${API_URL}"\n---\n';

describe('a removed tool takes its stored keys with it', () => {
  let root: string;
  let clock: number;
  /** Shared vault rows: key → value. */
  let rows: Map<string, string>;
  let retired: string[];
  let failWipes: number;

  const removeNamespace = async (prefix: string) => {
    retired.push(prefix);
    if (failWipes > 0) {
      failWipes--;
      throw new Error('vault unavailable');
    }
    // The vault's membership rule (`isKeyInNamespace`): a remainder that
    // starts with `_` may belong to a longer name, so the wipe leaves it.
    for (const k of [...rows.keys()]) if (k.startsWith(prefix) && !k.slice(prefix.length).startsWith('_')) rows.delete(k);
  };

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    hasBootstrappedWorkspace: async () => false,
  } as unknown as WorkspaceService;
  const allowAll = {
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const svc = (source = realPluginSource(disk, testKbContext({ kbDirName: KB_DIR })) as PluginSource) => {
    const service = new ToolManualService(
      workspaceService,
      allowAll,
      testKbContext({ kbDirName: KB_DIR }),
      disk,
      source,
      () => clock,
    );
    service.setNamespaceRetirement(removeNamespace);
    return service;
  };

  const plugins = () => join(root, wsId, KB_DIR, 'Plugins');
  const write = async (rel: string, body: string) => {
    const abs = join(plugins(), rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body);
  };
  /** The next listing, as a long-lived process sees it after the TTL. */
  const list = async (service: ToolManualService) => {
    clock += 120_000;
    return (await service.listAllSummaries()).map((m) => `${m.name} ${m.path}`).sort();
  };

  beforeEach(async () => {
    clock = 1_000_000;
    rows = new Map();
    retired = [];
    failWipes = 0;
    root = await mkdtemp(join(tmpdir(), 'tools-removed-keys-'));
    await write('Alpha/qa_keyed.tool', keyedTool('https://a.example.com/utcp'));
    await write('weather.tool', `---\nid: weather\ntype: http\nurl: https://w.example.com/utcp\n---\n`);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('a tool reusing a deleted tool\'s id in another plugin starts with no key', async () => {
    const service = svc();
    await list(service); // the baseline: qa_keyed declared
    rows.set(KEY, 'sk-old-tool-secret');

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    expect(await list(service)).not.toContain('qa_keyed Plugins/Alpha/qa_keyed.tool');
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);

    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');
    // Neither shown as set nor resolvable for the new tool's call.
    expect(rows.has(KEY)).toBe(false);
    expect([...rows.keys()]).toEqual([]);
  });

  test('a deletion is seen even when nothing reads the catalog before the reuse lands', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old-tool-secret');

    // The tree changes announce themselves (the catalog-invalidation wiring);
    // no listing is requested between the deletion and the reuse.
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    service.invalidate();
    await vi.waitFor(() => expect(retired).toHaveLength(1));
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    service.invalidate();

    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');
    expect(rows.has(KEY)).toBe(false);
  });

  test('a deletion and a reuse that land in ONE scan still wipe the old key', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old-tool-secret');

    // Written back to back (an agent's delete_file + write_file): no scan
    // sees the tree between them, so the name never looks absent.
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');

    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);
  });

  test('a deletion and a reuse announced back to back wipe the key before the reuse is listed', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old-tool-secret');

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    service.invalidate();
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    service.invalidate();

    // The first listing that shows the reuse already finds no old key.
    expect((await service.listAllSummaries()).map((m) => `${m.name} ${m.path}`)).toContain(
      'qa_keyed Plugins/Beta/reused.tool',
    );
    expect(rows.has(KEY)).toBe(false);
  });

  test('a server name reused in another plugin\'s mcp.json in one scan does not inherit the key', async () => {
    const serverKey = utcpNamespacedKey('srv', 'API_KEY');
    await write('Ops/plugin.json', JSON.stringify({ name: 'ops' }));
    await write('Ops/mcp.json', JSON.stringify({ mcpServers: { srv: { type: 'streamable-http', url: 'https://s.example.com/mcp' } } }));
    const service = svc();
    expect(await list(service)).toContain('srv Plugins/Ops/mcp.json');
    rows.set(serverKey, 'sk-server');

    await write('Ops/mcp.json', JSON.stringify({ mcpServers: {} }));
    await write('Other/plugin.json', JSON.stringify({ name: 'other' }));
    await write('Other/mcp.json', JSON.stringify({ mcpServers: { srv: { type: 'streamable-http', url: 'https://evil.example.com/mcp' } } }));
    expect(await list(service)).toContain('srv Plugins/Other/mcp.json');

    expect(retired).toEqual([utcpNamespacePrefix('srv')]);
    expect(rows.has(serverKey)).toBe(false);
  });

  test('a move that also changes the file is not recognised as the same tool, so its key goes', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await write('Beta/qa_keyed.tool', keyedTool('https://a.example.com/utcp/v2'));
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/qa_keyed.tool');

    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);
  });

  test('an edit in place keeps the key, even one that changes where the tool calls', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-kept');

    await write('Alpha/qa_keyed.tool', keyedTool('https://a.example.com/utcp/v2'));
    expect(await list(service)).toContain('qa_keyed Plugins/Alpha/qa_keyed.tool');

    expect(retired).toEqual([]);
    expect(rows.get(KEY)).toBe('sk-kept');
  });

  test('a move keeps the id in every scan, so the key follows it', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-kept');

    await mkdir(join(plugins(), 'Beta'), { recursive: true });
    await rename(join(plugins(), 'Alpha/qa_keyed.tool'), join(plugins(), 'Beta/renamed.tool'));
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/renamed.tool');

    expect(retired).toEqual([]);
    expect(rows.get(KEY)).toBe('sk-kept');
  });

  test('a refused edit that still names the tool does not take its key', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-kept');

    await write('Alpha/qa_keyed.tool', NAMED_BUT_REFUSED);
    expect(await list(service)).not.toContain('qa_keyed Plugins/Alpha/qa_keyed.tool');

    expect(retired).toEqual([]);
    expect(rows.get(KEY)).toBe('sk-kept');
  });

  test('a scan that could not read every file retires nothing, and the next complete one does', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');

    // The keyed tool is gone, but a file that names nothing could be it.
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await write('Alpha/broken.tool', NAMELESS);
    await list(service);
    expect(retired).toEqual([]);
    expect(rows.get(KEY)).toBe('sk-old');

    await unlink(join(plugins(), 'Alpha/broken.tool'));
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);
  });

  test('an mcp.json that cannot be parsed is not read as every server in it removed', async () => {
    const serverKey = utcpNamespacedKey('srv', 'API_KEY');
    await write('Ops/plugin.json', JSON.stringify({ name: 'ops' }));
    await write('Ops/mcp.json', JSON.stringify({ mcpServers: { srv: { type: 'streamable-http', url: 'https://s.example.com/mcp' } } }));
    const service = svc();
    expect(await list(service)).toContain('srv Plugins/Ops/mcp.json');
    rows.set(serverKey, 'sk-server');

    await write('Ops/mcp.json', '{ "mcpServers": { "srv": ');
    await list(service);
    expect(retired).toEqual([]);

    await write('Ops/mcp.json', JSON.stringify({ mcpServers: {} }));
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('srv')]);
    expect(rows.has(serverKey)).toBe(false);
  });

  test('an mcp.json that cannot be read is not read as every server in it removed', async () => {
    const serverKey = utcpNamespacedKey('srv', 'API_KEY');
    await write('Ops/plugin.json', JSON.stringify({ name: 'ops' }));
    await write('Ops/mcp.json', JSON.stringify({ mcpServers: { srv: { type: 'streamable-http', url: 'https://s.example.com/mcp' } } }));
    const service = svc();
    expect(await list(service)).toContain('srv Plugins/Ops/mcp.json');
    rows.set(serverKey, 'sk-server');

    // A read that fails (EISDIR here; EACCES or EIO in the field), not an absence.
    await unlink(join(plugins(), 'Ops/mcp.json'));
    await mkdir(join(plugins(), 'Ops/mcp.json'));
    await list(service);
    expect(retired).toEqual([]);
    expect(rows.get(serverKey)).toBe('sk-server');

    await rm(join(plugins(), 'Ops/mcp.json'), { recursive: true });
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('srv')]);
  });

  test('a bundle registry that cannot be read retires nothing', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');

    const registry = join(root, wsId, KB_DIR, 'configs/mcp/registry.json');
    await mkdir(registry, { recursive: true });
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await list(service);
    expect(retired).toEqual([]);

    await rm(registry, { recursive: true });
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
  });

  test('renaming a file with no id is a new name, so the old name\'s keys go', async () => {
    const OLD = utcpNamespacedKey('oldname', 'API_KEY');
    const idless = `---\ntype: http\nurl: https://n.example.com/utcp\nheaders:\n  Authorization: "Bearer \${API_KEY}"\n---\n`;
    await write('Alpha/oldname.tool', idless);
    const service = svc();
    expect(await list(service)).toContain('oldname Plugins/Alpha/oldname.tool');
    rows.set(OLD, 'sk-old-name');

    await rename(join(plugins(), 'Alpha/oldname.tool'), join(plugins(), 'Alpha/newname.tool'));
    expect(await list(service)).toContain('newname Plugins/Alpha/newname.tool');
    expect(retired).toEqual([utcpNamespacePrefix('oldname')]);
    expect(rows.has(OLD)).toBe(false);
  });

  test('a slow scan of an older tree never reports a tool added since as removed', async () => {
    // The plugin discovery runs after the `.tool` walk; holding it holds a
    // scan that has already listed the older tree.
    const real = realPluginSource(disk, testKbContext({ kbDirName: KB_DIR }));
    let hold: Promise<void> | null = null;
    const source = Object.assign(Object.create(real) as PluginSource, {
      discover: async (kbRoot: string) => {
        const gate = hold;
        hold = null;
        if (gate) await gate;
        return real.discover(kbRoot);
      },
    });
    const service = svc(source);
    await list(service);

    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    service.invalidate(); // scan A: walks the tree without late.tool, then waits
    await vi.waitFor(() => expect(hold).toBeNull());
    await write('late.tool', `---\nid: late\ntype: http\nurl: https://l.example.com/utcp\n---\n`);
    service.invalidate(); // scan B: sees late.tool, finishes first
    expect((await service.listAllSummaries()).map((m) => m.name)).toContain('late');
    const lateKey = utcpNamespacedKey('late', 'API_KEY');
    rows.set(lateKey, 'sk-late');

    release();
    // A finishes its read and its retirement pass; nothing else is reading.
    await new Promise((r) => setTimeout(r, 200));
    await list(service);
    expect(retired).toEqual([]);
    expect(rows.get(lateKey)).toBe('sk-late');
  });

  test('a reuse is withheld while the wipe keeps failing, and listed once it lands', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');
    failWipes = 3; // the deletion's scan, the reuse's scan, the sign-in's fresh read

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await list(service);
    expect(rows.get(KEY)).toBe('sk-old');

    // The reuse arrives while the wipe is still owed, and the retry fails too:
    // the reuse is not served, neither listed nor found by a sign-in.
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    expect(await list(service)).not.toContain('qa_keyed Plugins/Beta/reused.tool');
    const { invalid } = await service.listAccessibleCatalog('a@x.com');
    expect(invalid.map((i) => i.path)).toContain('Plugins/Beta/reused.tool');
    expect(await service.liveDeclaration('a@x.com', 'qa_keyed', 'API_KEY')).toEqual({
      refused: expect.stringContaining('could not be cleared'),
    });
    expect(rows.get(KEY)).toBe('sk-old');

    // The next retry lands: the reuse is served, with no key.
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');
    expect(rows.has(KEY)).toBe(false);

    // Paid once: a key set for the new tool afterwards is not wiped again.
    rows.set(KEY, 'sk-new');
    await list(service);
    expect(rows.get(KEY)).toBe('sk-new');
  });

  test('a reuse seen by a scan that could not read everything still wipes the old key', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old-tool-secret');

    // A file that names nothing makes the scan incomplete, but the name is
    // declared, by a file that shares neither path nor bytes with the old one.
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    await write('Alpha/broken.tool', NAMELESS);
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');

    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a folder that cannot be listed retires nothing',
    async () => {
      const service = svc();
      await list(service);
      rows.set(KEY, 'sk-old');

      await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
      // Inside a plugin's folder, where plugin discovery does not look: only
      // the catalog's own walk of the `.tool` files can tell it was not seen.
      await write('Ops/plugin.json', JSON.stringify({ name: 'ops' }));
      await mkdir(join(plugins(), 'Ops/Locked'));
      await chmod(join(plugins(), 'Ops/Locked'), 0o000);
      try {
        await list(service);
        expect(retired).toEqual([]);
        expect(rows.get(KEY)).toBe('sk-old');
      } finally {
        await chmod(join(plugins(), 'Ops/Locked'), 0o755);
      }
      await list(service);
      expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    },
  );

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a .tool file that cannot be read retires nothing',
    async () => {
      const service = svc();
      await list(service);
      rows.set(KEY, 'sk-old');

      // The keyed tool is gone, but a file nobody could read could be it.
      await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
      await write('Alpha/locked.tool', keyedTool('https://a.example.com/utcp'));
      await chmod(join(plugins(), 'Alpha/locked.tool'), 0o000);
      await list(service);
      expect(retired).toEqual([]);
      expect(rows.get(KEY)).toBe('sk-old');

      await unlink(join(plugins(), 'Alpha/locked.tool'));
      await list(service);
      expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    },
  );

  test('a bundle registry that does not parse, or rejects a server, retires nothing', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');
    const registry = join(root, wsId, KB_DIR, 'configs/mcp/registry.json');
    await mkdir(join(registry, '..'), { recursive: true });
    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));

    await writeFile(registry, '{ "servers": [');
    await list(service);
    await writeFile(registry, JSON.stringify({ servers: [{ id: 'srv', config: { type: 'sse', url: 'https://s.example.com' } }] }));
    await list(service);
    await writeFile(registry, JSON.stringify({ servers: [{ config: { url: 'https://s.example.com/mcp' } }] }));
    await list(service);
    expect(retired).toEqual([]);

    await writeFile(registry, JSON.stringify({ servers: [] }));
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
  });

  test('the namespace wipe leaves a `_`-leading variable\'s row, as the vault rule says', async () => {
    // A `_`-leading variable's key is also the key a longer tool name's
    // variable would have (see `isKeyInNamespace`), so the vault never wipes
    // it. The changeset states this limit; this pins that nothing claims more.
    const underscored = utcpNamespacedKey('qa_keyed', '_LEGACY');
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');
    rows.set(underscored, 'sk-underscored');

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await list(service);
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);
    expect(rows.get(underscored)).toBe('sk-underscored');
  });
});
