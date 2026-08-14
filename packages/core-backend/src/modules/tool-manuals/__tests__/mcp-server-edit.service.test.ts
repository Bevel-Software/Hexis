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
    expect(ext.mcpServers.vendor.headers).toEqual({ 'X-Key': '${SNEAKY}' });
  });

  it('renames across BOTH files, refusing a taken key', async () => {
    await svc.putServer(USER, 'vendor', {
      newName: 'vendor_eu',
      transport: 'streamable-http',
      url: 'https://v.example/mcp',
      authHeaders: { Authorization: 'Bearer ${VENDOR_KEY}' },
    });
    const mcp = await readJson('Plugins/GTM/mcp.json');
    expect(Object.keys(mcp.mcpServers as object)).toEqual(['vendor_eu']);
    const manifest = await readJson('Plugins/GTM/plugin.json');
    const servers = (manifest.extensions as Record<string, { mcpServers: object }>)['software.bevel.hexis']
      .mcpServers;
    expect(Object.keys(servers)).toEqual(['vendor_eu']);
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
