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

/** Wait until a delete has parked `dir` (it is gone from its place) — the moment a racing creation may start. */
async function untilParked(dir: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await fs.stat(dir).then(() => false, () => true)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${dir} was never parked`);
}

/** Let every pending microtask and short timer run — enough for a queued lock waiter to be queued. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('PluginProvisionService.createPlugin', () => {
  let h: Awaited<ReturnType<typeof makeHarness>>;
  beforeEach(async () => {
    h = await makeHarness();
  });

  it('writes the discoverable template, commits it inline, and drops the access cache', async () => {
    const result = await h.svc.createPlugin(USER, 'GTM');
    // The folder is where it lives; the name is what it IS (the identity the
    // page navigates to and the grants spell).
    expect(result).toEqual({ folder: 'GTM', path: 'Plugins/GTM', skillsDir: 'Plugins/GTM/skills', name: 'gtm', created: true });

    const accessMd = await fs.readFile(path.join(h.dir, KB, 'Plugins/GTM/access.md'), 'utf-8');
    // Discoverable FILE (frontmatter read: everyone), creator-run FOLDER
    // (body names the creator under all three verbs) — each block saying,
    // in its own comments, what it governs and how to admit people.
    expect(accessMd.startsWith('---\n')).toBe(true);
    const close = accessMd.indexOf('\n---\n', 4);
    const frontmatter = accessMd.slice(4, close);
    const body = accessMd.slice(close + 5);
    expect(frontmatter).toMatch(/read:\n\s+- everyone/);
    expect(frontmatter).not.toContain('Ali Vega');
    expect(frontmatter).toMatch(/governs this access\.md FILE only/);
    expect(body).toMatch(/governs the PLUGIN FOLDER/);
    expect(body).toMatch(/To admit people/);
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

  it('makes a plugin INSIDE a grouping folder when one is named — the folder path is where it lives, the leaf is what it is', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/Teams/EU'), { recursive: true });
    const result = await h.svc.createPlugin(USER, 'Sales', 'Teams/EU');
    expect(result).toEqual({
      folder: 'Teams/EU/Sales',
      path: 'Plugins/Teams/EU/Sales',
      skillsDir: 'Plugins/Teams/EU/Sales/skills',
      name: 'sales',
      created: true,
    });
    const manifest = JSON.parse(await fs.readFile(path.join(h.dir, KB, 'Plugins/Teams/EU/Sales/plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('sales');
    expect(await fs.readFile(path.join(h.dir, KB, 'Plugins/Teams/EU/Sales/access.md'), 'utf-8')).toContain('Ali Vega');
    // One folder-scoped commit, at the nested path.
    expect(h.commits.runPendingCommit).toHaveBeenCalledWith('ws-main', DEFAULT_BRANCH, `${KB}/Plugins/Teams/EU/Sales`, USER, {
      systemAuthorized: true,
    });
    // Taken is judged by IDENTITY, which is global: the slug a nested plugin
    // publishes is the one a client keys it by, so the same name is taken in
    // that folder and at the root alike.
    await expect(h.svc.createPlugin(USER, 'sales', 'Teams/EU')).rejects.toMatchObject({ status: 409 });
    await expect(h.svc.createPlugin(USER, 'sales')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a parent that is not there (404), not a folder name (422), a personal space, or a plugin — a plugin cannot hold another', async () => {
    await expect(h.svc.createPlugin(USER, 'X', 'Nope')).rejects.toMatchObject({ status: 404 });
    // The NAME is judged first: a name that can never be created is refused
    // as such, whatever the parent — not as a missing folder.
    await expect(h.svc.createPlugin(USER, 'a/b', 'Nope')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.createPlugin(USER, 'X', 'a/../b')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.createPlugin(USER, 'X', '.hidden')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.createPlugin(USER, 'X', personalPluginFolderName(USER.id))).rejects.toMatchObject({ status: 422 });
    // Discovery says GTM is a plugin: nothing may be made inside it, at any depth.
    await h.svc.createPlugin(USER, 'GTM');
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/GTM/skills'), { recursive: true });
    await expect(h.svc.createPlugin(USER, 'X', 'GTM')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.createPlugin(USER, 'X', 'GTM/skills')).rejects.toMatchObject({ status: 422 });
    // A padded spelling names no folder: refused, never trimmed into one.
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/Teams'), { recursive: true });
    await expect(h.svc.createPlugin(USER, 'X', 'Teams ')).rejects.toMatchObject({ status: 422 });
    // The root, spelled as absence or as the empty string, is still the root.
    expect((await h.svc.createPlugin(USER, 'Root', '')).folder).toBe('Root');
  });

  it('writes a conformant plugin.json: the identifier in slug form, the typed name as the display name', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    const manifest = JSON.parse(
      await fs.readFile(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'), 'utf-8'),
    );
    expect(manifest).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'gtm',
      displayName: 'GTM',
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
    await expect(h.svc.createPlugin(USER, 'Sales Ops')).resolves.toMatchObject({
      folder: 'Sales Ops',
      name: 'sales-ops',
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
    await expect(h.svc.createPlugin(USER, 'Slack Tool')).resolves.toMatchObject({
      folder: 'Slack Tool',
      name: 'slack-tool',
      created: true,
    });
  });

  it('refuses names the filesystem or the model cannot carry with 422', async () => {
    for (const bad of ['', '  ', 'a/b', 'a\\b', '.', '..', '.hidden', 'personal-anything', 'Personal Abc', 'a\u0000b', 'a\tb']) {
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
    await expect(h.svc.createPlugin(USER, 'GTM')).resolves.toMatchObject({ folder: 'GTM', name: 'gtm', created: true });
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

  it('refuses a folder path the filesystem cannot carry with 422 — control characters, a reserved name, a dot-prefix', async () => {
    for (const bad of ['teams/De ep', 'a\tb', 'teams/NUL', '.deleting-x', 'teams/.hidden']) {
      await expect(h.svc.deletePlugin(USER, bad)).rejects.toMatchObject({ status: 422 });
    }
  });

  it('a bundle-shaped plugin locks on the SLUG of the name its bundle declares — the one a creation would take', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/Ext'), { recursive: true });
    // Declared as people write it, not as the marketplace publishes it.
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/Ext/plugin.bundle.json'), '{"name":"Ext Id"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/Ext/access.md'), '---\n---\n');
    let refuse: (err: Error) => void = () => {};
    h.commits.runPendingCommit.mockImplementationOnce(
      () => new Promise<undefined>((_resolve, reject) => { refuse = reject; }),
    );
    const deleting = h.svc.deletePlugin(USER, 'Ext');
    await untilParked(path.join(h.dir, KB, 'Plugins/Ext'));
    // Spelled differently, same identity: must wait for the delete, then see the twin.
    const creating = h.svc.createPlugin(USER, 'Ext Id');
    await settle();
    refuse(new Error('push refused'));
    await expect(deleting).rejects.toThrow('push refused');
    await expect(creating).rejects.toMatchObject({ status: 409 });
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/Ext/plugin.bundle.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/Ext Id'))).rejects.toThrow();
  });

  it('validates the folder path AS GIVEN — a padded spelling is refused, never trimmed into a real folder', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    for (const padded of [' GTM', 'GTM ', 'teams/ Deep']) {
      await expect(h.svc.deletePlugin(USER, padded)).rejects.toMatchObject({ status: 422 });
    }
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'))).resolves.toBeDefined();
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1); // the create above only
  });

  it('a hole ANYWHERE in discovery stops a delete — even of a plugin whose own folder was read fine', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/Other'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/Other/plugin.json'), '{"name":"other"}');
    const real = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: string, opts: unknown) =>
      String(file).endsWith(path.join('Other', 'plugin.json'))
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never);
    try {
      await expect(h.svc.deletePlugin(USER, 'GTM')).rejects.toMatchObject({ status: 503 });
    } finally {
      spy.mockRestore();
    }
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'))).resolves.toBeDefined();
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1); // the create above only
  });

  it('a manifest that is there but cannot be read stops the delete — never a guessed identity lock', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    const real = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: string, opts: unknown) =>
      String(file).endsWith(path.join('GTM', 'plugin.json'))
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never);
    try {
      // Discovery reports the hole; the delete refuses the way a creation would.
      await expect(h.svc.deletePlugin(USER, 'GTM')).rejects.toMatchObject({ status: 503 });
    } finally {
      spy.mockRestore();
    }
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'))).resolves.toBeDefined();
  });

  it('a nested plugin holds its identity against a creation at the root — taken is discovery\'s answer', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/Deep'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'), '{"name":"deep"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/access.md'), '---\n---\n');
    await expect(h.svc.createPlugin(USER, 'Deep')).rejects.toMatchObject({ status: 409 });
    await expect(h.svc.createPlugin(USER, 'Deep')).rejects.toThrow('Plugins/teams/Deep');
  });

  it('a delete and a creation of one IDENTITY never overlap — even when the identity is not the folder path', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/Deep'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'), '{"name":"deep"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/access.md'), '---\n---\n');
    // The delete's commit hangs, then is REFUSED — the folder comes back.
    let refuse: (err: Error) => void = () => {};
    h.commits.runPendingCommit.mockImplementationOnce(
      () => new Promise<undefined>((_resolve, reject) => { refuse = reject; }),
    );
    const deleting = h.svc.deletePlugin(USER, 'teams/Deep');
    await untilParked(path.join(h.dir, KB, 'Plugins/teams/Deep'));
    // A creation of the same identity, started while the folder is parked
    // and invisible: it must wait for the delete, not slip in beside it.
    const creating = h.svc.createPlugin(USER, 'Deep');
    await settle();
    refuse(new Error('push refused'));
    await expect(deleting).rejects.toThrow('push refused');
    // The delete rolled back, so `deep` is still taken — and the creation sees it.
    await expect(creating).rejects.toMatchObject({ status: 409 });
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/Deep'))).rejects.toThrow();
  });

  it('deletes a plugin whose name sits at the filesystem component limit — the park adds nothing to the name', async () => {
    // 240 characters: valid to create (≤ 255 bytes), and long enough that a
    // park spelled `.<name>.deleting-<uuid>` would not be a legal component.
    const long = 'a'.repeat(240);
    await h.svc.createPlugin(USER, long);
    await h.svc.deletePlugin(USER, long);
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toEqual([]);
  });

  it('refuses an unknown name — and a casing mismatch, which is the same thing — with 404', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    for (const name of ['Nope', 'gtm']) {
      await expect(h.svc.deletePlugin(USER, name)).rejects.toMatchObject({ status: 404 });
    }
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins'))).toEqual(['GTM']);
  });

  it('deletes a plugin nested below the root by its folder PATH, parking it beside itself', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/Deep'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'), '{"name":"deep"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/access.md'), '---\n---\n');

    await h.svc.deletePlugin(USER, 'teams/Deep');

    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/teams/Deep'))).rejects.toThrow();
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins/teams'))).toEqual([]);
    expect(h.commits.runPendingCommit).toHaveBeenCalledWith(
      'ws-main',
      DEFAULT_BRANCH,
      `${KB}/Plugins/teams/Deep`,
      USER,
      { systemAuthorized: true },
    );
    // Segments only — nothing climbs out of the root, and no backslash (a
    // second separator on Windows); a missing nested folder is unknown.
    await expect(h.svc.deletePlugin(USER, '../etc')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.deletePlugin(USER, 'teams\\Deep')).rejects.toMatchObject({ status: 422 });
    await expect(h.svc.deletePlugin(USER, 'teams/Nope')).rejects.toMatchObject({ status: 404 });
  });

  it('removes nothing but the plugin it names — a sibling that happens to look like a park survives', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/Deep'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'), '{"name":"deep"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/access.md'), '---\n---\n');
    // Whatever this is — a person's folder, the residue of a crashed run — it is not ours to delete.
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/.Deep.deleting'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/.Deep.deleting/keep.md'), 'mine');

    await h.svc.deletePlugin(USER, 'teams/Deep');

    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/teams/Deep'))).rejects.toThrow();
    expect(await fs.readFile(path.join(h.dir, KB, 'Plugins/teams/.Deep.deleting/keep.md'), 'utf-8')).toBe('mine');
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins/teams'))).toEqual(['.Deep.deleting']);
  });

  it('deletes only the exact spelling, at every depth — a stale casing must not park a replacement at the same place', async () => {
    await fs.mkdir(path.join(h.dir, KB, 'Plugins/teams/Deep'), { recursive: true });
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/plugin.json'), '{"name":"deep"}');
    await fs.writeFile(path.join(h.dir, KB, 'Plugins/teams/Deep/access.md'), '---\n---\n');

    // On a case-insensitive filesystem both of these `stat` fine — and must still be refused.
    await expect(h.svc.deletePlugin(USER, 'teams/deep')).rejects.toMatchObject({ status: 404 });
    await expect(h.svc.deletePlugin(USER, 'Teams/Deep')).rejects.toMatchObject({ status: 404 });
    expect(await fs.readdir(path.join(h.dir, KB, 'Plugins/teams'))).toEqual(['Deep']);
    expect(h.commits.runPendingCommit).not.toHaveBeenCalled();
  });

  it('a folder that cannot be LISTED is an error, never "unknown plugin" — absence and failure are different answers', async () => {
    await h.svc.createPlugin(USER, 'GTM');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) => {
      if (String(dir).endsWith('Plugins')) {
        return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      }
      return (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts);
    }) as never);
    try {
      // Discovery cannot list the root: a hole, refused as such — never "unknown plugin" (404).
      await expect(h.svc.deletePlugin(USER, 'GTM')).rejects.toMatchObject({ status: 503 });
      await expect(h.svc.createPlugin(USER, 'Ops')).rejects.toMatchObject({ status: 503 });
    } finally {
      spy.mockRestore();
    }
    // Nothing moved, nothing committed: the plugin is exactly where it was.
    await expect(fs.stat(path.join(h.dir, KB, 'Plugins/GTM/plugin.json'))).resolves.toBeDefined();
    expect(h.commits.runPendingCommit).toHaveBeenCalledTimes(1); // the create above only
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
    expect(first).toEqual({
      folder,
      path: `Plugins/${folder}`,
      skillsDir: `Plugins/${folder}/skills`,
      name: folder,
      created: true,
    });
    const accessMd = await fs.readFile(
      path.join(h.dir, KB, 'Plugins', folder, 'access.md'),
      'utf-8',
    );
    // PRIVATE: the frontmatter grants nobody (the space is listed for no one
    // else), and the body denies `everyone` — so a root-level `read: everyone`
    // an admin adds later cannot open it — naming the owner and nobody else,
    // Admin included.
    const close = accessMd.indexOf('\n---\n', 4);
    const frontmatter = accessMd.slice(4, close);
    const body = accessMd.slice(close + 5);
    expect(frontmatter).not.toContain('everyone');
    expect(frontmatter).not.toContain('Ali Vega');
    expect(body).toMatch(/read:\n(?:\s+#.*\n)*\s+- deny everyone\n/);
    expect(body).not.toMatch(/^\s+- Admin/m);
    for (const verb of ['read', 'write', 'owner'] as const) {
      expect(verbBlock(body, verb)).toContain('Ali Vega <ali@example.com>');
    }

    const second = await h.svc.ensurePersonalPlugin(USER);
    expect(second).toMatchObject({ folder, path: `Plugins/${folder}`, created: false });
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

/**
 * One verb's block of an access.md region — from `<verb>:` up to the next
 * verb key or the end — so an assertion about a grant under `write:` cannot
 * be satisfied by the same line under `owner:`.
 */
function verbBlock(region: string, verb: 'read' | 'write' | 'owner'): string {
  const match = region.match(new RegExp(`(?:^|\\n)${verb}:[\\s\\S]*?(?=\\n(?:read|write|download|owner):|$)`));
  if (!match) throw new Error(`no ${verb}: block in\n${region}`);
  return match[0];
}

describe('access.md templates', () => {
  it('plugin template is discoverable, personal template denies everyone — same creator grants in both bodies', () => {
    const plugin = pluginAccessMd(USER);
    const personal = personalAccessMd(USER);
    const split = (text: string) => {
      const close = text.indexOf('\n---\n', 4);
      return { frontmatter: text.slice(4, close), body: text.slice(close + 5) };
    };
    expect(split(plugin).frontmatter).toMatch(/read:\n\s+- everyone/);
    expect(split(personal).frontmatter).not.toContain('everyone');
    expect(split(personal).body).toMatch(/- deny everyone\n/);
    expect(split(personal).body).not.toMatch(/^\s+- Admin/m);
    for (const text of [plugin, personal]) {
      for (const verb of ['read', 'write', 'owner'] as const) {
        expect(verbBlock(split(text).body, verb)).toContain('Ali Vega <ali@example.com>');
      }
      expect(split(text).frontmatter).not.toContain('Ali Vega');
    }
  });
});
