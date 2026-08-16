import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { PluginIndexService } from '../plugins.service.js';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../../skills/skills.contract.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const OLGA = { name: 'Olga Ivanova', email: 'olga@bevel.software' };

function skills(...paths: string[]): SkillSummary[] {
  return paths.map((path) => ({ name: path.split('/').pop()!, description: '', path }));
}

function tools(...paths: string[]): ToolManualSummary[] {
  return paths.map((path) => {
    const name = path.split('/').pop()!.replace(/\.tool$/, '');
    return { slug: name, name, path, type: 'inline' as const };
  });
}

describe('PluginIndexService', () => {
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const principals: IAccessControl = {
    eligibleOwners: async () => ({ roles: [], users: [OLGA] }),
    eligibleWriters: async () => ({ roles: ['Admin'], users: [] }),
    eligibleReaders: async () => ({ restricted: true, roles: ['GTM Team'], users: [] }),
  } as unknown as IAccessControl;

  const skillService = (list: SkillSummary[] = []): ISkillService =>
    ({ listSkills: async () => list }) as unknown as ISkillService;

  const toolService = (list: ToolManualSummary[] = []): IToolManualService =>
    ({ listAllSummaries: async () => list }) as unknown as IToolManualService;

  const svc = (opts: {
    access?: IAccessControl;
    skills?: SkillSummary[];
    tools?: ToolManualSummary[];
    workspace?: WorkspaceService;
  } = {}) =>
    new PluginIndexService(
      opts.workspace ?? workspaceService,
      opts.access ?? principals,
      skillService(opts.skills),
      toolService(opts.tools),
      KB_DIR,
    );

  const kb = () => join(root, wsId, KB_DIR);

  /** A REAL plugin: a folder carrying the access.md that makes it exist. */
  const pluginDir = async (name: string) => {
    await mkdir(join(kb(), 'Plugins', name), { recursive: true });
    await writeFile(join(kb(), 'Plugins', name, 'access.md'), '---\nread:\n  - everyone\n---\n');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'plugin-index-'));
    await mkdir(kb(), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('enumerates Plugins/ folders carrying an access.md, sorted by name', async () => {
    await pluginDir('GTM');
    await pluginDir('Engineering');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['Engineering', 'GTM']);
    expect(catalog[1].folders).toEqual(['Plugins/GTM']);
  });

  test('a folder without an access.md is not a plugin', async () => {
    // The residue a deleted plugin leaves behind: git cannot record an empty
    // directory, so the folder outlives its files on live checkouts — and a
    // folder with content but no access.md is just as much a non-plugin.
    await mkdir(join(kb(), 'Plugins', 'Ghost'), { recursive: true });
    await mkdir(join(kb(), 'Plugins', 'Residue'), { recursive: true });
    await writeFile(join(kb(), 'Plugins', 'Residue', 'notes.md'), 'leftover');
    await pluginDir('Real');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['Real']);
  });

  test('the retired Skills/ and Tools/ roots are NOT plugin roots', async () => {
    await mkdir(join(kb(), 'Skills', 'GTM'), { recursive: true });
    await mkdir(join(kb(), 'Tools', 'GTM'), { recursive: true });
    await pluginDir('Engineering');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['Engineering']);
  });

  test('ignores loose files and dot-dirs under the plugin root', async () => {
    // The dot filter wins even over a folder that carries an access.md.
    await mkdir(join(kb(), 'Plugins', '.hidden'), { recursive: true });
    await writeFile(join(kb(), 'Plugins', '.hidden', 'access.md'), '---\nread:\n  - everyone\n---\n');
    await pluginDir('GTM');
    await writeFile(join(kb(), 'Plugins', 'slack.tool'), '{}');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['GTM']);
  });

  test('counts skills and tools from the global catalogs by pluginOfPath', async () => {
    await pluginDir('GTM');
    await pluginDir('Product');

    const catalog = await svc({
      skills: skills('Plugins/GTM/outreach', 'Plugins/GTM/newsletter', 'Plugins/Product/roadmap'),
      // `Plugins/slack.tool` is ungrouped (two segments) — it counts nowhere.
      tools: tools('Plugins/GTM/heyreach.tool', 'Plugins/slack.tool'),
    }).catalog();

    const gtm = catalog.find((g) => g.name === 'GTM')!;
    expect(gtm.skillCount).toBe(2);
    expect(gtm.toolCount).toBe(1);
    const product = catalog.find((g) => g.name === 'Product')!;
    expect(product.skillCount).toBe(1);
    expect(product.toolCount).toBe(0);
  });

  test('resolves principals on the plugin folder', async () => {
    await pluginDir('GTM');

    const seen: string[] = [];
    const access = {
      eligibleOwners: async (_w: string, p: string) => {
        seen.push(p);
        return { roles: [], users: [OLGA] };
      },
      eligibleWriters: async () => ({ roles: [], users: [] }),
      eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    } as unknown as IAccessControl;

    const catalog = await svc({ access }).catalog();
    expect(catalog[0].folders).toEqual(['Plugins/GTM']);
    expect(seen).toEqual(['Plugins/GTM']);
    expect(catalog[0].owners.users).toEqual([OLGA]);
    expect(catalog[0].readers).toEqual({ restricted: false, roles: [], users: [] });
  });

  test('a missing Plugins/ root yields an empty list, not an error', async () => {
    await expect(svc().catalog()).resolves.toEqual([]);
  });

  test('degrades to [] when the workspace cannot be created', async () => {
    const broken = {
      getOrCreateForBranch: async () => {
        throw new Error('no clone');
      },
      getWorkspacePath: async () => root,
    } as unknown as WorkspaceService;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc({ workspace: broken }).catalog()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a failed scan is served but NOT cached — the next call retries', async () => {
    await pluginDir('GTM');
    let fail = true;
    const flaky = {
      // Fails once, the way a default-branch clone mid-creation does, then
      // recovers. If the empty result were cached, GTM would stay hidden from
      // every user for the full TTL after the cause was gone.
      getOrCreateForBranch: async () => {
        if (fail) throw new Error('clone in progress');
        return { id: wsId };
      },
      getWorkspacePath: async (id: string) => join(root, id),
    } as unknown as WorkspaceService;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = svc({ workspace: flaky });

    await expect(service.catalog()).resolves.toEqual([]);

    fail = false;
    expect((await service.catalog()).map((g) => g.name)).toEqual(['GTM']);
    warn.mockRestore();
  });

  test('a genuinely empty KB IS cached — an empty result is a fact, not a failure', async () => {
    let scans = 0;
    const counting = {
      getOrCreateForBranch: async () => {
        scans += 1;
        return { id: wsId };
      },
      getWorkspacePath: async (id: string) => join(root, id),
    } as unknown as WorkspaceService;
    const service = svc({ workspace: counting });

    await expect(service.catalog()).resolves.toEqual([]);
    await expect(service.catalog()).resolves.toEqual([]);
    expect(scans).toBe(1);
  });

  test('caches for the TTL and rescans after invalidate()', async () => {
    await pluginDir('GTM');
    const service = svc();

    expect((await service.catalog()).map((g) => g.name)).toEqual(['GTM']);
    // A plugin added out of band is NOT seen while the cache holds…
    await pluginDir('Finance');
    expect((await service.catalog()).map((g) => g.name)).toEqual(['GTM']);
    // …and IS seen once the file-change subscriber drops it.
    service.invalidate();
    expect((await service.catalog()).map((g) => g.name)).toEqual(['Finance', 'GTM']);
  });
});
