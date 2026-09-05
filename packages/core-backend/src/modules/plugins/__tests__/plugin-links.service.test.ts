import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRANCH, type AuthUser } from '@bevel-software/platform-shared';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { SkillService } from '../../skills/skills.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { PluginLinkIndex } from '../plugin-links.js';
import { PluginLinksService, PluginLinkError } from '../plugin-links.service.js';
import type { ProvisionCommitDriver } from '../plugin-provision.service.js';

/**
 * Linking end to end over a real tree: the real resolver decides who may
 * link and who may read afterwards, the real catalog resolves roots, and the
 * commit driver is the only thing stubbed (it records what would land).
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const manager: AuthUser = { id: 'u-mia', email: 'mia@x.io', name: 'Mia' } as AuthUser;
const editor: AuthUser = { id: 'u-eve', email: 'eve@x.io', name: 'Eve' } as AuthUser;
const member: AuthUser = { id: 'u-sam', email: 'sam@x.io', name: 'Sam' } as AuthUser;

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
`;

describe('PluginLinksService', () => {
  let root: string;
  let repo: string;
  let commits: string[];
  let access: AccessControlService;
  let skills: SkillService;
  let index: PluginLinkIndex;
  let svc: PluginLinksService;

  const write = async (rel: string, text: string) => {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf-8');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-links-'));
    repo = path.join(root, wsId, KB_DIR);
    commits = [];
    const workspaceService = {
      getOrCreateForBranch: async () => ({ id: wsId }),
      getWorkspacePath: async (id: string) => path.join(root, id),
      readFile: async (id: string, rel: string) => fs.readFile(path.join(root, id, rel), 'utf-8'),
      writeFile: async (id: string, rel: string, text: string) => {
        const abs = path.join(root, id, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, text);
      },
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const driver: ProvisionCommitDriver = {
      runPendingCommit: async (_ws, _branch, target) => {
        commits.push(target);
      },
    };

    await write('roles.yaml', ROLES_YAML);
    await write('access.md', '---\nwrite:\n  - Admin\n---\n');
    // GTM: Mia manages, Sam is a member.
    await write(
      'Plugins/GTM/access.md',
      '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\nowner:\n  - Mia <mia@x.io>\n',
    );
    await write('Plugins/GTM/plugin.json', '{\n  "name": "gtm",\n  "version": "1.0.0"\n}\n');
    // A shared scope Eve edits, holding two skills.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n');
    await write('Skills/Eng/deploy/SKILL.md', '---\ndescription: Ship it.\n---\n');
    await write('Skills/Eng/rollback/SKILL.md', '---\ndescription: Undo it.\n---\n');

    access = new AccessControlService(workspaceService, KB_DIR);
    skills = new SkillService(workspaceService, access, KB_DIR);
    index = new PluginLinkIndex(workspaceService, skills, access, KB_DIR);
    svc = new PluginLinksService(workspaceService, driver, access, skills, index, KB_DIR);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('links a skill: manifest entry + read/write grants for the plugin principals, both committed', async () => {
    // Mia manages GTM but cannot edit Skills/Eng — Eve grants her write first.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);

    const result = await svc.link(manager, 'GTM', 'Skills/Eng/deploy');
    expect(result).toEqual({ root: 'Skills/Eng/deploy', skills: ['Skills/Eng/deploy'] });

    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.version).toBe('1.0.0'); // untouched
    expect(manifest.extensions['software.bevel.hexis'].skills).toEqual(['Skills/Eng/deploy']);
    const rules = await read('Skills/Eng/deploy/access.md');
    expect(rules).toContain('plugin/GTM/read');
    expect(rules).toContain('plugin/GTM/write');
    expect(commits).toEqual([
      `${KB_DIR}/Plugins/GTM/plugin.json`,
      `${KB_DIR}/Skills/Eng/deploy/access.md`,
    ]);

    // The point of it all: Sam, a GTM member, can now read the skill; Mia can edit it.
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    expect(await access.canWrite(wsId, manager.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    // And the index reports the membership as linked and granted.
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'GTM', linked: true, granted: true }]);
    expect(await index.pluginsOf('Skills/Eng/rollback')).toEqual([]);
  });

  it('refuses with needs-skill-write when the manager cannot edit the skill\'s rules', async () => {
    await expect(svc.link(manager, 'GTM', 'Skills/Eng/deploy')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'needs-skill-write' },
    });
    expect(commits).toEqual([]);
    expect(await fs.readFile(path.join(repo, 'Plugins/GTM/plugin.json'), 'utf-8')).not.toContain('skills');
  });

  it('a folder of skills links every skill beneath it with one grant on the folder', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    const result = await svc.link(manager, 'GTM', 'Skills/Eng');
    expect(result.skills.sort()).toEqual(['Skills/Eng/deploy', 'Skills/Eng/rollback']);
    expect(await read('Skills/Eng/access.md')).toContain('plugin/GTM/read');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/rollback/SKILL.md')).toBe(true);
    const m = await index.membership();
    expect(m.byPlugin.get('GTM')?.linkedSkills.sort()).toEqual(['Skills/Eng/deploy', 'Skills/Eng/rollback']);
  });

  it('is fail-closed on the plugin side: a non-manager, or an unknown plugin, gets the same 404', async () => {
    await expect(svc.link(member, 'GTM', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
    await expect(svc.link(manager, 'Ghost', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
    await expect(svc.link(manager, 'personal-abc', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a root that holds no released skill, and a path that could escape the repo', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await expect(svc.link(manager, 'GTM', 'Skills/Nowhere')).rejects.toMatchObject({
      status: 422,
      payload: { kind: 'no-skills' },
    });
    await expect(svc.link(manager, 'GTM', '../etc')).rejects.toMatchObject({ status: 422, payload: { kind: 'bad-root' } });
  });

  it('refuses a root that holds a retired skill anywhere beneath it — the grant would reach it', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    await write('Skills/Eng/old-deploy/SKILL.md', '---\ndescription: Gone.\nmetadata:\n  lifecycle: retired\n---\n');
    access.invalidate(wsId);
    skills.invalidate();

    await expect(svc.link(manager, 'GTM', 'Skills/Eng')).rejects.toMatchObject({
      status: 422,
      payload: { kind: 'retired-skills', retired: ['Skills/Eng/old-deploy'] },
    });
    await expect(svc.link(manager, 'GTM', 'Skills/Eng/old-deploy')).rejects.toMatchObject({ status: 422 });
    // The active skill on its own is fine.
    await svc.link(manager, 'GTM', 'Skills/Eng/deploy');
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/GTM/read');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/old-deploy/SKILL.md')).toBe(false);
  });

  it('unlink removes the entry and revokes the tokens when the actor may edit the skill', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'GTM', 'Skills/Eng/deploy');
    commits.length = 0;

    expect(await svc.unlink(manager, 'GTM', 'Skills/Eng/deploy')).toEqual({ root: 'Skills/Eng/deploy', revoked: true });
    expect(JSON.parse(await read('Plugins/GTM/plugin.json')).extensions).toBeUndefined();
    expect(await read('Skills/Eng/deploy/access.md')).not.toContain('plugin/GTM');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(false);
    // Revoke lands first, manifest second: a failure between the two leaves
    // the visible half-state (still listed, no grant), never the silent one.
    expect(commits).toEqual([`${KB_DIR}/Skills/Eng/deploy/access.md`, `${KB_DIR}/Plugins/GTM/plugin.json`]);
  });

  it('unlink leaves the grant in place when the actor may not edit the skill — and says so', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'GTM', 'Skills/Eng/deploy');
    // Eve takes Mia's write on the scope away, and hand-edits the skill's own
    // rules down to the read token — the link's write token, which would still
    // let GTM's managers edit, is gone.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n');
    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - plugin/GTM/read\n');
    access.invalidate(wsId);

    expect(await svc.unlink(manager, 'GTM', 'Skills/Eng/deploy')).toEqual({ root: 'Skills/Eng/deploy', revoked: false });
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/GTM/read');
    await expect(svc.unlink(manager, 'GTM', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404, payload: { kind: 'not-linked' } });
  });

  it('a hand-removed grant shows as not granted, and repair puts it back', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'GTM', 'Skills/Eng/deploy');

    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\n');
    access.invalidate(wsId);
    index.invalidate();
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'GTM', linked: true, granted: false }]);

    await svc.repair(manager, 'GTM', 'Skills/Eng/deploy');
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'GTM', linked: true, granted: true }]);
    // Repair is a skill-editor's action, not a plugin-manager's: with both the
    // scope grant and the link's write token gone, Mia may not touch the rules.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n');
    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\n');
    access.invalidate(wsId);
    await expect(svc.repair(manager, 'GTM', 'Skills/Eng/deploy')).rejects.toBeInstanceOf(PluginLinkError);
    // Eve, who edits the scope, can.
    await svc.repair(editor, 'GTM', 'Skills/Eng/deploy');
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/GTM/read');
  });

  it('a plugin nested below the root links like any other — position means nothing', async () => {
    await write('Plugins/teams/Deep/plugin.json', '{\n  "name": "deep"\n}\n');
    await write('Plugins/teams/Deep/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\n');
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    index.invalidate();

    await svc.link(manager, 'Deep', 'Skills/Eng/rollback');
    expect(JSON.parse(await read('Plugins/teams/Deep/plugin.json')).extensions['software.bevel.hexis'].skills).toEqual(['Skills/Eng/rollback']);
    expect(await read('Skills/Eng/rollback/access.md')).toContain('plugin/Deep/read');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/rollback/SKILL.md')).toBe(true);
    expect(await index.pluginsOf('Skills/Eng/rollback')).toEqual([{ name: 'Deep', linked: true, granted: true }]);
  });

  it('a skill inside a plugin folder is inline membership, never a link', async () => {
    await write('Plugins/GTM/skills/outreach/SKILL.md', '---\ndescription: Reach out.\n---\n');
    skills.invalidate();
    index.invalidate();
    expect(await index.pluginsOf('Plugins/GTM/skills/outreach')).toEqual([{ name: 'GTM', linked: false, granted: true }]);
  });
});
