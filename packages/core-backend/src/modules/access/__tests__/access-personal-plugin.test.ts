import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { personalAccessMd, pluginAccessMd } from '../../plugins/plugin-provision.service.js';
import { defaultKbTemplateDir } from '../../../assets.js';
import { closePersonalSpaceRules } from '../../workspace/startup/steps/personal-spaces.step.js';

/**
 * What the seeded access templates actually resolve to, through the public
 * resolver over a real tree — the two things a customer tripped over:
 *
 *  - a personal space must stay private even after an administrator opens
 *    the repository root with `read: everyone` (the usual way to let a new
 *    joiner read anything), while its owner keeps reading it — and Admin,
 *    who reads everything else, does not;
 *  - the managed AGENTS.md must be readable by every signed-in person even
 *    when the root grants read to nobody, because agents are told to read
 *    it before their first action.
 */

const KB_DIR = 'knowledge-base';

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

const OWNER = { name: 'Ali Vega', email: 'ali@x.io' };
const ROLES_YAML = `roles:\n  Admin:\n    - admin@x.io\n`;

describe('the seeded access templates, resolved', () => {
  let root: string;
  const workspaceId = 'ws-personal-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-personal-access-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeService(files: Record<string, string>) {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    return new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR);
  }

  const PERSONAL = {
    'roles.yaml': ROLES_YAML,
    'Plugins/personal-ali/plugin.json': '{"name":"personal-ali"}',
    'Plugins/personal-ali/access.md': personalAccessMd(OWNER),
    'Plugins/personal-ali/skills/weekly/SKILL.md': '# Weekly\n',
    'Plugins/GTM/plugin.json': '{"name":"gtm"}',
    'Plugins/GTM/access.md': pluginAccessMd(OWNER),
    'Plugins/GTM/skills/x/SKILL.md': '# X\n',
  };
  const PATHS = [
    'Plugins/personal-ali/skills/weekly/SKILL.md',
    'Plugins/personal-ali/access.md',
    'Plugins/GTM/access.md',
    'Plugins/GTM/skills/x/SKILL.md',
  ];

  it('a personal space stays closed to everyone else when the root says read: everyone — the owner still reads it, Admin does not', async () => {
    const svc = await makeService({
      ...PERSONAL,
      'access.md': '---\nowner:\n  - Admin\n---\nread:\n  - everyone\nwrite:\n  - Admin\n',
    });
    const other = await svc.canReadBatch(workspaceId, 'bob@x.io', PATHS);
    expect(Object.fromEntries(other)).toEqual({
      'Plugins/personal-ali/skills/weekly/SKILL.md': false,
      'Plugins/personal-ali/access.md': false, // not even listed for them
      // A SHARED plugin's body denies nothing, so the root's opening reaches
      // into it — that is the difference the personal template's `deny
      // everyone` makes, and exactly what a customer saw: opening the root
      // opened every plugin, personal ones included.
      'Plugins/GTM/access.md': true,
      'Plugins/GTM/skills/x/SKILL.md': true,
    });
    const owner = await svc.canReadBatch(workspaceId, OWNER.email, PATHS);
    expect(owner.get('Plugins/personal-ali/skills/weekly/SKILL.md')).toBe(true);
    expect(owner.get('Plugins/personal-ali/access.md')).toBe(true);
    // Admin reads everything else in the repository; a private space is the
    // one place the role is not named, so the denial reaches them too. (They
    // can still WRITE the access.md, through the resolver's rescue, and grant
    // themselves in — a visible act, not a default.)
    const admin = await svc.canReadBatch(workspaceId, 'admin@x.io', PATHS);
    expect(admin.get('Plugins/personal-ali/skills/weekly/SKILL.md')).toBe(false);
    expect(admin.get('Plugins/personal-ali/access.md')).toBe(false);
    expect(admin.get('Plugins/GTM/skills/x/SKILL.md')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'Plugins/personal-ali/access.md')).toBe(true);
  });

  it("the owner reads, writes and owns their space; nobody else writes it", async () => {
    const svc = await makeService({ ...PERSONAL, 'access.md': '---\nowner:\n  - Admin\n---\nwrite:\n  - Admin\n' });
    const skill = 'Plugins/personal-ali/skills/weekly/SKILL.md';
    expect(await svc.canWrite(workspaceId, OWNER.email, skill)).toBe(true);
    expect(await svc.canOwner(workspaceId, OWNER.email, 'Plugins/personal-ali')).toBe(true);
    expect(await svc.canWrite(workspaceId, 'bob@x.io', skill)).toBe(false);
  });

  it('a personal space seeded by the previous template, once the boot step has closed it, resolves like a new one', async () => {
    // The old seed: the owner's grants in the legacy single-block shape.
    const legacy =
      '---\nread:\n  - Ali Vega <ali@x.io>\nwrite:\n  - Ali Vega <ali@x.io>\nowner:\n  - Ali Vega <ali@x.io>\n---\nread: []\n';
    const closed = closePersonalSpaceRules(legacy, 'Plugins/personal-ali/access.md');
    expect(closed).not.toBeNull();
    // Closing it again changes nothing: the step is idempotent by parse, not by text.
    expect(closePersonalSpaceRules(closed!, 'Plugins/personal-ali/access.md')).toBeNull();

    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'access.md': '---\nowner:\n  - Admin\n---\nread:\n  - everyone\nwrite:\n  - Admin\n',
      'Plugins/personal-ali/plugin.json': '{"name":"personal-ali"}',
      'Plugins/personal-ali/access.md': closed!,
      'Plugins/personal-ali/skills/weekly/SKILL.md': '# Weekly\n',
    });
    const skill = 'Plugins/personal-ali/skills/weekly/SKILL.md';
    expect(await svc.canRead(workspaceId, 'bob@x.io', skill)).toBe(false);
    expect(await svc.canRead(workspaceId, OWNER.email, skill)).toBe(true);
    expect(await svc.canWrite(workspaceId, OWNER.email, skill)).toBe(true);
    expect(await svc.canRead(workspaceId, 'admin@x.io', skill)).toBe(false);
  });

  it('the packaged AGENTS.md is readable by a non-admin even when the root grants read to nobody', async () => {
    const template = await fs.readFile(path.join(defaultKbTemplateDir(), 'AGENTS.md'), 'utf8');
    const svc = await makeService({
      'roles.yaml': ROLES_YAML,
      'access.md': '---\nowner:\n  - Admin\n---\nwrite:\n  - Admin\n',
      'AGENTS.md': template,
      'KnowledgeBase/Notes.md': '# Notes\n',
    });
    const bob = await svc.canReadBatch(workspaceId, 'bob@x.io', ['AGENTS.md', 'KnowledgeBase/Notes.md']);
    expect(bob.get('AGENTS.md')).toBe(true);
    // The grant is the FILE's own, not a widening of the root.
    expect(bob.get('KnowledgeBase/Notes.md')).toBe(false);
  });
});
