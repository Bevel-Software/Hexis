import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

/**
 * `canReadAsEveryoneBatch`: what the org-wide `everyone` principal reads,
 * asked of nobody in particular. Driven over a real on-disk tree through the
 * public resolver, like the group-read tests, because the answer has to
 * agree with what a signed-in person who is in no group and holds no role
 * gets — and with nothing anyone holds for a reason of their own.
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
`;

const rules = (body: string) => `---\n${body}---\n`;

describe('canReadAsEveryoneBatch', () => {
  let root: string;
  const workspaceId = 'ws-everyone-read-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-everyone-read-'));
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
    // Org-wide: the plugin's own rules admit everyone.
    'Plugins/Handbook/plugin.json': '{"name":"handbook"}',
    'Plugins/Handbook/access.md': rules('read:\n  - everyone\n') + 'read:\n  - everyone\n',
    // A team's: discoverable by everyone (the file), readable by the group (the folder).
    'Plugins/GTM/plugin.json': '{"name":"gtm"}',
    'Plugins/GTM/access.md': rules('read:\n  - everyone\n') + 'read:\n  - Sales Team\n',
    // A shared skill the public plugin links — reachable through its public principal.
    'Skills/Shared/access.md': rules('read:\n  - plugin/handbook/read\n'),
    'Skills/Shared/welcome/SKILL.md': '# Welcome\n',
    // A shared skill only the team's plugin links.
    'Skills/Sales/access.md': rules('read:\n  - plugin/gtm/read\n'),
    'Skills/Sales/deal/SKILL.md': '# Deal\n',
    // Public by the built-in principal, with a closer carve-out beneath.
    'Skills/Open/access.md': rules('read:\n  - everyone\n'),
    'Skills/Open/hello/SKILL.md': '# Hello\n',
    'Skills/Open/secret/access.md': rules('read:\n  - deny everyone\n  - Engineer\n'),
    'Skills/Open/secret/SKILL.md': '# Secret\n',
    // Granted to a role, and to a person: theirs, not the organisation's.
    'Skills/Eng/access.md': rules('read:\n  - Engineer\n'),
    'Skills/Eng/deploy/SKILL.md': '# Deploy\n',
    'Skills/Mine/access.md': rules('read:\n  - Sam <sam@x.io>\n'),
    'Skills/Mine/notes/SKILL.md': '# Notes\n',
  };

  const PATHS = [
    'Plugins/Handbook',
    'Plugins/Handbook/access.md',
    'Plugins/GTM',
    'Plugins/GTM/access.md',
    'Skills/Shared/welcome/SKILL.md',
    'Skills/Sales/deal/SKILL.md',
    'Skills/Open/hello/SKILL.md',
    'Skills/Open/secret/SKILL.md',
    'Skills/Eng/deploy/SKILL.md',
    'Skills/Mine/notes/SKILL.md',
  ];

  it('answers for the organisation: the built-in grant, a public plugin and what it links, and no one\'s own', async () => {
    const svc = await makeService(TREE);
    const verdict = await svc.canReadAsEveryoneBatch(workspaceId, PATHS);
    expect(Object.fromEntries(verdict)).toEqual({
      'Plugins/Handbook': true, // admits everyone
      'Plugins/Handbook/access.md': true,
      'Plugins/GTM': false, // a team's
      'Plugins/GTM/access.md': true, // …but discoverable by all
      'Skills/Shared/welcome/SKILL.md': true, // through the public plugin's principal
      'Skills/Sales/deal/SKILL.md': false, // through a team plugin's only
      'Skills/Open/hello/SKILL.md': true, // read: everyone
      'Skills/Open/secret/SKILL.md': false, // a closer deny everyone wins
      'Skills/Eng/deploy/SKILL.md': false, // a role's
      'Skills/Mine/notes/SKILL.md': false, // a person's
    });
  });

  it('agrees with what a signed-in person in no group and no role holds, and with nothing more', async () => {
    const svc = await makeService(TREE);
    const everyone = await svc.canReadAsEveryoneBatch(workspaceId, PATHS);
    expect(everyone).toEqual(await svc.canReadBatch(workspaceId, 'nobody@x.io', PATHS));
    // Members and admins hold more, for reasons of their own: none of it is the organisation's.
    const sam = await svc.canReadBatch(workspaceId, 'sam@x.io', PATHS);
    expect(sam.get('Plugins/GTM')).toBe(true);
    expect(sam.get('Skills/Mine/notes/SKILL.md')).toBe(true);
    expect(everyone.get('Plugins/GTM')).toBe(false);
    expect(everyone.get('Skills/Mine/notes/SKILL.md')).toBe(false);
  });

  it('has no admin rescue: what only Admin may read is not org-wide', async () => {
    const svc = await makeService({
      ...TREE,
      'Skills/Board/access.md': rules('read:\n  - Admin\n'),
      'Skills/Board/minutes/SKILL.md': '# Minutes\n',
    });
    const verdict = await svc.canReadAsEveryoneBatch(workspaceId, ['Skills/Board/minutes/SKILL.md']);
    expect(verdict.get('Skills/Board/minutes/SKILL.md')).toBe(false);
  });
});
