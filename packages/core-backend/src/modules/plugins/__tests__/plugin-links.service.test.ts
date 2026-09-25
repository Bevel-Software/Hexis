import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRANCH, withLinkedSkillRoots, type AuthUser } from '@bevel-software/platform-shared';

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
  /** The commit SUBJECT each of those landed with — `undefined` = the default. */
  let subjects: (string | undefined)[];
  /** Set to make the commit driver refuse every path containing it. */
  let failCommitsUnder: string | null;
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
    subjects = [];
    failCommitsUnder = null;
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
      runPendingCommit: async (_ws, _branch, target, _user, opts) => {
        if (failCommitsUnder !== null && target.includes(failCommitsUnder)) {
          throw new Error('the push gate said no');
        }
        commits.push(target);
        subjects.push(opts?.summary);
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

    const disk = new NodeFs();
    access = new AccessControlService(workspaceService, KB_DIR, disk);
    skills = new SkillService(workspaceService, access, KB_DIR, disk);
    index = new PluginLinkIndex(workspaceService, skills, access, KB_DIR, new KbPluginSource(disk));
    svc = new PluginLinksService(workspaceService, driver, access, skills, index, KB_DIR);
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('links a skill: manifest entry + read/write grants for the plugin principals, both committed', async () => {
    // Mia manages GTM but cannot edit Skills/Eng — Eve grants her write first.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);

    const result = await svc.link(manager, 'gtm', 'Skills/Eng/deploy');
    expect(result).toEqual({ root: 'Skills/Eng/deploy', skills: ['Skills/Eng/deploy'] });

    const manifest = JSON.parse(await read('Plugins/GTM/plugin.json'));
    expect(manifest.version).toBe('1.0.0'); // untouched
    expect(manifest.extensions['software.bevel.hexis'].skills).toEqual(['Skills/Eng/deploy']);
    const rules = await read('Skills/Eng/deploy/access.md');
    expect(rules).toContain('plugin/gtm/read');
    expect(rules).toContain('plugin/gtm/write');
    expect(commits).toEqual([
      `${KB_DIR}/Plugins/GTM/plugin.json`,
      `${KB_DIR}/Skills/Eng/deploy/access.md`,
    ]);

    // The point of it all: Sam, a GTM member, can now read the skill; Mia can edit it.
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    expect(await access.canWrite(wsId, manager.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    // And the index reports the membership as linked and granted.
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'gtm', linked: true, granted: true }]);
    expect(await index.pluginsOf('Skills/Eng/rollback')).toEqual([]);
  });

  it('a plugin whose folder is not its own slug links, re-links and unlinks through ONE spelling', async () => {
    // The folder "Sales Team" is only where the plugin lives; its manifest
    // name "sales-team" is the plugin. Every grant, comparison and revocation
    // goes through that one key, so a second link adds nothing and an unlink
    // finds what it wrote.
    await write(
      'Plugins/Sales Team/access.md',
      '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\nowner:\n  - Mia <mia@x.io>\n',
    );
    await write('Plugins/Sales Team/plugin.json', '{"name":"sales-team"}');
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);

    await svc.link(manager, 'sales-team', 'Skills/Eng/deploy');
    await svc.link(manager, 'sales-team', 'Skills/Eng/deploy');
    const rules = await read('Skills/Eng/deploy/access.md');
    expect(rules.match(/plugin\/sales-team\/read/g)).toHaveLength(1);
    expect(rules.match(/plugin\/sales-team\/write/g)).toHaveLength(1);
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);

    await svc.unlink(manager, 'sales-team', 'Skills/Eng/deploy');
    expect(await read('Skills/Eng/deploy/access.md')).not.toContain('plugin/sales-team');
    access.invalidate(wsId);
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(false);
  });

  it('two plugins linking one root at once both land their grants — the root is locked, not only the plugin', async () => {
    await write(
      'Plugins/Ops/access.md',
      '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\nowner:\n  - Mia <mia@x.io>\n',
    );
    await write('Plugins/Ops/plugin.json', '{"name":"ops"}');
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);

    await Promise.all([svc.link(manager, 'gtm', 'Skills/Eng'), svc.link(manager, 'ops', 'Skills/Eng')]);
    const rules = await read('Skills/Eng/access.md');
    expect(rules).toContain('plugin/gtm/read');
    expect(rules).toContain('plugin/ops/read');
    expect(rules).toContain('plugin/gtm/write');
    expect(rules).toContain('plugin/ops/write');
  });

  it('refuses with needs-skill-write when the manager cannot edit the skill\'s rules', async () => {
    await expect(svc.link(manager, 'gtm', 'Skills/Eng/deploy')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'needs-skill-write' },
    });
    expect(commits).toEqual([]);
    expect(await fs.readFile(path.join(repo, 'Plugins/GTM/plugin.json'), 'utf-8')).not.toContain('skills');
  });

  it('a folder of skills links every skill beneath it with one grant on the folder', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    const result = await svc.link(manager, 'gtm', 'Skills/Eng');
    expect(result.skills.sort()).toEqual(['Skills/Eng/deploy', 'Skills/Eng/rollback']);
    expect(await read('Skills/Eng/access.md')).toContain('plugin/gtm/read');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/rollback/SKILL.md')).toBe(true);
    const m = await index.membership();
    expect(m.byPlugin.get('gtm')?.linkedSkills.sort()).toEqual(['Skills/Eng/deploy', 'Skills/Eng/rollback']);
  });

  it('is fail-closed on the plugin side: a non-manager, or an unknown plugin, gets the same 404', async () => {
    await expect(svc.link(member, 'gtm', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
    await expect(svc.link(manager, 'Ghost', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
    await expect(svc.link(manager, 'personal-abc', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a root that holds no released skill, and a path that could escape the repo', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await expect(svc.link(manager, 'gtm', 'Skills/Nowhere')).rejects.toMatchObject({
      status: 422,
      payload: { kind: 'no-skills' },
    });
    await expect(svc.link(manager, 'gtm', '../etc')).rejects.toMatchObject({ status: 422, payload: { kind: 'bad-root' } });
  });

  it('links a root whose skills carry any frontmatter — a governance key is no longer a refusal', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    await write('Skills/Eng/old-deploy/SKILL.md', '---\ndescription: Gone.\nmetadata:\n  lifecycle: retired\n---\n');
    access.invalidate(wsId);
    skills.invalidate();

    const result = await svc.link(manager, 'gtm', 'Skills/Eng');
    expect(result.skills.sort()).toEqual(['Skills/Eng/deploy', 'Skills/Eng/old-deploy', 'Skills/Eng/rollback']);
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/old-deploy/SKILL.md')).toBe(true);
  });

  it('unlink removes the entry and revokes the tokens when the actor may edit the skill', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'gtm', 'Skills/Eng/deploy');
    commits.length = 0;

    expect(await svc.unlink(manager, 'gtm', 'Skills/Eng/deploy')).toEqual({ root: 'Skills/Eng/deploy', revoked: true });
    expect(JSON.parse(await read('Plugins/GTM/plugin.json')).extensions).toBeUndefined();
    expect(await read('Skills/Eng/deploy/access.md')).not.toContain('plugin/gtm');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(false);
    // Revoke lands first, manifest second: a failure between the two leaves
    // the visible half-state (still listed, no grant), never the silent one.
    expect(commits).toEqual([`${KB_DIR}/Skills/Eng/deploy/access.md`, `${KB_DIR}/Plugins/GTM/plugin.json`]);
  });

  it('unlink leaves the grant in place when the actor may not edit the skill — and says so', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'gtm', 'Skills/Eng/deploy');
    // Eve takes Mia's write on the scope away, and hand-edits the skill's own
    // rules down to the read token — the link's write token, which would still
    // let GTM's managers edit, is gone.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n');
    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - plugin/gtm/read\n');
    access.invalidate(wsId);

    expect(await svc.unlink(manager, 'gtm', 'Skills/Eng/deploy')).toEqual({ root: 'Skills/Eng/deploy', revoked: false });
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/gtm/read');
    await expect(svc.unlink(manager, 'gtm', 'Skills/Eng/deploy')).rejects.toMatchObject({ status: 404, payload: { kind: 'not-linked' } });
  });

  it('a hand-removed grant shows as not granted, and repair puts it back', async () => {
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    await svc.link(manager, 'gtm', 'Skills/Eng/deploy');

    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\n');
    access.invalidate(wsId);
    index.invalidate();
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'gtm', linked: true, granted: false }]);

    await svc.repair(manager, 'gtm', 'Skills/Eng/deploy');
    expect(await index.pluginsOf('Skills/Eng/deploy')).toEqual([{ name: 'gtm', linked: true, granted: true }]);
    // Repair is a skill-editor's action, not a plugin-manager's: with both the
    // scope grant and the link's write token gone, Mia may not touch the rules.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n');
    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\n');
    access.invalidate(wsId);
    await expect(svc.repair(manager, 'gtm', 'Skills/Eng/deploy')).rejects.toBeInstanceOf(PluginLinkError);
    // Eve, who edits the scope, can.
    await svc.repair(editor, 'gtm', 'Skills/Eng/deploy');
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/gtm/read');
  });

  it('a plugin nested below the root links like any other — position means nothing', async () => {
    await write('Plugins/teams/Deep/plugin.json', '{\n  "name": "deep"\n}\n');
    await write('Plugins/teams/Deep/access.md', '---\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\n');
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    access.invalidate(wsId);
    index.invalidate();

    await svc.link(manager, 'deep', 'Skills/Eng/rollback');
    expect(JSON.parse(await read('Plugins/teams/Deep/plugin.json')).extensions['software.bevel.hexis'].skills).toEqual(['Skills/Eng/rollback']);
    expect(await read('Skills/Eng/rollback/access.md')).toContain('plugin/deep/read');
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/rollback/SKILL.md')).toBe(true);
    expect(await index.pluginsOf('Skills/Eng/rollback')).toEqual([{ name: 'deep', linked: true, granted: true }]);
  });

  it('a skill inside a plugin folder is inline membership, never a link', async () => {
    await write('Plugins/GTM/skills/outreach/SKILL.md', '---\ndescription: Reach out.\n---\n');
    skills.invalidate();
    index.invalidate();
    expect(await index.pluginsOf('Plugins/GTM/skills/outreach')).toEqual([{ name: 'gtm', linked: false, granted: true }]);
  });

  /**
   * A link written into the manifest WITHOUT its grants — the hand edit this
   * whole surface exists for. `link()` writes both lines; every test below is
   * about what the index and the repair say when they are absent.
   */
  const linkByHand = async (...roots: string[]) => {
    await write(
      'Plugins/GTM/plugin.json',
      `${JSON.stringify(withLinkedSkillRoots({ name: 'gtm', version: '1.0.0' }, roots), null, 2)}\n`,
    );
    access.invalidate(wsId);
    skills.invalidate();
    index.invalidate();
  };

  /** Whether the index calls the link to one skill healthy. */
  const grantedOf = async (skillPath: string) =>
    (await index.pluginsOf(skillPath)).find((m) => m.name === 'gtm')?.granted;

  describe('granted — the two lines at the root, and nothing else', () => {
    it('a PUBLIC root is not granted: the grant is the link, not the readability', async () => {
      // The demo-core shape: the repository root says `read: everyone`, so
      // GTM's members can read the skill and the link still names nothing.
      await write('access.md', '---\n---\nread:\n  - everyone\nwrite:\n  - Admin\n');
      await linkByHand('Skills/Eng/deploy');

      expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });

    it('a plugin grant INHERITED from a folder above the root does not count', async () => {
      await write(
        'Skills/Eng/access.md',
        '---\n---\nread:\n  - plugin/gtm/read\nwrite:\n  - Eve <eve@x.io>\n  - plugin/gtm/write\n',
      );
      await linkByHand('Skills/Eng/deploy');

      // The members CAN read it — and the root the manifest names still says
      // nothing about GTM, so the link is one edit of Skills/Eng away from
      // silently sharing nothing.
      expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });

    it('both lines at the root are granted; a deny BELOW the root is not', async () => {
      await write(
        'Skills/Eng/access.md',
        '---\n---\nread:\n  - plugin/gtm/read\nwrite:\n  - Eve <eve@x.io>\n  - plugin/gtm/write\n',
      );
      await write('Skills/Eng/rollback/access.md', '---\n---\nread:\n  - deny plugin/gtm/read\n');
      await linkByHand('Skills/Eng');

      expect(await grantedOf('Skills/Eng/deploy')).toBe(true);
      expect(await grantedOf('Skills/Eng/rollback')).toBe(false);
    });

    it('a deny AT the root beside the lines is not granted — the deny is the operator\'s', async () => {
      // What a repair leaves behind when someone has denied the plugin: the
      // grant is spliced in, the deny stays, and the link stays broken.
      await write(
        'Skills/Eng/deploy/access.md',
        '---\n---\nread:\n  - plugin/gtm/read\n  - deny plugin/gtm/read\nwrite:\n  - plugin/gtm/write\n',
      );
      await linkByHand('Skills/Eng/deploy');

      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });
  });

  describe('repairAll — what opening the plugin page runs', () => {
    it('does not call a link denied at its root repaired: nothing to write, and the banner keeps it', async () => {
      // The lines are there; a `deny` beside them is what breaks the link.
      // The repair has nothing to write, and a root it did not write is not
      // one it fixed — reporting it repaired would hide it from the one
      // person who could act, and reload the page for nothing.
      await write(
        'Skills/Eng/deploy/access.md',
        '---\n---\nread:\n  - plugin/gtm/read\n  - deny plugin/gtm/read\nwrite:\n  - Mia <mia@x.io>\n  - plugin/gtm/write\n',
      );
      await linkByHand('Skills/Eng/deploy');
      commits.length = 0;

      const report = await svc.repairAll(manager, 'gtm');
      expect(report.repaired).toEqual([]);
      expect(report.skipped).toMatchObject([
        { root: 'Skills/Eng/deploy', reason: 'denied', skills: [{ path: 'Skills/Eng/deploy', name: 'deploy' }] },
      ]);
      // Eve edits Skills/Eng (the fixture's own rule) and Mia the root itself:
      // both can remove the deny, so both are named.
      expect(report.skipped[0].editors.users.map((u) => u.email).sort()).toEqual(['eve@x.io', 'mia@x.io']);
      expect(commits).toEqual([]);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });

    it('repairs every link the writer may write, silently, and says nothing about them', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
      await linkByHand('Skills/Eng/deploy', 'Skills/Eng/rollback');
      commits.length = 0;
      subjects.length = 0;

      expect(await svc.repairAll(manager, 'gtm')).toEqual({
        repaired: ['Skills/Eng/deploy', 'Skills/Eng/rollback'],
        skipped: [],
      });
      expect(commits).toEqual([
        `${KB_DIR}/Skills/Eng/deploy/access.md`,
        `${KB_DIR}/Skills/Eng/rollback/access.md`,
      ]);
      // The commit is the only trace a silent repair leaves, so it has to
      // explain itself.
      expect(subjects).toEqual([
        'Repair link: gtm → Skills/Eng/deploy (automatic, on opening the plugin page)',
        'Repair link: gtm → Skills/Eng/rollback (automatic, on opening the plugin page)',
      ]);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(true);
      expect(await grantedOf('Skills/Eng/rollback')).toBe(true);
    });

    it('writes exactly what the manual repair writes', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
      await linkByHand('Skills/Eng/deploy', 'Skills/Eng/rollback');

      await svc.repair(manager, 'gtm', 'Skills/Eng/deploy');
      await svc.repairAll(manager, 'gtm');
      expect(await read('Skills/Eng/rollback/access.md')).toEqual(
        await read('Skills/Eng/deploy/access.md'),
      );
    });

    it('leaves a link the writer may not repair alone, and names who can', async () => {
      // Skills/Eng is Eve's. Mia manages GTM and nothing else.
      await linkByHand('Skills/Eng/deploy');
      commits.length = 0;

      const report = await svc.repairAll(manager, 'gtm');
      expect(report.repaired).toEqual([]);
      expect(report.skipped).toEqual([
        {
          root: 'Skills/Eng/deploy',
          reason: 'needs-skill-write',
          skills: [{ path: 'Skills/Eng/deploy', name: 'deploy' }],
          // Admin holds the write floor on any access.md, so an admin can
          // always repair a link; the eligible lists carry no display names,
          // so Eve is named by the address a reader can write to.
          editors: { roles: ['Admin'], users: [{ name: 'eve@x.io', email: 'eve@x.io' }] },
        },
      ]);
      expect(commits).toEqual([]);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });

    it('is refused for someone who may not write the plugin — the same 404 as an unknown one', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Sam <sam@x.io>\n');
      await linkByHand('Skills/Eng/deploy');

      await expect(svc.repairAll(member, 'gtm')).rejects.toMatchObject({ status: 404 });
      await expect(svc.repairAll(manager, 'Ghost')).rejects.toMatchObject({ status: 404 });
      // Sam may write the skill; being unable to write GTM is what stopped it.
      expect(commits).toEqual([]);
      expect(await grantedOf('Skills/Eng/deploy')).toBe(false);
    });

    it('writes nothing the second time: a root that already carries both lines is left alone', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
      await linkByHand('Skills/Eng/deploy');
      await svc.repairAll(manager, 'gtm');
      commits.length = 0;

      expect(await svc.repairAll(manager, 'gtm')).toEqual({ repaired: [], skipped: [] });
      expect(commits).toEqual([]);
      const rules = await read('Skills/Eng/deploy/access.md');
      expect(rules.match(/plugin\/gtm\/read/g)).toHaveLength(1);
      expect(rules.match(/plugin\/gtm\/write/g)).toHaveLength(1);
    });

    it('a repair that fails leaves the others repaired, and stays in the report', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Eve <eve@x.io>\n  - Mia <mia@x.io>\n');
      await linkByHand('Skills/Eng/deploy', 'Skills/Eng/rollback');
      failCommitsUnder = 'Skills/Eng/rollback';
      commits.length = 0;

      const report = await svc.repairAll(manager, 'gtm');
      expect(report.repaired).toEqual(['Skills/Eng/deploy']);
      expect(report.skipped).toMatchObject([{ root: 'Skills/Eng/rollback', reason: 'failed' }]);
      // Eve and Mia both edit the scope, so both are named as able to repair it.
      expect(report.skipped[0].editors.users.map((u) => u.email).sort()).toEqual([
        'eve@x.io',
        'mia@x.io',
      ]);
      expect(commits).toEqual([`${KB_DIR}/Skills/Eng/deploy/access.md`]);
      expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/gtm/read');
    });

    it('has nothing to do for a plugin whose links are all healthy', async () => {
      await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
      await svc.link(manager, 'gtm', 'Skills/Eng/deploy');
      commits.length = 0;

      expect(await svc.repairAll(manager, 'gtm')).toEqual({ repaired: [], skipped: [] });
      expect(commits).toEqual([]);
    });
  });
});
