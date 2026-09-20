import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH, type AuthUser } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService } from '../../skills/skills.contract.js';
import type { IPluginIndexService, PluginCatalogEntry } from '../../plugins/plugins.contract.js';
import type { PluginSource, Discovery } from '../../plugins/discovery/plugin-source.js';
import type { IToolManualService, ToolManualSummary } from '../tool-manuals.contract.js';
import { ToolDeleteError, ToolDeleteService } from '../tool-delete.service.js';

/**
 * Deleting one tool, over a real temp KB: the two shapes a tool comes in (a
 * `.tool` file and one entry in a plugin's mcp.json), the owner gate that
 * decides who may, and the dependents listing the dialog is built from.
 */

const KB = 'knowledge-base';
const USER: AuthUser = { id: 'u-1', email: 'owner@x.com', name: 'Ola' } as AuthUser;

let root: string;
let repo: string;
let svc: ToolDeleteService;
let commits: { runPendingCommit: ReturnType<typeof vi.fn>; hasUnpushedCommits: ReturnType<typeof vi.fn> };
let vault: {
  countNamespace: ReturnType<typeof vi.fn>;
  removeNamespace: ReturnType<typeof vi.fn>;
};
let owners: string[];
/** Folders `canRead` says no to — the dependent list must not name their plugins. */
let unreadableFolders: string[];
let invalidatedTools: number;
let invalidatedPlugins: number;

const summaries: ToolManualSummary[] = [
  { slug: 'weather', name: 'weather', path: 'Plugins/GTM/weather.tool', type: 'http', variables: [{ name: 'KEY', scope: 'admin' }] },
  { slug: 'vendor', name: 'vendor', path: 'Plugins/GTM/mcp.json', type: 'mcp' },
  { slug: 'orphan', name: 'orphan', path: 'Personal/notes.tool', type: 'http' },
];

const catalog: PluginCatalogEntry[] = [
  {
    name: 'gtm',
    displayName: 'GTM',
    folders: ['Plugins/GTM'],
    linksAreManaged: true,
    skillCount: 1,
    toolCount: 2,
    brokenLinks: 0,
    owners: { people: [], roles: [] } as unknown as PluginCatalogEntry['owners'],
    writers: { people: [], roles: [] } as unknown as PluginCatalogEntry['writers'],
    readers: { people: [], roles: [] } as unknown as PluginCatalogEntry['readers'],
    isPrivate: false,
    warnings: [],
  },
];

async function write(rel: string, content: unknown): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf-8');
}

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(repo, rel), 'utf-8'));
}

function discovery(plugins: Partial<Discovery['plugins'][number]>[]): PluginSource {
  return {
    dialect: 'native',
    discover: vi.fn(async () => ({
      plugins: plugins.map((p) => ({
        name: 'x',
        displayName: 'X',
        folder: 'Plugins/X',
        relFolder: 'X',
        personal: false,
        exists: true,
        manifest: null,
        manifestText: null,
        linkedRoots: [],
        mcpServers: null,
        mcpJsonText: null,
        linksAreManaged: true,
        ...p,
      })),
      warnings: [],
      unreadable: [],
      claimed: [],
    })),
  } as unknown as PluginSource;
}

/** Skills whose `allowed-tools` the dependents listing reads. */
function skillsWith(entries: Record<string, string[]>): ISkillService {
  return {
    listSkills: vi.fn(async () =>
      Object.keys(entries).map((name) => ({ name, description: '', path: `Plugins/GTM/${name}` })),
    ),
    getSkill: vi.fn(async (_email: string, name: string) => ({
      ok: true as const,
      kind: 'skill' as const,
      skill: { name, description: '', path: `Plugins/GTM/${name}`, body: '', files: [], allowedTools: entries[name] },
    })),
    invalidate: vi.fn(),
  } as unknown as ISkillService;
}

function build(
  opts: { source?: PluginSource; skills?: ISkillService; accessible?: ToolManualSummary[] } = {},
): ToolDeleteService {
  const wsDir = path.join(root, workspaceIdForBranch(DEFAULT_BRANCH));
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: workspaceIdForBranch(DEFAULT_BRANCH) })),
    getWorkspacePath: vi.fn(async () => wsDir),
  } as unknown as WorkspaceService;
  const accessControl = {
    canOwner: vi.fn(async (_ws: string, email: string, folder: string) =>
      owners.includes(email) && folder === 'Plugins/GTM',
    ),
    canRead: vi.fn(async (_ws: string, _email: string, folder: string) => !unreadableFolders.includes(folder)),
  } as unknown as IAccessControl;
  const toolManuals = {
    listAccessible: vi.fn(async () => opts.accessible ?? summaries),
    // NOT the accessible subset: this one answers the same for everybody.
    listAllSummaries: vi.fn(async () => summaries),
    invalidate: vi.fn(() => {
      invalidatedTools += 1;
    }),
  } as unknown as IToolManualService;
  const pluginIndex = {
    catalog: vi.fn(async () => catalog),
    invalidate: vi.fn(() => {
      invalidatedPlugins += 1;
    }),
  } as unknown as IPluginIndexService;
  return new ToolDeleteService(
    workspaceService,
    commits,
    accessControl,
    toolManuals,
    opts.skills ?? skillsWith({}),
    pluginIndex,
    opts.source ?? discovery([]),
    vault as never,
    KB,
    new NodeFs(),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-tool-delete-'));
  repo = path.join(root, workspaceIdForBranch(DEFAULT_BRANCH), KB);
  owners = [USER.email];
  unreadableFolders = [];
  invalidatedTools = 0;
  invalidatedPlugins = 0;
  commits = {
    runPendingCommit: vi.fn(async () => undefined),
    hasUnpushedCommits: vi.fn(async () => false),
  };
  vault = {
    countNamespace: vi.fn(async () => ({ keys: 2, signIns: 3 })),
    removeNamespace: vi.fn(async () => ({ keys: 2, signIns: 3 })),
  };
  await write('Plugins/GTM/weather.tool', '---\nid: weather\ntype: http\nurl: https://w.example\n---\n');
  await write('Plugins/GTM/mcp.json', {
    mcpServers: {
      vendor: { type: 'streamable-http', url: 'https://v.example/mcp' },
      other: { type: 'streamable-http', url: 'https://o.example/mcp' },
    },
  });
  await write('Plugins/GTM/plugin.json', {
    name: 'gtm',
    extensions: {
      'software.bevel.hexis': {
        mcpServers: {
          vendor: { headers: { Authorization: 'Bearer ${VENDOR_KEY}' } },
          other: {},
        },
      },
    },
  });
  svc = build();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the owner gate', () => {
  it('refuses a non-owner who can read the tool with 403, not a 404', async () => {
    owners = ['someone-else@x.com'];
    svc = build();
    await expect(svc.deleteTool(USER, 'weather')).rejects.toMatchObject({ status: 403 });
    await expect(svc.dependents(USER.email, 'weather')).rejects.toBeInstanceOf(ToolDeleteError);
    // Nothing was touched.
    expect(commits.runPendingCommit).not.toHaveBeenCalled();
    expect(vault.removeNamespace).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).resolves.toBeTruthy();
  });

  it('answers 404 for an unknown slug', async () => {
    await expect(svc.deleteTool(USER, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('answers the same 404 for a tool that EXISTS but the caller cannot read', async () => {
    // The slug is real; `listAccessible` just does not carry it for them —
    // which must be indistinguishable from the unknown slug above.
    svc = build({ accessible: summaries.filter((t) => t.slug !== 'weather') });
    await expect(svc.deleteTool(USER, 'weather')).rejects.toMatchObject({ status: 404 });
    await expect(svc.dependents(USER.email, 'weather')).rejects.toMatchObject({ status: 404 });
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).resolves.toBeTruthy();
  });

  it('refuses a tool held by no plugin the caller owns', async () => {
    // `Personal/notes.tool` sits under no plugin folder in the catalog.
    await expect(svc.deleteTool(USER, 'orphan')).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a plugin managed in another format', async () => {
    const external = [{ ...catalog[0]!, linksAreManaged: false }];
    catalog.splice(0, 1, ...external);
    try {
      await expect(svc.deleteTool(USER, 'weather')).rejects.toMatchObject({ status: 422 });
    } finally {
      catalog.splice(0, 1, { ...external[0]!, linksAreManaged: true });
    }
  });
});

describe('deleting a `.tool` manual', () => {
  it('removes the file, commits it, wipes the secrets and drops the catalogs', async () => {
    const result = await svc.deleteTool(USER, 'weather');
    expect(result).toEqual({ plugin: 'gtm' });
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).rejects.toThrow();
    expect(commits.runPendingCommit).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT_BRANCH),
      DEFAULT_BRANCH,
      `${KB}/Plugins/GTM/weather.tool`,
      USER,
      { systemAuthorized: true },
    );
    // Every user's secrets under the tool's namespace, declared vars included.
    expect(vault.removeNamespace).toHaveBeenCalledWith('weather_');
    expect(invalidatedTools).toBe(1);
    expect(invalidatedPlugins).toBe(1);
    // No leftover parked file beside it.
    const left = await fs.readdir(path.join(repo, 'Plugins/GTM'));
    expect(left.filter((n) => n.startsWith('.deleting-'))).toEqual([]);
  });

  it('puts the file back and keeps the secrets when NOTHING was committed', async () => {
    commits.runPendingCommit.mockRejectedValueOnce(new Error('push refused'));
    await expect(svc.deleteTool(USER, 'weather')).rejects.toThrow('push refused');
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).resolves.toBeTruthy();
    expect(vault.removeNamespace).not.toHaveBeenCalled();
  });

  it('leaves the file parked when the commit LANDED and only the push failed', async () => {
    // Restoring here would put back a file HEAD already deleted — a working
    // tree dirty against its own commit, which the next commit would re-add.
    commits.runPendingCommit.mockRejectedValueOnce(new Error('push refused'));
    commits.hasUnpushedCommits.mockResolvedValue(true);
    await expect(svc.deleteTool(USER, 'weather')).rejects.toThrow('push refused');
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).rejects.toThrow();
    const left = await fs.readdir(path.join(repo, 'Plugins/GTM'));
    expect(left.filter((n) => n.startsWith('.deleting-')).length).toBe(1);
    expect(vault.removeNamespace).not.toHaveBeenCalled();
  });
});

describe('deleting an MCP server entry', () => {
  it('removes it from both files, leaves its siblings, and commits the folder once', async () => {
    const result = await svc.deleteTool(USER, 'vendor');
    expect(result).toEqual({ plugin: 'gtm' });
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect(Object.keys(mcp.mcpServers as Record<string, unknown>)).toEqual(['other']);
    const manifest = await readJson('Plugins/GTM/plugin.json');
    const ext = (manifest.extensions as Record<string, Record<string, Record<string, unknown>>>)[
      'software.bevel.hexis'
    ]!;
    expect(Object.keys(ext.mcpServers as Record<string, unknown>)).toEqual(['other']);
    expect(commits.runPendingCommit).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT_BRANCH),
      DEFAULT_BRANCH,
      `${KB}/Plugins/GTM`,
      USER,
      { systemAuthorized: true },
    );
    expect(vault.removeNamespace).toHaveBeenCalledWith('vendor_');
  });

  it('answers 404 when the entry is already gone from mcp.json', async () => {
    await write('Plugins/GTM/mcp.json', { mcpServers: { other: { type: 'stdio', command: 'x' } } });
    await expect(svc.deleteTool(USER, 'vendor')).rejects.toMatchObject({ status: 404 });
    expect(vault.removeNamespace).not.toHaveBeenCalled();
  });
});

describe('dependents', () => {
  it('names the skills whose allowed tools reach the tool, and nothing else', async () => {
    svc = build({
      skills: skillsWith({
        forecast: ['weather_now', 'Bash'],
        report: ['weather'],
        unrelated: ['slack_post'],
        // A different manual that merely STARTS with the same letters.
        neighbour: ['weatherwatch_now'],
      }),
    });
    const d = await svc.dependents(USER.email, 'weather');
    expect(d.skills.map((s) => s.name).sort()).toEqual(['forecast', 'report']);
    expect(d.source).toBe('manual');
    expect(d.plugin).toEqual({ name: 'gtm', displayName: 'GTM' });
  });

  it('counts the stored keys and sign-ins under the name, without any value', async () => {
    const d = await svc.dependents(USER.email, 'weather');
    expect(vault.countNamespace).toHaveBeenCalledWith('weather_');
    expect(d.storedKeys).toBe(2);
    expect(d.signIns).toBe(3);
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('lists OTHER plugins that carry the tool — by link or by declaring the same server', async () => {
    svc = build({
      source: discovery([
        // The tool's own plugin is the home, never a dependent.
        { name: 'gtm', displayName: 'GTM', folder: 'Plugins/GTM', relFolder: 'GTM' },
        { name: 'sales', displayName: 'Sales', folder: 'Plugins/Sales', relFolder: 'Sales', linkedRoots: ['Plugins/GTM'] },
        { name: 'ops', displayName: 'Ops', folder: 'Plugins/Ops', relFolder: 'Ops', mcpServers: { weather: {} } },
        { name: 'none', displayName: 'None', folder: 'Plugins/None', relFolder: 'None' },
      ]),
    });
    const d = await svc.dependents(USER.email, 'weather');
    expect(d.plugins.map((p) => p.name).sort()).toEqual(['ops', 'sales']);
  });
});

describe('names that are also Object prototype members', () => {
  /**
   * `toString` is a legal tool name and a property of every object. A `name in
   * obj` test answers yes for it against ANY map, so the delete would proceed
   * against a file the server is not in, and the dialog would name plugins
   * that never declared it.
   */
  const protoSummaries: ToolManualSummary[] = [
    { slug: 'to-string', name: 'toString', path: 'Plugins/GTM/mcp.json', type: 'mcp' },
  ];

  beforeEach(async () => {
    await write('Plugins/GTM/mcp.json', { mcpServers: { other: { type: 'stdio', command: 'x' } } });
  });

  it('answers 404 rather than deleting a server only the prototype has', async () => {
    svc = build({ accessible: protoSummaries });
    await expect(svc.deleteTool(USER, 'to-string')).rejects.toMatchObject({ status: 404 });
    expect(vault.removeNamespace).not.toHaveBeenCalled();
    // The siblings are untouched.
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect(Object.keys(mcp.mcpServers as Record<string, unknown>)).toEqual(['other']);
  });

  it('does not report unrelated plugins as carrying it', async () => {
    svc = build({
      accessible: protoSummaries,
      source: discovery([
        { name: 'gtm', displayName: 'GTM', folder: 'Plugins/GTM', relFolder: 'GTM' },
        // Declares servers — just not this one.
        { name: 'ops', displayName: 'Ops', folder: 'Plugins/Ops', relFolder: 'Ops', mcpServers: { weather: {} } },
      ]),
    });
    const d = await svc.dependents(USER.email, 'to-string');
    expect(d.plugins).toEqual([]);
  });
});

describe('dependents the caller must not be told about', () => {
  function threePlugins(): PluginSource {
    return discovery([
      { name: 'gtm', displayName: 'GTM', folder: 'Plugins/GTM', relFolder: 'GTM' },
      { name: 'sales', displayName: 'Sales', folder: 'Plugins/Sales', relFolder: 'Sales', linkedRoots: ['Plugins/GTM'] },
      { name: 'secret', displayName: 'Secret', folder: 'Plugins/Secret', relFolder: 'Secret', linkedRoots: ['Plugins/GTM'] },
    ]);
  }

  it('omits a carrying plugin the caller cannot read', async () => {
    unreadableFolders = ['Plugins/Secret'];
    svc = build({ source: threePlugins() });
    const d = await svc.dependents(USER.email, 'weather');
    expect(d.plugins.map((p) => p.name)).toEqual(['sales']);
    expect(JSON.stringify(d)).not.toContain('Secret');
  });

  it('refuses rather than answering from a scan that failed', async () => {
    const broken = {
      dialect: 'native',
      discover: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    } as unknown as PluginSource;
    svc = build({ source: broken });
    await expect(svc.dependents(USER.email, 'weather')).rejects.toMatchObject({ status: 503 });
  });

  it('refuses while discovery reports a plugin it could not read', async () => {
    // "No other plugin carries it" is what the owner deletes ON — a partial
    // scan must not be allowed to say it.
    const holed = {
      dialect: 'native',
      discover: vi.fn(async () => ({
        plugins: [],
        warnings: [],
        unreadable: ['Plugins/Locked'],
        claimed: [],
      })),
    } as unknown as PluginSource;
    svc = build({ source: holed });
    await expect(svc.dependents(USER.email, 'weather')).rejects.toMatchObject({ status: 503 });
  });
});

describe('the credentials wipe', () => {
  it('retries a vault that blinks, because the definition is already gone', async () => {
    vault.removeNamespace
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({ keys: 2, signIns: 3 });
    await expect(svc.deleteTool(USER, 'weather')).resolves.toEqual({ plugin: 'gtm' });
    expect(vault.removeNamespace).toHaveBeenCalledTimes(2);
  });

  it('says the tool went but its credentials did not, when the vault will not have it', async () => {
    vault.removeNamespace.mockRejectedValue(new Error('vault down'));
    await expect(svc.deleteTool(USER, 'weather')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('could not be wiped'),
    });
    // The delete itself is not undone — HEAD has no such tool any more.
    await expect(fs.stat(path.join(repo, 'Plugins/GTM/weather.tool'))).rejects.toThrow();
  });

  it('asks for the namespace by prefix alone, claiming no variable list', async () => {
    // Which rows the prefix owns is the VAULT's rule (`isKeyInNamespace`), and
    // deliberately not a list this service assembles: a declared `_`-leading
    // variable names the same row a longer tool would, and the catalog this
    // service could consult omits whatever the scan could not read — its
    // silence is not proof that no such tool exists.
    const declaring: ToolManualSummary[] = [
      {
        slug: 'owner',
        name: 'owner',
        path: 'Plugins/GTM/owner.tool',
        type: 'http',
        variables: [{ name: 'KEY', scope: 'admin' }, { name: '_side_KEY', scope: 'admin' }],
      },
    ];
    await write('Plugins/GTM/owner.tool', '---\nid: owner\ntype: http\nurl: https://o.example\n---\n');
    svc = build({ accessible: declaring });
    await svc.deleteTool(USER, 'owner');
    expect(vault.removeNamespace).toHaveBeenCalledWith('owner_');
    expect(vault.removeNamespace).toHaveBeenCalledTimes(1);
  });
});
