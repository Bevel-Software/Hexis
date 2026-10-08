import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT, type AuthUser, type IWorkflowService, type KbLayout } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceMutex } from '../../kb-fs/mutex.js';
import { KbPluginSource } from '../../plugins/discovery/kb-plugin-source.js';
import { CLAIM_TTL_MS, StarterPackError, StarterPackService, commitSubjectOf, summaryOf } from '../starter-pack.service.js';

/**
 * The starter-pack question end to end against a real checkout folder, with
 * the lock/commit pipeline and the admin check stubbed at their seams:
 * who is asked and when, that a choice is ONE commit of only what is absent,
 * under the deployment's own folder names, with the plugin run by the admin
 * who chose it — and that the question is not asked twice.
 */

const KB = 'knowledge-base';
const ADMIN: AuthUser = { id: 'u-admin', email: 'ada@example.com', name: 'Ada Admin' } as AuthUser;
const MEMBER: AuthUser = { id: 'u-member', email: 'mo@example.com', name: 'Mo Member' } as AuthUser;

const SHIPPED_ACCESS = ['---', 'read:', '  - everyone', '---', 'read:', '  - everyone', 'write:', '  - Admin', ''].join('\n');

let packsDir = '';
let wsDir = '';

async function put(base: string, rel: string, content: string): Promise<void> {
  const abs = path.join(base, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

/**
 * `store` stands for the deployment-settings table: pass one to two
 * harnesses and they are two replicas sharing a database.
 */
function harness({
  layout = DEFAULT_KB_LAYOUT as KbLayout,
  admins = [ADMIN.email],
  store = {} as Record<string, string>,
} = {}) {
  const settings = {
    reload: vi.fn(async (key: string) => store[key] ?? ''),
    record: vi.fn(async (entries: Record<string, string>) => {
      Object.assign(store, entries);
    }),
    recordIfAbsent: vi.fn(async (key: string, value: string) => {
      if (key in store) return false;
      store[key] = value;
      return true;
    }),
    swapIfValue: vi.fn(async (key: string, expected: string, next: string | null) => {
      if (store[key] !== expected) return false;
      if (next === null) delete store[key];
      else store[key] = next;
      return true;
    }),
  };
  const kb = testKbContext({ kbDirName: KB, layout });
  // The plugin creation's identity lock, as `PluginProvisionService.withIdentities` keys it.
  const locks = new WorkspaceMutex();
  /** The keys the service asked for, in order — noted before the lock is granted. */
  const lockRequests: string[] = [];
  const pluginLocks = {
    withIdentities: <T>(names: string[], fn: () => Promise<T>) => {
      const keys = names.map((n) => `plugin:${n.toLowerCase()}`);
      lockRequests.push(...keys);
      return locks.runAll(keys, fn);
    },
  };
  const workflow = {
    acquireLock: vi.fn(async () => ({ acquired: true, lock: { holderName: 'x' } })),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
    releaseLockUntouched: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => ({ sha: 'abc' })),
  };
  const events = { emit: vi.fn() };
  /** Who may read what: everything, unless a test narrows it by repo-relative path. */
  const unreadable = new Set<string>();
  const accessControl = {
    invalidate: vi.fn(),
    canReadBatch: vi.fn(async (_ws: string, _email: string, paths: string[]) =>
      new Map(paths.map((p) => [p, !unreadable.has(p)])),
    ),
  };
  const svc = new StarterPackService({
    packsDir,
    kb,
    pluginSource: new KbPluginSource(new NodeFs(), kb),
    pluginLocks,
    workspaceService: {
      getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-main' })),
      getWorkspacePath: vi.fn(async () => wsDir),
      hasBootstrappedWorkspace: vi.fn(async () => true),
    } as never,
    workflow: workflow as unknown as IWorkflowService,
    adminAccess: { isAdmin: async (email) => admins.includes(email ?? '') },
    settings: settings as never,
    accessControl,
    events,
  });
  return { svc, store, settings, locks, lockRequests, workflow, events, accessControl, unreadable };
}

beforeEach(async () => {
  packsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-packs-'));
  wsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-pack-ws-'));
  await put(
    packsDir,
    'sales/pack.yaml',
    [
      'id: sales',
      'name: Sales',
      'description: Pages about what you sell.',
      'order: 2',
      'firstPagePrompt: Fill in the Customers page.',
      'suggestedPages: [About us, Customers]',
    ].join('\n'),
  );
  await put(packsDir, 'sales/KnowledgeBase/About us.md', '# About us\n\nAsk your agent: _Draft this_\n');
  await put(packsDir, 'sales/KnowledgeBase/Customers.md', '# Customers\n');
  await put(packsDir, 'sales/Plugins/sales-starter/plugin.json', '{"name":"sales-starter","displayName":"Sales starter"}\n');
  await put(packsDir, 'sales/Plugins/sales-starter/access.md', SHIPPED_ACCESS);
  await put(packsDir, 'sales/Plugins/sales-starter/LICENSE', 'Apache-2.0\n');
  await put(packsDir, 'sales/Plugins/sales-starter/skills/call-prep/SKILL.md', '---\nname: call-prep\n---\n');
  await put(packsDir, 'sales/Plugins/sales-starter/skills/forecast/SKILL.md', '---\nname: forecast\n---\n');
  // The seeded knowledge base: nothing but the starter guide.
  await put(wsDir, `${KB}/KnowledgeBase/How to get started.md`, '# How to get started\n');
  await put(wsDir, `${KB}/Plugins/.gitkeep`, '');
});

afterEach(async () => {
  await fs.rm(packsDir, { recursive: true, force: true });
  await fs.rm(wsDir, { recursive: true, force: true });
});

describe('who is asked', () => {
  it('an admin of a new knowledge base, with the packs as chips', async () => {
    const { svc } = harness();
    expect(await svc.status(ADMIN)).toEqual({
      offered: true,
      chosen: null,
      packs: [{ id: 'sales', name: 'Sales', description: 'Pages about what you sell.', order: 2 }],
      chosenPack: null,
    });
  });

  it('never a member, who is not shown the packs either', async () => {
    const { svc } = harness();
    expect(await svc.status(MEMBER)).toMatchObject({ offered: false, packs: [] });
  });

  it('still asks an admin who may not read the one page there is: it is not theirs to know of', async () => {
    const { svc, unreadable } = harness();
    await put(wsDir, `${KB}/KnowledgeBase/Leadership/Plan.md`, '# Plan\n');
    unreadable.add('KnowledgeBase/Leadership');
    expect((await svc.status(ADMIN)).offered).toBe(true);
    unreadable.clear();
    expect((await svc.status(ADMIN)).offered).toBe(false);
  });

  it('nobody once the knowledge base has a page', async () => {
    await put(wsDir, `${KB}/KnowledgeBase/Team/Roadmap.md`, '# Roadmap\n');
    const { svc } = harness();
    expect((await svc.status(ADMIN)).offered).toBe(false);
  });

  it('nobody once the question was answered, skip included', async () => {
    const { svc, store } = harness();
    store.starterPack = 'none';
    expect(await svc.status(ADMIN)).toMatchObject({ offered: false, chosen: 'none', chosenPack: null });
  });

  it('nobody when there are no packs to offer', async () => {
    await fs.rm(packsDir, { recursive: true, force: true });
    const { svc } = harness();
    expect((await svc.status(ADMIN)).offered).toBe(false);
  });
});

describe('choosing a pack', () => {
  it('adds the pack in ONE commit by the admin, records the choice, and refreshes the tree', async () => {
    const { svc, store, settings, workflow, events, accessControl } = harness();

    const applied = await svc.choose(ADMIN, 'sales');

    // The claim is taken BEFORE the write, so another replica's is found and
    // nothing is written twice; it is released once the choice is recorded.
    expect(settings.recordIfAbsent).toHaveBeenCalledWith('starterPackClaim', expect.stringMatching(/^u-admin \d+$/), ADMIN.id);
    expect(settings.recordIfAbsent.mock.invocationCallOrder[0]!).toBeLessThan(
      workflow.commitChanges.mock.invocationCallOrder[0]!,
    );
    expect(settings.record.mock.invocationCallOrder[0]!).toBeGreaterThan(workflow.commitChanges.mock.invocationCallOrder[0]!);
    expect(store.starterPackClaim).toBeUndefined();

    expect(applied).toEqual({ id: 'sales', name: 'Sales', pages: 2, skills: 2, summary: 'Added 2 pages and 2 skills for Sales.' });
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    const [wsId, author, subject, paths] = workflow.commitChanges.mock.calls[0] as unknown as [string, AuthUser, string, string[]];
    expect([wsId, author, subject]).toEqual(['ws-main', ADMIN, 'Add starter pages and skills for Sales']);
    expect(paths).toEqual([
      `${KB}/KnowledgeBase/About us.md`,
      `${KB}/KnowledgeBase/Customers.md`,
      `${KB}/Plugins/sales-starter/LICENSE`,
      `${KB}/Plugins/sales-starter/access.md`,
      `${KB}/Plugins/sales-starter/plugin.json`,
      `${KB}/Plugins/sales-starter/skills/call-prep/SKILL.md`,
      `${KB}/Plugins/sales-starter/skills/forecast/SKILL.md`,
    ]);
    expect(store.starterPack).toBe('sales');
    expect(accessControl.invalidate).toHaveBeenCalledWith('ws-main');
    expect(events.emit).toHaveBeenCalledWith({ kind: 'fs-tree-changed', workspaceId: 'ws-main', branch: 'target-company-state' });
  });

  it('runs the plugin by the admin who chose it, on top of the rules the pack ships', async () => {
    const { svc } = harness();
    await svc.choose(ADMIN, 'sales');

    const access = await fs.readFile(path.join(wsDir, KB, 'Plugins/sales-starter/access.md'), 'utf8');
    const body = access.split('---').pop()!;
    // The team still uses it; the admin reads, changes and owns it.
    expect(body).toMatch(/read:\n(\s+- .+\n)*\s+- everyone/);
    for (const verb of ['read', 'write', 'owner']) {
      expect(body).toMatch(new RegExp(`${verb}:\\n(\\s+- .+\\n)*\\s+- Ada Admin <ada@example.com>`));
    }
  });

  it('gives a pack plugin without rules or a manifest the ones "Create a plugin" writes', async () => {
    await fs.rm(path.join(packsDir, 'sales/Plugins/sales-starter/access.md'));
    await fs.rm(path.join(packsDir, 'sales/Plugins/sales-starter/plugin.json'));
    const { svc } = harness();
    await svc.choose(ADMIN, 'sales');

    const manifest = JSON.parse(await fs.readFile(path.join(wsDir, KB, 'Plugins/sales-starter/plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'sales-starter', displayName: 'sales-starter' });
    const access = await fs.readFile(path.join(wsDir, KB, 'Plugins/sales-starter/access.md'), 'utf8');
    expect(access).toContain('Ada Admin <ada@example.com>');
  });

  it('writes only what is absent: a page made meanwhile is never replaced', async () => {
    const { svc, workflow } = harness();
    // Between the question and the locks, someone writes About us.
    workflow.acquireLock.mockImplementationOnce(async () => {
      await put(wsDir, `${KB}/KnowledgeBase/About us.md`, '# Ours\n');
      return { acquired: true, lock: { holderName: 'x' } };
    });

    const applied = await svc.choose(ADMIN, 'sales');

    expect(await fs.readFile(path.join(wsDir, KB, 'KnowledgeBase/About us.md'), 'utf8')).toBe('# Ours\n');
    const paths = (workflow.commitChanges.mock.calls[0] as unknown as [string, AuthUser, string, string[]])[3];
    expect(paths).not.toContain(`${KB}/KnowledgeBase/About us.md`);
    expect(applied.pages).toBe(1);
  });

  it('leaves a plugin that is already there alone, files and rules', async () => {
    await put(wsDir, `${KB}/Plugins/Sales-Starter/access.md`, '# theirs\n');
    const { svc, workflow } = harness();

    const applied = await svc.choose(ADMIN, 'sales');

    const paths = (workflow.commitChanges.mock.calls[0] as unknown as [string, AuthUser, string, string[]])[3];
    expect(paths.filter((p) => p.includes('/Plugins/'))).toEqual([]);
    expect(applied).toMatchObject({ pages: 2, skills: 0 });
  });

  it('leaves alone a plugin of the same name that lives in a grouping folder', async () => {
    // Not at the plugins root: discovery lists it, a folder listing would not.
    await put(wsDir, `${KB}/Plugins/teams/Sales Starter/plugin.json`, '{"name":"sales-starter"}\n');
    await put(wsDir, `${KB}/Plugins/teams/Sales Starter/access.md`, '# theirs\n');
    const { svc, workflow } = harness();

    const applied = await svc.choose(ADMIN, 'sales');

    const paths = (workflow.commitChanges.mock.calls[0] as unknown as [string, AuthUser, string, string[]])[3];
    expect(paths.filter((p) => p.includes('/Plugins/'))).toEqual([]);
    expect(applied).toMatchObject({ pages: 2, skills: 0 });
  });

  it('writes under the folder names this deployment chose', async () => {
    await fs.rm(path.join(wsDir, KB), { recursive: true });
    await put(wsDir, `${KB}/Wiki/How to get started.md`, '# How to get started\n');
    const { svc, workflow } = harness({ layout: { ...DEFAULT_KB_LAYOUT, knowledgeBaseDir: 'Wiki', pluginsDir: 'Teams' } });

    await svc.choose(ADMIN, 'sales');

    const paths = (workflow.commitChanges.mock.calls[0] as unknown as [string, AuthUser, string, string[]])[3];
    expect(paths).toContain(`${KB}/Wiki/About us.md`);
    expect(paths).toContain(`${KB}/Teams/sales-starter/skills/forecast/SKILL.md`);
    expect(paths.some((p) => p.includes('KnowledgeBase/') || p.includes('/Plugins/'))).toBe(false);
  });

  it('skipping records "none" and writes nothing', async () => {
    const { svc, store, workflow } = harness();

    expect(await svc.choose(ADMIN, 'none')).toEqual({ id: 'none', name: null, pages: 0, skills: 0, summary: '' });
    expect(store.starterPack).toBe('none');
    expect(workflow.commitChanges).not.toHaveBeenCalled();
  });

  it('is asked once: a second choice is 409, and so is one on a knowledge base with pages', async () => {
    const { svc, workflow } = harness();
    await svc.choose(ADMIN, 'none');
    await expect(svc.choose(ADMIN, 'sales')).rejects.toMatchObject({ status: 409 });

    const fresh = harness();
    await put(wsDir, `${KB}/KnowledgeBase/Ours.md`, '# Ours\n');
    await expect(fresh.svc.choose(ADMIN, 'sales')).rejects.toMatchObject({ status: 409 });
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(fresh.workflow.commitChanges).not.toHaveBeenCalled();
  });

  it('judges the question under the claim: an answer recorded meanwhile is found, not written over', async () => {
    const store: Record<string, string> = {};
    const { svc, settings, workflow } = harness({ store });
    // Another replica answered `none` and released while this call was on its way to its claim.
    settings.recordIfAbsent.mockImplementationOnce(async (key: string, value: string) => {
      store[key] = value;
      store.starterPack = 'none';
      return true;
    });
    await expect(svc.choose(ADMIN, 'sales')).rejects.toMatchObject({ status: 409 });
    expect(settings.recordIfAbsent.mock.invocationCallOrder[0]!).toBeLessThan(
      settings.reload.mock.invocationCallOrder.find((_, i) => settings.reload.mock.calls[i]![0] === 'starterPack')!,
    );
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(store.starterPack).toBe('none');
    expect(store.starterPackClaim).toBeUndefined();
  });

  it('two quick clicks add the pack once', async () => {
    const { svc, workflow } = harness();
    const results = await Promise.allSettled([svc.choose(ADMIN, 'sales'), svc.choose(ADMIN, 'sales')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
  });

  it('two replicas choosing at once add the pack once: the second finds the first’s claim', async () => {
    const store: Record<string, string> = {};
    const one = harness({ store });
    const two = harness({ store });
    const results = await Promise.allSettled([one.svc.choose(ADMIN, 'sales'), two.svc.choose(ADMIN, 'sales')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409 });
    expect(one.workflow.commitChanges.mock.calls.length + two.workflow.commitChanges.mock.calls.length).toBe(1);
    expect(store.starterPack).toBe('sales');
    expect(store.starterPackClaim).toBeUndefined();
  });

  it('refuses while another admin’s claim is live, and takes over one left by a process that died', async () => {
    const store: Record<string, string> = { starterPackClaim: `u-other ${Date.now()}` };
    const { svc, workflow } = harness({ store });
    await expect(svc.choose(ADMIN, 'sales')).rejects.toMatchObject({ status: 409 });
    await expect(svc.choose(ADMIN, 'sales')).rejects.toThrow(/being added right now/);
    expect(workflow.commitChanges).not.toHaveBeenCalled();

    store.starterPackClaim = `u-other ${Date.now() - CLAIM_TTL_MS - 1}`;
    await expect(svc.choose(ADMIN, 'sales')).resolves.toMatchObject({ id: 'sales' });
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    expect(store.starterPack).toBe('sales');
  });

  it('takes over an expired claim by replacing THAT claim, so two replicas cannot both take it', async () => {
    const stale = `u-other ${Date.now() - CLAIM_TTL_MS - 1}`;
    const store: Record<string, string> = { starterPackClaim: stale };
    const { svc, settings, workflow } = harness({ store });
    // Another replica took the expired claim over between this one's read and its take-over.
    settings.reload.mockImplementation(async (key: string) => {
      const held = store[key] ?? '';
      if (key === 'starterPackClaim') store[key] = `u-fast ${Date.now()}`;
      return held;
    });
    await expect(svc.choose(ADMIN, 'sales')).rejects.toThrow(/being added right now/);
    expect(settings.swapIfValue).toHaveBeenCalledWith('starterPackClaim', stale, expect.stringMatching(/^u-admin /), ADMIN.id);
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(store.starterPackClaim).toMatch(/^u-fast /);
  });

  it('claims an expired claim whose holder finished and released it meanwhile, rather than refusing', async () => {
    const stale = `u-other ${Date.now() - CLAIM_TTL_MS - 1}`;
    const store: Record<string, string> = { starterPackClaim: stale };
    const { svc, settings, workflow } = harness({ store });
    // Between this replica's read and its take-over, the holder finished and released: the row is gone.
    settings.reload.mockImplementation(async (key: string) => {
      const held = store[key] ?? '';
      if (key === 'starterPackClaim') delete store[key];
      return held;
    });
    await expect(svc.choose(ADMIN, 'sales')).resolves.toMatchObject({ id: 'sales' });
    expect(settings.recordIfAbsent).toHaveBeenCalledTimes(2);
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    expect(store.starterPack).toBe('sales');
  });

  it('releases only its own claim: one taken over after it expired is left to its new holder', async () => {
    const store: Record<string, string> = {};
    const { svc, settings, workflow } = harness({ store });
    workflow.commitChanges.mockRejectedValueOnce(new Error('disk full'));
    // While this write was failing, its claim expired and another replica took it over.
    settings.recordIfAbsent.mockImplementationOnce(async (key: string, value: string) => {
      store[key] = value;
      queueMicrotask(() => {
        store[key] = `u-other ${Date.now()}`;
      });
      return true;
    });
    await expect(svc.choose(ADMIN, 'sales')).rejects.toThrow('disk full');
    expect(store.starterPackClaim).toMatch(/^u-other /);
  });

  it('waits for a plugin creation of the same name, on the lock creations take', async () => {
    const { svc, locks, lockRequests, workflow } = harness();
    let released = false;
    let finishCreating!: () => void;
    const creating = locks.run(
      'plugin:sales-starter',
      () =>
        new Promise<void>((resolve) => {
          finishCreating = () => {
            released = true;
            resolve();
          };
        }),
    );
    const commits: string[] = [];
    workflow.commitChanges.mockImplementation(async () => {
      commits.push(released ? 'after the creation released the lock' : 'while the creation held the lock');
      return { sha: 'abc' };
    });

    const choosing = svc.choose(ADMIN, 'sales');
    // The pack has asked for the lock the creation holds, and nothing is
    // committed until that creation lets go.
    await vi.waitFor(() => expect(lockRequests).toEqual(['plugin:sales-starter']));
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    finishCreating();
    await creating;
    await expect(choosing).resolves.toMatchObject({ id: 'sales' });
    expect(commits).toEqual(['after the creation released the lock']);
  });

  it('adds the pack even when recording the choice fails afterwards: the pages close the question', async () => {
    const { svc, store, workflow, settings } = harness();
    settings.record.mockRejectedValueOnce(new Error('database unreachable'));
    await expect(svc.choose(ADMIN, 'sales')).resolves.toMatchObject({ id: 'sales', pages: 2 });
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    expect(store.starterPack).toBeUndefined();
    expect(store.starterPackClaim).toBeUndefined();
    expect((await svc.status(ADMIN)).offered).toBe(false);
    await expect(svc.choose(ADMIN, 'sales')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a member (403) and a pack that does not exist (404), recording nothing', async () => {
    const { svc, store } = harness();
    await expect(svc.choose(MEMBER, 'sales')).rejects.toBeInstanceOf(StarterPackError);
    await expect(svc.choose(MEMBER, 'sales')).rejects.toMatchObject({ status: 403 });
    await expect(svc.choose(ADMIN, 'astronomy')).rejects.toMatchObject({ status: 404 });
    expect(store.starterPack).toBeUndefined();
  });

  it('leaves the question open when the commit fails: the claim is taken back', async () => {
    const { svc, store, settings, workflow } = harness();
    workflow.commitChanges.mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.choose(ADMIN, 'sales')).rejects.toThrow('disk full');
    expect(settings.recordIfAbsent).toHaveBeenCalledTimes(1);
    expect(settings.swapIfValue).toHaveBeenCalledWith('starterPackClaim', expect.stringMatching(/^u-admin /), null, null);
    expect(store.starterPack).toBeUndefined();
    expect(store.starterPackClaim).toBeUndefined();
  });
});

describe('after the choice', () => {
  it('the chosen pack carries its prompt and the pages still as it wrote them', async () => {
    const { svc } = harness();
    await svc.choose(ADMIN, 'sales');
    await fs.writeFile(path.join(wsDir, KB, 'KnowledgeBase/Customers.md'), '# Customers\n\nAcme, Globex.\n');

    expect((await svc.status(MEMBER)).chosenPack).toEqual({
      id: 'sales',
      name: 'Sales',
      firstPagePrompt: 'Fill in the Customers page.',
      starterPages: [`${KB}/KnowledgeBase/About us.md`],
    });
  });

  it('names no untouched page the caller may not read: the list would say the page exists and what it holds', async () => {
    const { svc, unreadable, accessControl } = harness();
    await svc.choose(ADMIN, 'sales');
    unreadable.add('KnowledgeBase/About us.md');

    expect((await svc.status(MEMBER)).chosenPack?.starterPages).toEqual([`${KB}/KnowledgeBase/Customers.md`]);
    // Asked for the caller, by the pages' repo-relative paths, on the default branch's workspace.
    expect(accessControl.canReadBatch).toHaveBeenLastCalledWith(expect.any(String), MEMBER.email, [
      'KnowledgeBase/About us.md',
      'KnowledgeBase/Customers.md',
    ]);
  });

  it("the agent's first-run note learns the pack's suggestions and its pages", async () => {
    const { svc, store } = harness();
    expect(await svc.firstRunStarter()).toBeNull();
    store.starterPack = 'sales';
    const starter = await svc.firstRunStarter();
    expect(starter?.name).toBe('Sales');
    expect(starter?.suggestedPages).toEqual(['About us', 'Customers']);
    expect([...(starter?.pages.keys() ?? [])]).toEqual(['About us.md', 'Customers.md']);
  });
});

describe('wording', () => {
  it('names the team, except for the catch-all pack whose name is the chip "Something else"', () => {
    expect(commitSubjectOf({ id: 'sales', name: 'Sales' })).toBe('Add starter pages and skills for Sales');
    expect(commitSubjectOf({ id: 'general', name: 'Something else' })).toBe('Add starter pages and skills');
    expect(summaryOf({ id: 'general', name: 'Something else' }, 3, 1)).toBe('Added 3 pages and 1 skill.');
    expect(summaryOf({ id: 'sales', name: 'Sales' }, 0, 0)).toBe('Everything in this pack was already here.');
  });
});
