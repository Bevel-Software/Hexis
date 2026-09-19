import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginDisplayNameOf, pluginIdentityOf, type AuthUser } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';
import { PluginProvisionService } from '../plugin-provision.service.js';
import { createPluginCreationRoutes } from '../plugins.routes.js';
import { CREATE_PLUGIN } from '../plugins.tools.js';

/**
 * Both doors into plugin creation, through the code each one really runs.
 *
 * The dialog POSTs `/api/plugins`; the `create_plugin` tool is a UTCP
 * DESCRIPTION of that same endpoint — its call template names the URL and
 * carries the agent's arguments in the request body. So "the two paths" is
 * one endpoint reached two ways, and what this file holds is that neither
 * way can quietly derive a different name: the manifest each writes, and the
 * answer each gives back, are the same for the same typed name.
 *
 * Each door gets its own knowledge base, because the point is that ONE name
 * typed into either produces one file — which two doors into a single tree
 * could never be asked, the second being refused as a duplicate.
 */

const KB = 'knowledge-base';
const ALICE: AuthUser = { id: 'u-alice', email: 'alice@x.io', name: 'Alice' } as AuthUser;

/** The URL the tool definition points a caller at, with the placeholder resolved. */
function toolUrl(base: string): string {
  return (CREATE_PLUGIN.tool_call_template as { url: string }).url.replace('${API_URL}', base);
}

interface Harness {
  dir: string;
  svc: PluginProvisionService;
  baseUrl: string;
  manifestOf(folder: string): Promise<Record<string, unknown>>;
  /** The dialog's door: a POST of the body its form builds. */
  byDialog(name: string, parent?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  /** The agent's door: the tool's OWN call template — its URL, its body field. */
  byTool(name: string, parent?: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

const open: (() => Promise<void>)[] = [];

/** The real provisioning service over a real temp tree, behind the real route. */
async function makeHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-create-names-'));
  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: 'ws-main' }),
    getWorkspacePath: async () => dir,
    writeFile: async (_id: string, rel: string, content: string, opts?: { failIfExists?: boolean }) => {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fs.writeFile(abs, content, { encoding: 'utf-8', flag: opts?.failIfExists ? 'wx' : 'w' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw Object.assign(new Error(`"${rel}" already exists.`), { status: 409 });
        }
        throw err;
      }
    },
  } as unknown as WorkspaceService;
  const svc = new PluginProvisionService(
    workspaceService,
    { runPendingCommit: vi.fn(async () => undefined) },
    { invalidate: vi.fn() } as unknown as IAccessControl,
    KB,
    undefined,
    new KbPluginSource(new NodeFs()),
    new NodeFs(),
  );

  const app = express();
  app.use(express.json());
  app.use('/api', createPluginCreationRoutes(svc, async () => ALICE));
  const httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

  open.push(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const post = async (url: string, name: string, parent?: string) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parent }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  return {
    dir,
    svc,
    baseUrl,
    manifestOf: async (folder) =>
      JSON.parse(await fs.readFile(path.join(dir, KB, 'Plugins', folder, 'plugin.json'), 'utf-8')),
    byDialog: (name, parent) => post(`${baseUrl}/api/plugins`, name, parent),
    // `body_field: 'body'` — the agent calls `create_plugin({ body: {...} })`
    // and the transport posts that object as the request body.
    byTool: (name, parent) => post(toolUrl(baseUrl), name, parent),
  };
}

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

describe('creation derives and stores the display name the same way through every door', () => {
  it('stores the name the creator typed, whichever door they came through', async () => {
    const dialog = await makeHarness();
    const tool = await makeHarness();
    const fromDialog = await dialog.byDialog('Sales Team');
    const fromTool = await tool.byTool('Sales Team');
    expect([fromDialog.status, fromTool.status]).toEqual([201, 201]);

    const dialogManifest = await dialog.manifestOf('Sales Team');
    const toolManifest = await tool.manifestOf('Sales Team');
    // The same file: one renderer, one rule, whatever reached it.
    expect(dialogManifest).toEqual(toolManifest);
    expect(dialogManifest).toMatchObject({ name: 'sales-team', displayName: 'Sales Team' });
    // And the same answer, folder path aside.
    expect(fromDialog.body).toEqual(fromTool.body);

    // Each answer agrees with the file it wrote, field for field.
    for (const [answer, manifest] of [
      [fromDialog.body, dialogManifest],
      [fromTool.body, toolManifest],
    ] as const) {
      expect(answer.name).toBe(manifest.name);
      expect(answer.displayName).toBe(manifest.displayName);
      expect(answer.displayName).toBe('Sales Team');
    }
  });

  it('derives it the same way inside a grouping folder as at the root', async () => {
    const h = await makeHarness();
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/Teams'), { recursive: true });
    const nested = await h.byTool('Sales Team', 'Teams');
    expect(nested.status).toBe(201);
    expect(nested.body).toMatchObject({
      folder: 'Teams/Sales Team',
      name: 'sales-team',
      displayName: 'Sales Team',
    });
    // Where a plugin LIVES is not an input to what it is called: the leaf is.
    expect(await h.manifestOf('Teams/Sales Team')).toMatchObject({
      name: 'sales-team',
      displayName: 'Sales Team',
    });
  });

  it('stores it even when the typed name IS the identifier and IS the folder', async () => {
    // The case the old rule dropped the field for — and then read the folder
    // back to fill the gap.
    const h = await makeHarness();
    const { body } = await h.byDialog('design');
    const manifest = await h.manifestOf('design');
    expect(manifest).toMatchObject({ name: 'design', displayName: 'design' });
    expect(body).toMatchObject({ name: 'design', displayName: 'design' });
    expect(pluginDisplayNameOf(manifest)).toBe('design');
  });

  it('trims what was typed, and the folder takes the trimmed spelling too', async () => {
    const h = await makeHarness();
    const { body } = await h.byTool('  Growth Lab  ');
    expect(body).toMatchObject({ folder: 'Growth Lab', name: 'growth-lab', displayName: 'Growth Lab' });
    expect(await h.manifestOf('Growth Lab')).toMatchObject({ name: 'growth-lab', displayName: 'Growth Lab' });
  });

  it('agrees with the discovery source and the shared reader about both names', async () => {
    const h = await makeHarness();
    await h.byDialog('Sales Team');
    await h.byTool('design');
    // `access.md` is what makes a folder exist to discovery; provisioning
    // wrote it, so the catalog sees both plugins.
    const { plugins } = await new KbPluginSource(new NodeFs()).discover(path.join(h.dir, KB));
    // Walk order, which is the folders' — `design` before `Sales Team`.
    expect(plugins.map((p) => [p.name, p.displayName])).toEqual([
      ['design', 'design'],
      ['sales-team', 'Sales Team'],
    ]);
    for (const plugin of plugins) {
      // The shared reader, given only the manifest, says exactly what
      // discovery reported — the folder is an input to neither.
      expect(pluginIdentityOf(plugin.manifest, 'a-completely-different-folder')).toBe(plugin.name);
      expect(pluginDisplayNameOf(plugin.manifest)).toBe(plugin.displayName);
    }
  });

  it('the personal folder carries both names too — it publishes a manifest like any plugin', async () => {
    const h = await makeHarness();
    const answer = await h.svc.ensurePersonalPlugin(ALICE);
    expect(answer).toMatchObject({ name: 'personal-u-alice', displayName: 'personal-u-alice' });
    expect(await h.manifestOf('personal-u-alice')).toMatchObject({
      name: 'personal-u-alice',
      displayName: 'personal-u-alice',
    });
  });

  it('an ensure that finds the folder answers with the manifest, not the folder spelling', async () => {
    const h = await makeHarness();
    await h.svc.ensurePersonalPlugin(ALICE);
    // Somebody labelled their own space. The folder is keyed to a user id and
    // never moves, but the manifest is the only thing that says what it is
    // called — so the ensure has to read it.
    const manifestPath = path.join(h.dir, KB, 'Plugins/personal-u-alice/plugin.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ name: 'personal-u-alice', displayName: "Alice's space" }, null, 2),
    );

    const again = await h.svc.ensurePersonalPlugin(ALICE);
    expect(again).toMatchObject({
      created: false,
      name: 'personal-u-alice',
      displayName: "Alice's space",
    });
    // And the ensure wrote nothing: the label is still the one on disk.
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf-8')).displayName).toBe("Alice's space");
  });

  it("the tool's declared output promises the display name it now returns", async () => {
    const h = await makeHarness();
    const outputs = CREATE_PLUGIN.outputs as { properties: Record<string, unknown> };
    expect(Object.keys(outputs.properties)).toContain('displayName');
    const { body } = await h.byTool('Ops Desk');
    for (const field of Object.keys(outputs.properties)) expect(body).toHaveProperty(field);
  });
});
