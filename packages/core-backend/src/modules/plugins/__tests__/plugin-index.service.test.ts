import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH, HEXIS_EXTENSION_NS, HEXIS_LINKED_SKILLS_KEY } from '@bevel-software/platform-shared';
import { PluginIndexService } from '../plugins.service.js';
import type { PluginLinkIndex } from '../plugin-links.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
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

  /**
   * A link index that resolves no memberships — enough to put the service in
   * the mode every real host runs in (counts follow links), without a tree to
   * discover. Omit it to get the degraded, inline-only host.
   */
  const emptyLinks = () =>
    ({ membership: async () => ({ bySkill: new Map(), byPlugin: new Map() }) }) as unknown as PluginLinkIndex;

  const svc = (opts: {
    access?: IAccessControl;
    skills?: SkillSummary[];
    tools?: ToolManualSummary[];
    workspace?: WorkspaceService;
    /** Absent: the host that composes no link index — inline-only counts. */
    links?: PluginLinkIndex;
  } = {}) =>
    new PluginIndexService(
      opts.workspace ?? workspaceService,
      opts.access ?? principals,
      skillService(opts.skills),
      toolService(opts.tools),
      KB_DIR,
      new KbPluginSource(new NodeFs()),
      Date.now,
      opts.links,
    );

  const kb = () => join(root, wsId, KB_DIR);

  /**
   * A REAL plugin: a folder carrying the manifest discovery reads AND the
   * access.md that makes it exist to the index (a legacy folder without a
   * manifest gets one from the boot step before the index ever runs).
   */
  const pluginDir = async (name: string, linkedRoots: string[] = []) => {
    await mkdir(join(kb(), 'Plugins', name), { recursive: true });
    const manifest: Record<string, unknown> = { name: name.toLowerCase() };
    // The roots a manifest links, where `linkedSkillRoots` reads them.
    if (linkedRoots.length > 0) {
      manifest.extensions = { [HEXIS_EXTENSION_NS]: { [HEXIS_LINKED_SKILLS_KEY]: linkedRoots } };
    }
    await writeFile(join(kb(), 'Plugins', name, 'plugin.json'), JSON.stringify(manifest));
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
    // The manifest name is the identity; the folder is what people see.
    expect(catalog.map((g) => g.name)).toEqual(['engineering', 'gtm']);
    expect(catalog[1]).toMatchObject({ displayName: 'GTM', folders: ['Plugins/GTM'] });
  });

  test('a folder without an access.md is not a plugin', async () => {
    // The residue a deleted plugin leaves behind: git cannot record an empty
    // directory, so the folder outlives its files on live checkouts — and a
    // folder with content but no access.md is just as much a non-plugin.
    await mkdir(join(kb(), 'Plugins', 'Ghost'), { recursive: true });
    await mkdir(join(kb(), 'Plugins', 'Residue'), { recursive: true });
    await writeFile(join(kb(), 'Plugins', 'Residue', 'notes.md'), 'leftover');
    // A manifest alone is a plugin to discovery but not to the index: the
    // access.md is what a deleted plugin's residue lacks.
    await mkdir(join(kb(), 'Plugins', 'Manifest-only'), { recursive: true });
    await writeFile(join(kb(), 'Plugins', 'Manifest-only', 'plugin.json'), '{"name":"manifest-only"}');
    await pluginDir('Real');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['real']);
  });

  test('the retired Skills/ and Tools/ roots are NOT plugin roots', async () => {
    await mkdir(join(kb(), 'Skills', 'GTM'), { recursive: true });
    await mkdir(join(kb(), 'Tools', 'GTM'), { recursive: true });
    await pluginDir('Engineering');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['engineering']);
  });

  test('ignores loose files and dot-dirs under the plugin root', async () => {
    // The dot filter wins even over a folder that carries an access.md.
    await mkdir(join(kb(), 'Plugins', '.hidden'), { recursive: true });
    await writeFile(join(kb(), 'Plugins', '.hidden', 'access.md'), '---\nread:\n  - everyone\n---\n');
    await pluginDir('GTM');
    await writeFile(join(kb(), 'Plugins', 'slack.tool'), '{}');

    const catalog = await svc().catalog();
    expect(catalog.map((g) => g.name)).toEqual(['gtm']);
  });

  test('counts skills and tools from the global catalogs by pluginOfPath', async () => {
    await pluginDir('GTM');
    await pluginDir('Product');

    const catalog = await svc({
      skills: skills('Plugins/GTM/outreach', 'Plugins/GTM/newsletter', 'Plugins/Product/roadmap'),
      // `Plugins/slack.tool` is ungrouped (two segments) — it counts nowhere.
      tools: tools('Plugins/GTM/heyreach.tool', 'Plugins/slack.tool'),
    }).catalog();

    const gtm = catalog.find((g) => g.name === 'gtm')!;
    expect(gtm.skillCount).toBe(2);
    expect(gtm.toolCount).toBe(1);
    const product = catalog.find((g) => g.name === 'product')!;
    expect(product.skillCount).toBe(1);
    expect(product.toolCount).toBe(0);
  });

  /**
   * A plugin's manifest points at roots elsewhere, and the catalog has to say
   * so: the page uses them to tell a card that LIVES in the plugin from one it
   * only reaches. A skill under such a root carries its own membership record;
   * a `.tool` manual beside it carries none, so the root is the only witness —
   * which is why the tools it brings in are counted here too.
   */
  test("serves a plugin's linked roots, and counts the tools that reach it through them", async () => {
    await pluginDir('GTM', ['Skills/Testing', 'Plugins/Shared/observability']);
    await pluginDir('Product');

    const catalog = await svc({
      links: emptyLinks(),
      tools: tools(
        'Plugins/GTM/heyreach.tool',
        'Plugins/Shared/observability/grafana.tool',
        // A sibling folder sharing a prefix is NOT under the root.
        'Plugins/Shared/observability-archive/old.tool',
      ),
    }).catalog();

    const gtm = catalog.find((g) => g.name === 'gtm')!;
    expect(gtm.linkedRoots).toEqual(['Skills/Testing', 'Plugins/Shared/observability']);
    // Its own, plus the one under the linked root; never the archive's.
    expect(gtm.toolCount).toBe(2);
    // Product links nothing and holds nothing.
    const product = catalog.find((g) => g.name === 'product')!;
    expect(product.linkedRoots).toEqual([]);
    expect(product.toolCount).toBe(0);
  });

  test('counts a tool ONCE for a plugin whose linked root sits inside its own folder', async () => {
    await pluginDir('GTM', ['Plugins/GTM/tools']);

    const catalog = await svc({ links: emptyLinks(), tools: tools('Plugins/GTM/tools/grafana.tool') }).catalog();
    expect(catalog.find((g) => g.name === 'gtm')!.toolCount).toBe(1);
  });

  /**
   * A host that composes no link index counts what each plugin's FOLDER holds
   * — for skills (see `countThroughLinks`) and, for the same reason, for
   * tools. Counting a plugin's linked tools there while its linked skills went
   * uncounted would describe a plugin that exists on no screen.
   */
  test('counts tools inline-only when the host has no link index', async () => {
    await pluginDir('GTM', ['Skills/Testing', 'Plugins/Shared/observability']);

    const catalog = await svc({
      skills: skills('Plugins/GTM/outreach', 'Skills/Testing/test-shared-linking'),
      tools: tools('Plugins/GTM/heyreach.tool', 'Plugins/Shared/observability/grafana.tool'),
    }).catalog();

    // The roots are still SERVED — the page needs them to draw the pill; it is
    // the counting that degrades, and it degrades the same way for both kinds.
    const gtm = catalog.find((g) => g.name === 'gtm')!;
    expect(gtm.linkedRoots).toEqual(['Skills/Testing', 'Plugins/Shared/observability']);
    expect(gtm).toMatchObject({ skillCount: 1, toolCount: 1 });
  });

  test("counts the linked skills a plugin's members cannot read, from the unfiltered link index", async () => {
    await pluginDir('GTM');
    await pluginDir('Product');
    // The link index's view: GTM links two shared skills, one of which lost
    // its grant; Product's inline skill is granted by definition.
    const membership = vi.fn(async () => ({
      bySkill: new Map([
        ['Skills/Eng/deploy', [{ name: 'gtm', linked: true, granted: false }]],
        ['Skills/Eng/rollback', [{ name: 'gtm', linked: true, granted: true }]],
        ['Plugins/Product/roadmap', [{ name: 'product', linked: false, granted: true }]],
      ]),
      byPlugin: new Map(),
    }));
    const links = { membership } as unknown as PluginLinkIndex;
    const catalog = await new PluginIndexService(
      workspaceService,
      principals,
      skillService(skills('Skills/Eng/deploy', 'Skills/Eng/rollback', 'Plugins/Product/roadmap')),
      toolService(),
      KB_DIR,
      new KbPluginSource(new NodeFs()),
      Date.now,
      links,
    ).catalog();

    expect(catalog.find((g) => g.name === 'gtm')).toMatchObject({ skillCount: 2, brokenLinks: 1 });
    expect(catalog.find((g) => g.name === 'product')).toMatchObject({ skillCount: 1, brokenLinks: 0 });
    // Both counts from ONE read of the index: its cache has no single-flight,
    // so two concurrent reads of a cold catalog would build the tree twice.
    expect(membership).toHaveBeenCalledTimes(1);
    // Without a link index there are no links to be broken.
    expect((await svc().catalog()).every((g) => g.brokenLinks === 0)).toBe(true);
  });

  test("marks a plugin private when its access.md's own block denies everyone and names only people", async () => {
    await pluginDir('GTM'); // read: everyone — discoverable, not private
    await pluginDir('Mine');
    await writeFile(
      join(kb(), 'Plugins', 'Mine', 'access.md'),
      '---\n# the file\nread:\n  - deny everyone\n  - Ali Vega <ali@x.io>\n---\nread:\n  - deny everyone\n  - Ali Vega <ali@x.io>\n',
    );
    // A role beside the denial is a roster, not a private list.
    await pluginDir('Team');
    await writeFile(
      join(kb(), 'Plugins', 'Team', 'access.md'),
      '---\nread:\n  - deny everyone\n  - Sales Team\n---\nread:\n  - Sales Team\n',
    );
    // A frontmatter that never mentions everyone makes no statement.
    await pluginDir('Quiet');
    await writeFile(join(kb(), 'Plugins', 'Quiet', 'access.md'), '---\nread: []\n---\nread:\n  - Ali Vega <ali@x.io>\n');

    const catalog = await svc().catalog();
    expect(Object.fromEntries(catalog.map((g) => [g.name, g.isPrivate]))).toEqual({
      gtm: false,
      mine: true,
      team: false,
      quiet: false,
    });
  });

  test("carries what discovery left out of a plugin, in that plugin's entry, without the folder prefix", async () => {
    await pluginDir('GTM');
    await mkdir(join(kb(), 'Plugins', 'Ado'), { recursive: true });
    await writeFile(
      join(kb(), 'Plugins', 'Ado', 'plugin.bundle.json'),
      JSON.stringify({ name: 'ado', mcpProfile: 'global', sourceSkillRoots: ['../escape'] }),
    );
    const catalog = await svc().catalog();
    const ado = catalog.find((g) => g.name === 'ado')!;
    expect(ado.warnings).toEqual([
      'sourceSkillRoots entry "../escape" is not a folder path — ignored',
      'mcpProfile "global" named but no registry could be read',
    ]);
    // Nothing of that is GTM's.
    expect(catalog.find((g) => g.name === 'gtm')!.warnings).toEqual([]);
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
    expect((await service.catalog()).map((g) => g.name)).toEqual(['gtm']);
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

    expect((await service.catalog()).map((g) => g.name)).toEqual(['gtm']);
    // A plugin added out of band is NOT seen while the cache holds…
    await pluginDir('Finance');
    expect((await service.catalog()).map((g) => g.name)).toEqual(['gtm']);
    // …and IS seen once the file-change subscriber drops it.
    service.invalidate();
    expect((await service.catalog()).map((g) => g.name)).toEqual(['finance', 'gtm']);
  });
});
