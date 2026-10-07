import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT, type AuthUser, type IWorkflowService, type KbLayout } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { StarterPackError, StarterPackService, commitSubjectOf, summaryOf } from '../starter-pack.service.js';

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

function harness({ layout = DEFAULT_KB_LAYOUT as KbLayout, admins = [ADMIN.email] } = {}) {
  const store: Record<string, string> = {};
  const settings = {
    reload: vi.fn(async (key: string) => store[key] ?? ''),
    record: vi.fn(async (entries: Record<string, string>) => {
      Object.assign(store, entries);
    }),
  };
  const workflow = {
    acquireLock: vi.fn(async () => ({ acquired: true, lock: { holderName: 'x' } })),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
    releaseLockUntouched: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => ({ sha: 'abc' })),
  };
  const events = { emit: vi.fn() };
  const accessControl = { invalidate: vi.fn() };
  const svc = new StarterPackService({
    packsDir,
    kb: testKbContext({ kbDirName: KB, layout }),
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
  return { svc, store, settings, workflow, events, accessControl };
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
    const { svc, store, workflow, events, accessControl } = harness();

    const applied = await svc.choose(ADMIN, 'sales');

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

  it('two quick clicks add the pack once', async () => {
    const { svc, workflow } = harness();
    const results = await Promise.allSettled([svc.choose(ADMIN, 'sales'), svc.choose(ADMIN, 'sales')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
  });

  it('refuses a member (403) and a pack that does not exist (404), recording nothing', async () => {
    const { svc, store } = harness();
    await expect(svc.choose(MEMBER, 'sales')).rejects.toBeInstanceOf(StarterPackError);
    await expect(svc.choose(MEMBER, 'sales')).rejects.toMatchObject({ status: 403 });
    await expect(svc.choose(ADMIN, 'astronomy')).rejects.toMatchObject({ status: 404 });
    expect(store.starterPack).toBeUndefined();
  });

  it('leaves the question open when the commit fails', async () => {
    const { svc, store, workflow } = harness();
    workflow.commitChanges.mockRejectedValueOnce(new Error('disk full'));
    await expect(svc.choose(ADMIN, 'sales')).rejects.toThrow('disk full');
    expect(store.starterPack).toBeUndefined();
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
