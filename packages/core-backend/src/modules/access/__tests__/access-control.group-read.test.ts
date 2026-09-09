import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

/**
 * `canReadAsGroupBatch`: what being in a group confers, asked of the GROUP
 * rather than of one of its members. Driven over a real on-disk tree through
 * the public resolver, like the plugin-principal tests, because the answer
 * has to agree with what a member holds for the group's sake — and with
 * nothing they hold for their own.
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
  Leads:
    - group:Sales Team
`;

const GROUPS_YAML = `groups:
  Sales Team:
    - sam@x.io
    - sue@x.io
  Design:
    - dee@x.io
`;

const rules = (body: string) => `---\n${body}---\n`;

describe('canReadAsGroupBatch', () => {
  let root: string;
  const workspaceId = 'ws-group-read-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-group-read-'));
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

  const TREE = {
    'roles.yaml': ROLES_YAML,
    'groups.yaml': GROUPS_YAML,
    'access.md': rules('write:\n  - Admin\n'),
    // A plugin that admits the group by name.
    'Plugins/GTM/plugin.json': '{"name":"gtm"}',
    'Plugins/GTM/access.md': rules('read:\n  - everyone\n') + 'read:\n  - Sales Team\nwrite:\n  - Engineer\n',
    // A plugin that admits the group only through a ROLE that lists it.
    'Plugins/Ops/plugin.json': '{"name":"ops"}',
    'Plugins/Ops/access.md': rules('read:\n  - everyone\n') + 'read:\n  - Leads\n',
    // A plugin that admits someone else entirely.
    'Plugins/Studio/plugin.json': '{"name":"studio"}',
    'Plugins/Studio/access.md': rules('read:\n  - everyone\n') + 'read:\n  - Design\n',
    // A shared skill the GTM plugin's members reach through the plugin principal.
    'Skills/Sales/access.md': rules('read:\n  - plugin/gtm/read\n'),
    'Skills/Sales/deal/SKILL.md': '# Deal\n',
    // A shared skill that names the group directly.
    'Skills/Direct/access.md': rules('read:\n  - Sales Team\n'),
    'Skills/Direct/pitch/SKILL.md': '# Pitch\n',
    // One that names a MEMBER, not the group: theirs, not the team's.
    'Skills/Personal/access.md': rules('read:\n  - Sam <sam@x.io>\n'),
    'Skills/Personal/notes/SKILL.md': '# Notes\n',
    // Public, so every team can read it.
    'Skills/Open/access.md': rules('read:\n  - everyone\n'),
    'Skills/Open/hello/SKILL.md': '# Hello\n',
    // Granted above, denied closer in: the closer rule wins for a group too.
    'Skills/Direct/secret/access.md': rules('read:\n  - deny Sales Team\n'),
    'Skills/Direct/secret/SKILL.md': '# Secret\n',
  };

  const PATHS = [
    'Plugins/GTM',
    'Plugins/Ops',
    'Plugins/Studio',
    'Skills/Sales/deal/SKILL.md',
    'Skills/Direct/pitch/SKILL.md',
    'Skills/Personal/notes/SKILL.md',
    'Skills/Open/hello/SKILL.md',
    'Skills/Direct/secret/SKILL.md',
  ];

  it('answers for the group: its own grants, the roles that list it, the plugins that admit it, and the public', async () => {
    const svc = await makeService(TREE);
    const verdict = await svc.canReadAsGroupBatch(workspaceId, 'Sales Team', PATHS);
    expect(verdict && Object.fromEntries(verdict)).toEqual({
      'Plugins/GTM': true, // admitted by name
      'Plugins/Ops': true, // admitted through the Leads role
      'Plugins/Studio': false, // someone else's
      'Skills/Sales/deal/SKILL.md': true, // through plugin/gtm/read
      'Skills/Direct/pitch/SKILL.md': true, // named directly
      'Skills/Personal/notes/SKILL.md': false, // a member's own grant is not the team's
      'Skills/Open/hello/SKILL.md': true, // everyone
      'Skills/Direct/secret/SKILL.md': false, // a closer deny wins
    });
  });

  it('agrees with what a member holds for the group alone', async () => {
    // Sue is in the team and nothing else: her verdicts ARE the team's.
    const svc = await makeService(TREE);
    const team = await svc.canReadAsGroupBatch(workspaceId, 'Sales Team', PATHS);
    const sue = await svc.canReadBatch(workspaceId, 'sue@x.io', PATHS);
    expect(team).toEqual(sue);
    // Sam holds one thing more, for himself — the difference is exactly that.
    const sam = await svc.canReadBatch(workspaceId, 'sam@x.io', PATHS);
    expect(sam.get('Skills/Personal/notes/SKILL.md')).toBe(true);
    expect(team?.get('Skills/Personal/notes/SKILL.md')).toBe(false);
  });

  it('takes the display name as spelled, in any case', async () => {
    const svc = await makeService(TREE);
    const verdict = await svc.canReadAsGroupBatch(workspaceId, 'sales team', ['Plugins/GTM']);
    expect(verdict?.get('Plugins/GTM')).toBe(true);
  });

  it('is null for a name that is not a group — a role of that name included', async () => {
    const svc = await makeService(TREE);
    expect(await svc.canReadAsGroupBatch(workspaceId, 'Nobody', ['Plugins/GTM'])).toBeNull();
    expect(await svc.canReadAsGroupBatch(workspaceId, 'Engineer', ['Plugins/GTM'])).toBeNull();
  });

  it('holds only the grants spelled for it: a group named like a role takes the bare token, never the role/ one', async () => {
    const svc = await makeService({
      ...TREE,
      'groups.yaml': `groups:\n  Admin:\n    - boss@x.io\n`,
      // The root's write grant pins the ROLE; the group that shares its name
      // gets nothing from it, and there is no admin rescue for a group.
      'access.md': rules('write:\n  - role/Admin\n'),
    });
    const verdict = await svc.canReadAsGroupBatch(workspaceId, 'Admin', ['Plugins/Studio', 'Plugins/GTM']);
    expect(verdict?.get('Plugins/Studio')).toBe(false);
    expect(verdict?.get('Plugins/GTM')).toBe(false);
  });
});
