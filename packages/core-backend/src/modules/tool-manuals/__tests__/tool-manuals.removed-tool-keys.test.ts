import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../../plugins/discovery/kb-plugin-source.js';
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
 * retires a namespace the moment a complete scan no longer finds it declared.
 *
 * The vault here is a map of shared rows; its `removeNamespace` stands in for
 * the real one (which has its own tests). What these tests pin is WHEN the
 * catalog asks for the wipe: after a removal, before a reuse is listed, never
 * on a move or a typo, and never off a scan that could not see everything.
 */

const disk = new NodeFs();
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
    for (const k of [...rows.keys()]) if (k.startsWith(prefix)) rows.delete(k);
  };

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    hasBootstrappedWorkspace: async () => false,
  } as unknown as WorkspaceService;
  const allowAll = {
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const svc = () => {
    const service = new ToolManualService(
      workspaceService,
      allowAll,
      testKbContext({ kbDirName: KB_DIR }),
      disk,
      new KbPluginSource(disk, testKbContext({ kbDirName: KB_DIR })),
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

  test('a wipe that fails is retried, and still lands before a reuse can resolve the old key', async () => {
    const service = svc();
    await list(service);
    rows.set(KEY, 'sk-old');
    failWipes = 1;

    await unlink(join(plugins(), 'Alpha/qa_keyed.tool'));
    await list(service);
    expect(rows.get(KEY)).toBe('sk-old');

    // The reuse arrives while the wipe is still owed: owed it stays.
    await write('Beta/reused.tool', keyedTool('https://b.example.com/utcp'));
    expect(await list(service)).toContain('qa_keyed Plugins/Beta/reused.tool');
    expect(retired).toEqual([utcpNamespacePrefix('qa_keyed'), utcpNamespacePrefix('qa_keyed')]);
    expect(rows.has(KEY)).toBe(false);

    // Paid once: a key set for the new tool afterwards is not wiped again.
    rows.set(KEY, 'sk-new');
    await list(service);
    expect(rows.get(KEY)).toBe('sk-new');
  });
});
