import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH, personalPluginFolderName } from '@bevel-software/platform-shared';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import {
  PluginProvisionError,
  PluginProvisionService,
  pluginAccessMd,
  personalAccessMd,
} from '../plugin-provision.service.js';

const KB = 'knowledge-base';
const USER: AuthUser = { id: 'u1-abcd', email: 'ali@example.com', name: 'Ali Vega' } as AuthUser;

/**
 * The service is exercised against a REAL temp directory (the existence
 * check and the rollback are filesystem semantics, not mockable branches),
 * with the workspace, commit and access dependencies stubbed at their seams.
 */
async function makeHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-provision-'));
  const writeFile = vi.fn(
    async (_id: string, rel: string, content: string, opts?: { failIfExists?: boolean }) => {
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      try {
        await fs.writeFile(abs, content, { encoding: 'utf-8', flag: opts?.failIfExists ? 'wx' : 'w' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const conflict: Error & { status?: number } = new Error(`"${rel}" already exists.`);
          conflict.status = 409;
          throw conflict;
        }
        throw err;
      }
    },
  );
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-main' })),
    getWorkspacePath: vi.fn(async () => dir),
    writeFile,
  } as unknown as WorkspaceService;
  const commits = { runPendingCommit: vi.fn(async () => undefined) };
  const accessControl = { invalidate: vi.fn() } as unknown as IAccessControl;
  const events = { emit: vi.fn() };
  const svc = new PluginProvisionService(workspaceService, commits, accessControl, KB, events);
  return { svc, dir, commits, accessControl, events, writeFile };
}

describe('PluginProvisionService.createPlugin', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('writes the discoverable template, commits it inline, and drops the access cache', async () => {
    const result = await h.svc.createPlugin(USER, 'GTM');
    expect(result).toEqual({ folder: 'GTM', created: true });

    const accessMd = await fs.readFile(path.join(h.dir, KB, 'Plugins/GTM/access.md'), 'utf-8');
    // Discoverable FILE (frontmatter read: everyone), creator-run FOLDER
    // (body names the creator under all three verbs).
    expect(accessMd.startsWith('---\nread:\n  - everyone\n---\n')).toBe(true);
    const body = accessMd.slice(accessMd.indexOf('---\n', 4) + 4);
    for (const verb of ['read', 'write', 'owner']) {
      expect(body).toMatch(new RegExp(`${verb}:[\\s\\S]*Ali Vega <ali@example.com>`));
    }

    // The commit ran INLINE — the gate reads at HEAD, so an async commit
    // would 403 the creator's very next write into the folder.
    // `systemAuthorized`: the endpoint is the authorization — without it the
    // push gate reads origin (where the folder does not exist) and refuses
    // every non-admin the product promised a plugin to.
    expect(h.commits.runPendingCommit).toHaveBeenCalledWith(
      'ws-main',
      DEFAULT_BRANCH,
      // FOLDER-scoped: plugin.json must land in the same commit as the rules,
      // or the folder is briefly a plugin to us and not to any other client.
      `${KB}/Plugins/GTM`,
      USER,
      { systemAuthorized: true },
    );
    expect(h.accessControl.invalidate).toHaveBeenCalledWith('ws-main');
  });

  it('writes a conformant plugin.json naming the folder in slug form', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    const manifest = JSON.parse(
      await fs.readFile(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'), 'utf-8'),
    );
    expect(manifest).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'gtm',
    });
    // The schema's `name` pattern is the thing a conformant client refuses on.
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  it('refuses a taken name case-insensitively with 409', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    await expect(h.svc.createPlugin(USER, 'gtm')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a name whose manifest slug is already claimed by another folder with 409', async () => {
    // The manifest `name` is a LOSSY slug of the folder — `Sales Team` and
    // `Sales-Team` both become `sales-team` — and it is the identity a
    // conformant client keys plugins on. Folder uniqueness alone would let
    // two plugins publish one name.
    await h.svc.createPlugin(USER, 'Sales Team');
    await expect(h.svc.createPlugin(USER, 'Sales-Team')).rejects.toMatchObject({ status: 409 });
    await expect(h.svc.createPlugin(USER, 'Sales_Team')).rejects.toMatchObject({ status: 409 });
    // Only the first folder landed.
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toEqual(['Sales Team']);
    // A genuinely distinct slug still goes through.
    await expect(h.svc.createPlugin(USER, 'Sales Ops')).resolves.toEqual({
      folder: 'Sales Ops',
      created: true,
    });
  });

  it('serialises concurrent creations of two SPELLINGS of one slug — exactly one lands', async () => {
    // Different lowercased names take different name-keyed locks; only a
    // slug-keyed lock makes the twin check above hold under concurrency.
    const results = await Promise.allSettled([
      h.svc.createPlugin(USER, 'Growth Team'),
      h.svc.createPlugin(USER, 'Growth-Team'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 409,
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toHaveLength(1);
  });

  it('a loose file at the Plugins root claims no slug — "Slack Tool" is not its twin', async () => {
    // Loose files are not plugins (the catalog skips them); only a real
    // plugin FOLDER publishes a manifest identity.
    await fs.mkdir(path.join(h.dir, KB, 'Plugins'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins', 'slack.tool'), 'id: slack\n', 'utf-8');
    await expect(h.svc.createPlugin(USER, 'Slack Tool')).resolves.toEqual({
      folder: 'Slack Tool',
      created: true,
    });
  });

  it('refuses names the filesystem or the model cannot carry with 422', async () => {
    for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..', '.hidden', 'personal-anything', 'a\u0000b', 'a\tb']) {
      await expect(h.svc.createPlugin(USER, bad)).rejects.toBeInstanceOf(PluginProvisionError);
      await expect(h.svc.createPlugin(USER, bad)).rejects.toMatchObject({ status: 422 });
    }
    // Nothing landed on disk for any of them.
    await expect(fs.readdir(path.join(h.dir, KB, 'Plugins'))).rejects.toThrow();
  });

  it('serialises concurrent creations of one name in different casings — exactly one lands', async () => {
    // On a case-sensitive filesystem `GTM` and `gtm` are different paths, so
    // the wx writes alone would BOTH succeed; the per-name lock is what makes
    // the case-insensitive uniqueness hold under concurrency.
    const results = await Promise.allSettled([
      h.svc.createPlugin(USER, 'GTM'),
      h.svc.createPlugin(USER, 'gtm'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter(
      (r) => r.status === 'rejected' && (r.reason as PluginProvisionError).status === 409,
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toHaveLength(1);
  });

  it('rolls the seeded file back when the commit fails, so a retry is not told "already exists"', async () => {
    h.commits.runPendingCommit.mockRejectedValueOnce(new Error('push refused'));
    await expect(h.svc.createPlugin(USER, 'GTM')).rejects.toThrow('push refused');
    // The folder is gone again — the next attempt starts clean.
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM'))).rejects.toThrow();
    await expect(h.svc.createPlugin(USER, 'GTM')).resolves.toEqual({ folder: 'GTM', created: true });
  });
});

describe('PluginProvisionService.deletePlugin', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('removes the whole folder in ONE folder-scoped commit, and drops the access cache', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    // A plugin with content — the delete takes the skills with the folder.
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/GTM/outreach'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/GTM/outreach/SKILL.md'), '# outreach\n');
    h.commits.runPendingCommit.mockClear();
    (h.accessControl.invalidate as ReturnType<typeof vi.fn>).mockClear();

    await h.svc.deletePlugin(USER, 'GTM');

    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM'))).rejects.toThrow();
    // No parked remnant either — the commit landed, so the bytes may go.
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toEqual([]);
    // FOLDER-scoped (`git add -- <folder>` stages every deletion under it),
    // inline, and `systemAuthorized` — the endpoint already authorized the
    // delete (owner verdict), and the per-user push gate would re-read the
    // very access.md this commit removes.
    expect(h.commits.runPendingCommit).toHaveBeenCalledWith(
      'ws-main',
      DEFAULT_BRANCH,
      `${KB}/Plugins/GTM`,
      USER,
      { systemAuthorized: true },
    );
    expect(h.accessControl.invalidate).toHaveBeenCalledWith('ws-main');
    expect(h.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'fs-tree-changed' }),
    );
  });

  it('refuses an unknown name — and a casing mismatch, which is the same thing — with 404', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    for (const name of ['Nope', 'gtm']) {
      await expect(h.svc.deletePlugin(USER, name)).rejects.toMatchObject({ status: 404 });
    }
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toEqual(['GTM']);
  });

  it('never deletes a personal folder through the plugin door', async () => {
    await h.svc.ensurePersonalPlugin(USER);
    const folder = personalPluginFolderName(USER.id);
    await expect(h.svc.deletePlugin(USER, folder)).rejects.toMatchObject({ status: 404 });
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins', folder))).resolves.toBeDefined();
  });

  it('puts the folder back, content intact, when the commit is refused', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/GTM/outreach'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/GTM/outreach/SKILL.md'), '# outreach\n');
    h.commits.runPendingCommit.mockRejectedValueOnce(new Error('push refused'));

    await expect(h.svc.deletePlugin(USER, 'GTM')).rejects.toThrow('push refused');

    // A failed delete is a NO-OP: origin still carries the plugin, so the
    // working tree must too — bytes included, not just the folder shell.
    expect(
      await fs.readFile(path.join(h.dir, KB, 'Plugins/GTM/outreach/SKILL.md'), 'utf-8'),
    ).toBe('# outreach\n');
    // And the retry goes through.
    await expect(h.svc.deletePlugin(USER, 'GTM')).resolves.toBeUndefined();
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM'))).rejects.toThrow();
  });
});

describe('PluginProvisionService.ensurePersonalPlugin', () => {
  it('creates the private personal folder once, then reports it as existing', async () => {
    const h = await makeHarness();
    const folder = personalPluginFolderName(USER.id);

    const first = await h.svc.ensurePersonalPlugin(USER);
    expect(first).toEqual({ folder, created: true });
    const accessMd = await fs.readFile(
      path.join(h.dir, KB, 'Plugins', folder, 'access.md'),
      'utf-8',
    );
    // PRIVATE: no `everyone` self-grant anywhere — the file follows the
    // folder chain, and the rules close that chain to the owner alone.
    expect(accessMd).not.toContain('everyone');
    for (const verb of ['read', 'write', 'owner']) {
      expect(accessMd).toMatch(new RegExp(`${verb}:[\\s\\S]*Ali Vega <ali@example.com>`));
    }

    const second = await h.svc.ensurePersonalPlugin(USER);
    expect(second).toEqual({ folder, created: false });
    // Idempotent for real: one provision (access.md + plugin.json), one commit.
    expect(h.writeFile).toHaveBeenCalledTimes(2);
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1);
    // A personal folder is a plugin too — its id is slugged from the folder,
    // which is where a doubled separator would have produced an invalid name.
    const manifest = JSON.parse(
      await fs.readFile(path.join(h.dir, KB, 'Plugins', folder, 'plugin.json'), 'utf-8'),
    );
    expect(manifest.name).toMatch(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  });

  it('two concurrent ensures both succeed — one creates, the other reports existing', async () => {
    const h = await makeHarness();
    const folder = personalPluginFolderName(USER.id);
    const [a, b] = await Promise.all([
      h.svc.ensurePersonalPlugin(USER),
      h.svc.ensurePersonalPlugin(USER),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.folder).toBe(folder);
    expect(b.folder).toBe(folder);
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1);
  });
});

describe('access.md templates', () => {
  it('plugin template is discoverable, personal template is not — same creator grants in both', () => {
    const plugin = pluginAccessMd(USER);
    const personal = personalAccessMd(USER);
    expect(plugin).toContain('everyone');
    expect(personal).not.toContain('everyone');
    for (const text of [plugin, personal]) {
      expect(text).toContain('Ali Vega <ali@example.com>');
    }
  });
});
