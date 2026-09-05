import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { parseAccessEntry } from '../../access-model/access-grammar.js';

/**
 * `plugin/<Name>/<verb>` as a grantable principal: derived from the plugin
 * folder's own access.md, resolved like any group, and usable on ANY path —
 * a shared skill under `Skills/`, a Knowledge folder, anything. These tests
 * drive the public resolver (`canRead`/`canWrite`, `eligibleReaders`,
 * `kbPrincipals`) over a real on-disk tree; the synthesis is not tested
 * through its own helper.
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

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
  Engineer:
    - eng@x.io
`;

const GROUPS_YAML = `groups:
  Sales Team:
    - sam@x.io
    - sue@x.io
`;

/** A plugin folder's access.md in the body-governed format. */
function pluginAccessMd(body: string): string {
  return `---\nread:\n  - everyone\n---\n${body}`;
}

describe('plugin principals', () => {
  let root: string;
  const workspaceId = 'ws-plugins-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-plugin-principals-'));
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

  // A plugin IS a folder with a manifest; its access.md is its roster.
  const BASE = {
    'roles.yaml': ROLES_YAML,
    'groups.yaml': GROUPS_YAML,
    'access.md': '---\nwrite:\n  - Admin\n---\n',
    'Plugins/GTM/plugin.json': '{"name":"gtm"}',
    'Plugins/GTM/access.md': pluginAccessMd(
      'read:\n  - Sales Team\n  - Ali <ali@x.io>\nwrite:\n  - Engineer\nowner:\n  - Owen <owen@x.io>\n',
    ),
  };

  describe('grammar', () => {
    it('canonicalises the name half to the manifest slug and keeps the verb', () => {
      const parsed = parseAccessEntry('plugin/Sales Team/read');
      expect(parsed.ok && parsed.entry.kind === 'role' && parsed.entry.role).toBe('plugin/sales-team/read');
      const upper = parseAccessEntry('Plugin/GTM/Write');
      expect(upper.ok && upper.entry.kind === 'role' && upper.entry.role).toBe('plugin/gtm/write');
      const denied = parseAccessEntry('deny plugin/GTM/owner');
      expect(denied.ok && denied.entry.kind === 'role' && denied.entry.deny).toBe(true);
    });

    it('rejects a token with a missing or unknown verb, naming the valid shapes', () => {
      for (const bad of ['plugin/GTM', 'plugin/GTM/', 'plugin/GTM/admin', 'plugin//read']) {
        const parsed = parseAccessEntry(bad);
        expect(parsed.ok, bad).toBe(false);
        expect(!parsed.ok && parsed.error).toMatch(/plugin\/<plugin>\/read/);
      }
    });
  });

  describe('resolution', () => {
    it('grants a shared skill to the plugin\'s readers, writers and owners — and to nobody else', async () => {
      const svc = await makeService({
        ...BASE,
        'Skills/Eng/deploy/access.md': '---\n---\nread:\n  - plugin/GTM/read\n',
      });
      const skill = 'Skills/Eng/deploy/SKILL.md';
      // Group member, direct reader, writer (write implies read), owner.
      for (const email of ['sam@x.io', 'ali@x.io', 'eng@x.io', 'owen@x.io']) {
        expect(await svc.canRead(workspaceId, email, skill), email).toBe(true);
      }
      expect(await svc.canRead(workspaceId, 'mallory@x.io', skill)).toBe(false);
      // Read on the plugin is read on the skill, nothing more.
      expect(await svc.canWrite(workspaceId, 'sam@x.io', skill)).toBe(false);
    });

    it('the write token names the plugin\'s writers and owners only', async () => {
      const svc = await makeService({
        ...BASE,
        'Skills/Eng/deploy/access.md': '---\n---\nread:\n  - plugin/GTM/read\nwrite:\n  - plugin/GTM/write\n',
      });
      const skill = 'Skills/Eng/deploy/SKILL.md';
      expect(await svc.canWrite(workspaceId, 'eng@x.io', skill)).toBe(true);
      expect(await svc.canWrite(workspaceId, 'owen@x.io', skill)).toBe(true);
      expect(await svc.canWrite(workspaceId, 'sam@x.io', skill)).toBe(false);
      expect(await svc.canWrite(workspaceId, 'ali@x.io', skill)).toBe(false);
    });

    it('the owner token names owners alone', async () => {
      const svc = await makeService({
        ...BASE,
        'KnowledgeBase/Ops/access.md': '---\n---\nread:\n  - plugin/GTM/owner\n',
      });
      expect(await svc.canRead(workspaceId, 'owen@x.io', 'KnowledgeBase/Ops/x.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'eng@x.io', 'KnowledgeBase/Ops/x.md')).toBe(false);
    });

    it('follows the plugin\'s roster live: a member removed from the plugin loses the skill', async () => {
      const files = {
        ...BASE,
        'Skills/Eng/deploy/access.md': '---\n---\nread:\n  - plugin/GTM/read\n',
      };
      const svc = await makeService(files);
      const skill = 'Skills/Eng/deploy/SKILL.md';
      expect(await svc.canRead(workspaceId, 'ali@x.io', skill)).toBe(true);

      // Drop Ali from the plugin's own access.md — nothing on the skill changes.
      await fs.writeFile(
        path.join(root, workspaceId, KB_DIR, 'Plugins/GTM/access.md'),
        pluginAccessMd('read:\n  - Sales Team\nwrite:\n  - Engineer\n'),
      );
      svc.invalidate(workspaceId);
      expect(await svc.canRead(workspaceId, 'ali@x.io', skill)).toBe(false);
      expect(await svc.canRead(workspaceId, 'sam@x.io', skill)).toBe(true);
    });

    it('a plugin readable by everyone yields a public principal', async () => {
      const svc = await makeService({
        ...BASE,
        'Plugins/Open/plugin.json': '{"name":"open"}',
        'Plugins/Open/access.md': pluginAccessMd('read:\n  - everyone\nwrite:\n  - Admin\n'),
        'Skills/Common/tips/access.md': '---\n---\nread:\n  - plugin/Open/read\n',
      });
      expect(await svc.canRead(workspaceId, 'nobody@elsewhere.io', 'Skills/Common/tips/SKILL.md')).toBe(true);
      // The write token of that plugin is still its writers only.
      expect(await svc.canWrite(workspaceId, 'nobody@elsewhere.io', 'Skills/Common/tips/SKILL.md')).toBe(false);
    });

    it('membership never counts the access.md frontmatter, a deny, or another plugin token', async () => {
      const svc = await makeService({
        ...BASE,
        // Frontmatter `read: everyone` is discoverability of the FILE. The body
        // denies Sue, and points at another plugin's token.
        'Plugins/Narrow/plugin.json': '{"name":"narrow"}',
        'Plugins/Narrow/access.md': pluginAccessMd(
          'read:\n  - Sales Team\n  - deny Sue <sue@x.io>\n  - plugin/GTM/read\nwrite:\n  - Admin\n',
        ),
        'Skills/S/x/access.md': '---\n---\nread:\n  - plugin/Narrow/read\n',
      });
      const skill = 'Skills/S/x/SKILL.md';
      expect(await svc.canRead(workspaceId, 'sam@x.io', skill)).toBe(true);
      // Deny entries are skipped, not subtracted: Sue is still in Sales Team.
      expect(await svc.canRead(workspaceId, 'sue@x.io', skill)).toBe(true);
      // GTM's reader Ali is NOT a member of Narrow through the nested token.
      expect(await svc.canRead(workspaceId, 'ali@x.io', skill)).toBe(false);
      // And nobody at random: the frontmatter `everyone` did not leak in.
      expect(await svc.canRead(workspaceId, 'mallory@x.io', skill)).toBe(false);
    });

    it('a token naming a plugin that does not exist is ignored like an unknown role', async () => {
      const svc = await makeService({
        ...BASE,
        'Skills/S/x/access.md': '---\n---\nread:\n  - plugin/Ghost/read\n  - Ali <ali@x.io>\n',
      });
      expect(await svc.canRead(workspaceId, 'ali@x.io', 'Skills/S/x/SKILL.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'sam@x.io', 'Skills/S/x/SKILL.md')).toBe(false);
    });
  });

  describe('display', () => {
    it('eligibleReaders reports the token as a plugin-kind principal with the folder\'s casing', async () => {
      const svc = await makeService({
        ...BASE,
        'Skills/Eng/deploy/access.md': '---\n---\nread:\n  - plugin/gtm/read\n',
      });
      const readers = await svc.eligibleReaders(workspaceId, 'Skills/Eng/deploy');
      expect(readers.restricted).toBe(true);
      expect(readers.principals).toContainEqual({ name: 'plugin/GTM/read', kind: 'plugin' });
    });

    it('a plugin nested deeper than the root gets its principals too — a plugin is a folder with a manifest', async () => {
      const svc = await makeService({
        ...BASE,
        'Plugins/teams/Deep/plugin.json': '{"name":"deep"}',
        'Plugins/teams/Deep/access.md': pluginAccessMd('read:\n  - Ali <ali@x.io>\n'),
        // A scope folder's own access.md is NOT a roster: no manifest beside it.
        'Plugins/teams/access.md': '---\n---\nread:\n  - everyone\n',
        'Skills/S/x/access.md': '---\n---\nread:\n  - plugin/Deep/read\n  - plugin/teams/read\n',
      });
      expect(await svc.canRead(workspaceId, 'ali@x.io', 'Skills/S/x/SKILL.md')).toBe(true);
      expect(await svc.canRead(workspaceId, 'mallory@x.io', 'Skills/S/x/SKILL.md')).toBe(false);
    });

    it('kbPrincipals lists plugin folders once each, personal folders excluded', async () => {
      const svc = await makeService({
        ...BASE,
        'Plugins/Ops/plugin.json': '{"name":"ops"}',
        'Plugins/Ops/access.md': pluginAccessMd('read:\n  - Admin\n'),
        'Plugins/personal-abc123/plugin.json': '{"name":"personal-abc123"}',
        'Plugins/personal-abc123/access.md': '---\n---\nread:\n  - Ali <ali@x.io>\n',
      });
      const { plugins } = await svc.kbPrincipals(workspaceId);
      expect(plugins).toEqual(['GTM', 'Ops']);
    });
  });
});
