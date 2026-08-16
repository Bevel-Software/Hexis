import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH, type AuthUser } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IToolManualService, ToolManualSummary } from '../tool-manuals.contract.js';
import { McpServerEditService } from '../mcp-server-edit.service.js';

const KB = 'knowledge-base';
const USER: AuthUser = { id: 'u-1', email: 'ali@example.com', name: 'Ali' } as AuthUser;

let root: string;
let repo: string;
let svc: McpServerEditService;
let commits: { runPendingCommit: ReturnType<typeof vi.fn> };
let canWrite: boolean;
let invalidated: number;

/** Summaries the locate step reads — mirrors what mcp.json discovery yields. */
const summaries: ToolManualSummary[] = [
  { slug: 'vendor', name: 'vendor', path: 'Plugins/GTM/mcp.json', type: 'mcp' },
  { slug: 'legacy', name: 'legacy', path: 'Plugins/GTM/software.bevel.hexis/tools/legacy.tool', type: 'mcp' },
];

async function write(rel: string, content: unknown): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(content, null, 2), 'utf-8');
}

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(repo, rel), 'utf-8'));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-mcp-edit-'));
  const wsDir = path.join(root, workspaceIdForBranch(DEFAULT_BRANCH));
  repo = path.join(wsDir, KB);
  canWrite = true;
  invalidated = 0;
  commits = { runPendingCommit: vi.fn(async () => undefined) };

  await write('Plugins/GTM/mcp.json', {
    mcpServers: {
      vendor: { type: 'streamable-http', url: 'https://v.example/mcp', headers: { 'X-V': '2' } },
    },
  });
  await write('Plugins/GTM/plugin.json', {
    name: 'gtm',
    extensions: {
      'software.bevel.hexis': {
        mcpServers: {
          vendor: {
            headers: { Authorization: 'Bearer ${VENDOR_KEY}' },
            variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
          },
        },
      },
    },
  });

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: workspaceIdForBranch(DEFAULT_BRANCH) })),
    getWorkspacePath: vi.fn(async () => wsDir),
  } as unknown as WorkspaceService;
  const accessControl = {
    canWrite: vi.fn(async () => canWrite),
  } as unknown as IAccessControl;
  const toolManuals = {
    listAccessible: vi.fn(async () => summaries),
    invalidate: vi.fn(() => {
      invalidated += 1;
    }),
  } as unknown as IToolManualService;

  svc = new McpServerEditService(workspaceService, commits, accessControl, toolManuals, KB);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('getServer', () => {
  it('merges both files into one view', async () => {
    const view = await svc.getServer(USER.email, 'vendor');
    expect(view).toMatchObject({
      name: 'vendor',
      transport: 'streamable-http',
      url: 'https://v.example/mcp',
      literalHeaders: { 'X-V': '2' },
      authHeaders: { Authorization: 'Bearer ${VENDOR_KEY}' },
      variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
      local: false,
      canWrite: true,
    });
  });

  it('shape-checks hand-editable fields — malformed values read as empty, not as nonsense', async () => {
    await write('Plugins/GTM/plugin.json', {
      name: 'gtm',
      extensions: {
        'software.bevel.hexis': {
          // A string where an array/object belongs — the form would `.map`
          // and `Object.entries` these; they must arrive as empty instead.
          mcpServers: { vendor: { headers: 'oops', variables: 'not-an-array' } },
        },
      },
    });
    const view = await svc.getServer(USER.email, 'vendor');
    expect(view?.variables).toEqual([]);
    expect(view?.authHeaders).toEqual({});
  });

  it('answers null for an unknown slug and for a legacy .tool-backed manual alike', async () => {
    expect(await svc.getServer(USER.email, 'nope')).toBeNull();
    // A `.tool`-backed mcp manual predates the authoritative file; the form
    // has no pair of files to edit for it, so it is not editable here.
    expect(await svc.getServer(USER.email, 'legacy')).toBeNull();
  });
});

describe('putServer', () => {
  it('rewrites both files and commits the folder once', async () => {
    await svc.putServer(USER, 'vendor', {
      transport: 'streamable-http',
      url: 'https://v2.example/mcp',
      literalHeaders: { 'X-V': '3' },
      authHeaders: { Authorization: 'Bearer ${VENDOR_KEY}' },
      variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
    });
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect((mcp.mcpServers as Record<string, unknown>).vendor).toEqual({
      type: 'streamable-http',
      url: 'https://v2.example/mcp',
      headers: { 'X-V': '3' },
    });
    expect(commits.runPendingCommit).toHaveBeenCalledTimes(1);
    expect(commits.runPendingCommit).toHaveBeenCalledWith(
      workspaceIdForBranch(DEFAULT_BRANCH),
      DEFAULT_BRANCH,
      `${KB}/Plugins/GTM`,
      USER,
    );
    expect(invalidated).toBe(1);
  });

  it('reroutes a ${VAR} that arrives in the literal headers — mcp.json never carries one', async () => {
    await svc.putServer(USER, 'vendor', {
      transport: 'streamable-http',
      url: 'https://v.example/mcp',
      literalHeaders: { 'X-Key': '${SNEAKY}' },
    });
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect((mcp.mcpServers as Record<string, { headers?: unknown }>).vendor.headers).toBeUndefined();
    const manifest = await readJson('Plugins/GTM/plugin.json');
    const ext = (manifest.extensions as Record<string, { mcpServers: Record<string, { headers?: unknown }> }>)[
      'software.bevel.hexis'
    ];
    // The rerouted header lands BESIDE the stored auth (omitted, so kept) —
    // rerouting must add to the extensions half, not replace it.
    expect(ext.mcpServers.vendor.headers).toEqual({
      Authorization: 'Bearer ${VENDOR_KEY}',
      'X-Key': '${SNEAKY}',
    });
  });

  it('renames across BOTH files, carrying every omitted field to the new key', async () => {
    await svc.putServer(USER, 'vendor', {
      newName: 'vendor_eu',
      transport: 'streamable-http',
      url: 'https://v.example/mcp',
      authHeaders: { Authorization: 'Bearer ${VENDOR_KEY}' },
    });
    // FULL file contents, not just the key set: a rename that dropped the
    // literal header or the variable declaration would still move the key.
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect(mcp.mcpServers).toEqual({
      vendor_eu: {
        type: 'streamable-http',
        url: 'https://v.example/mcp',
        headers: { 'X-V': '2' },
      },
    });
    const manifest = await readJson('Plugins/GTM/plugin.json');
    const servers = (
      manifest.extensions as Record<string, { mcpServers: Record<string, unknown> }>
    )['software.bevel.hexis'].mcpServers;
    expect(servers).toEqual({
      vendor_eu: {
        headers: { Authorization: 'Bearer ${VENDOR_KEY}' },
        variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
      },
    });
  });

  it('preserves fields the write does not surface, and clears on explicit empties', async () => {
    // Nothing surfaced beyond the transport: everything stored survives.
    await svc.putServer(USER, 'vendor', { transport: 'streamable-http' });
    let mcp = await readJson('Plugins/GTM/mcp.json');
    expect((mcp.mcpServers as Record<string, unknown>).vendor).toEqual({
      type: 'streamable-http',
      url: 'https://v.example/mcp',
      headers: { 'X-V': '2' },
    });
    let manifest = await readJson('Plugins/GTM/plugin.json');
    let servers = (
      manifest.extensions as Record<string, { mcpServers: Record<string, unknown> }>
    )['software.bevel.hexis'].mcpServers;
    expect(servers.vendor).toEqual({
      headers: { Authorization: 'Bearer ${VENDOR_KEY}' },
      variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
    });

    // Present-but-empty is an explicit CLEAR, not an omission.
    await svc.putServer(USER, 'vendor', {
      transport: 'streamable-http',
      literalHeaders: {},
      authHeaders: {},
      variables: [],
    });
    mcp = await readJson('Plugins/GTM/mcp.json');
    expect((mcp.mcpServers as Record<string, unknown>).vendor).toEqual({
      type: 'streamable-http',
      url: 'https://v.example/mcp',
    });
    manifest = await readJson('Plugins/GTM/plugin.json');
    servers = (
      manifest.extensions as Record<string, { mcpServers: Record<string, unknown> }>
    )['software.bevel.hexis'].mcpServers;
    // An emptied extension entry is REMOVED, not left as `{}`.
    expect(servers.vendor).toBeUndefined();
  });

  it('refuses a rename onto a taken key with 409, committing nothing', async () => {
    // A second server occupies the target name.
    const mcp = await readJson('Plugins/GTM/mcp.json');
    (mcp.mcpServers as Record<string, unknown>).vendor_eu = {
      type: 'streamable-http',
      url: 'https://eu.example/mcp',
    };
    await fs.writeFile(path.join(repo, 'Plugins/GTM/mcp.json'), JSON.stringify(mcp), 'utf-8');
    await expect(
      svc.putServer(USER, 'vendor', { newName: 'vendor_eu', transport: 'streamable-http', url: 'https://v.example/mcp' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(commits.runPendingCommit).not.toHaveBeenCalled();
    // The original key survives untouched.
    const after = await readJson('Plugins/GTM/mcp.json');
    expect(Object.keys(after.mcpServers as object).sort()).toEqual(['vendor', 'vendor_eu']);
  });

  it('refuses without write access, an invalid name, and a bad URL', async () => {
    canWrite = false;
    await expect(
      svc.putServer(USER, 'vendor', { transport: 'streamable-http', url: 'https://v.example' }),
    ).rejects.toMatchObject({ status: 403 });
    canWrite = true;
    await expect(
      svc.putServer(USER, 'vendor', { newName: 'Bad Name', transport: 'streamable-http', url: 'https://v.example' }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      svc.putServer(USER, 'vendor', { transport: 'streamable-http', url: 'not-a-url' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(commits.runPendingCommit).not.toHaveBeenCalled();
  });

  it('422s a malformed variables declaration instead of persisting a server discovery will drop', async () => {
    // Discovery's own validator, at save time: each of these shapes would
    // save fine and then make the whole server vanish from the catalog on
    // the next scan.
    const bad: unknown[] = [
      [{ name: 'bad name!', scope: 'user' }], // name outside [A-Za-z0-9_]+
      [{ name: 'API_URL', scope: 'admin' }], // platform-seeded name re-declared
      [{ name: 'K', scope: 'user' }, { name: 'K', scope: 'admin' }], // duplicate
      [{ name: 'K', scope: 'team' }], // unknown scope
      [
        {
          name: 'K',
          scope: 'admin', // oauth demands per-caller scope
          oauth: { authorizationUrl: 'https://v.example/auth', tokenUrl: 'https://v.example/token', clientId: 'c' },
        },
      ],
      [
        {
          name: 'K',
          scope: 'user', // whitespace-only clientId — same rule as discovery
          oauth: { authorizationUrl: 'https://v.example/auth', tokenUrl: 'https://v.example/token', clientId: '   ' },
        },
      ],
    ];
    const before = await readJson('Plugins/GTM/plugin.json');
    for (const variables of bad) {
      await expect(
        svc.putServer(USER, 'vendor', {
          transport: 'streamable-http',
          url: 'https://v.example/mcp',
          variables: variables as never,
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
    // Nothing landed: no commit, no file change.
    expect(commits.runPendingCommit).not.toHaveBeenCalled();
    expect(await readJson('Plugins/GTM/plugin.json')).toEqual(before);
  });

  it('writes a stdio entry with command/args and no url', async () => {
    await svc.putServer(USER, 'vendor', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'indexer'],
    });
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect((mcp.mcpServers as Record<string, unknown>).vendor).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'indexer'],
    });
  });
});
