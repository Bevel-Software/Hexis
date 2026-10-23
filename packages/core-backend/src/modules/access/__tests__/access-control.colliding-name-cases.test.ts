/**
 * The case table for a name shared by a role and a group (the moved property
 * of decision #315, "a bare name means the role"). Before this change a bare
 * name meant the GROUP when both existed; it now means the ROLE. Exactly the
 * colliding bare spellings change meaning, in grants AND in denials (decided
 * by Razvan on 2026-10-23: a bare denial means the role exactly as a bare
 * grant does; a group denial is written `deny group/<Name>`):
 *
 *   rule                   | role-only member      | group-only member
 *   -----------------------|-----------------------|----------------------
 *   read: Reviewer         | was denied → granted  | was granted → denied
 *   deny Reviewer          | was allowed → denied  | was denied → allowed
 *   read: group/Reviewer   | denied (unchanged)    | granted (new token)
 *   deny group/Reviewer    | allowed (unchanged)   | denied (new token)
 *   read: role/Reviewer    | granted (unchanged)   | denied (unchanged)
 *   deny role/Reviewer     | denied (unchanged)    | allowed (unchanged)
 *
 * A bare denial never touches the same-named group, so `read: group/Reviewer`
 * beside `deny Reviewer` lets the group in. A name held by only one kind
 * resolves as before. Every file with a colliding bare entry is listed by
 * the groups roster (`bareNameResolvesToRole`) so an Admin can rewrite it as
 * `group/<Name>` or `role/<Name>`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { AccessControlService } from '../access-control.service.js';

const KB_DIR = 'knowledge-base';
const WS = 'ws-colliding-name';

const ADMIN = 'admin@x.io';
const ROLE_MEMBER = 'role-member@x.io';
const GROUP_MEMBER = 'group-member@x.io';
const DOC = 'Docs/Plan.md';

const ROOT_FILES: Record<string, string> = {
  'roles.yaml': `roles:\n  Admin:\n    - ${ADMIN}\n  Reviewer:\n    - ${ROLE_MEMBER}\n`,
  'groups.yaml': `groups:\n  Reviewer:\n    - ${GROUP_MEMBER}\n`,
  'access.md': '---\nwrite:\n  - Admin\n---\nwrite:\n  - Admin\n',
  [DOC]: '# Plan\n',
};

describe('a name shared by a role and a group: grant and deny case table', () => {
  let root: string;
  let repo: string;
  let svc: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-colliding-name-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, text] of Object.entries(ROOT_FILES)) {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), text);
    }
    const workspaceService = {
      getWorkspacePath: async () => workspaceDir,
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    svc = new AccessControlService(workspaceService, KB_DIR, new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Who may read DOC when the Docs folder's read list is `entries`. */
  async function readers(entries: string[]): Promise<{ role: boolean; group: boolean }> {
    const body = `read:\n${entries.map((e) => `  - ${e}\n`).join('')}`;
    await fs.writeFile(path.join(repo, 'Docs/access.md'), `---\nwrite:\n  - Admin\n---\n${body}`);
    svc.invalidate(WS);
    return {
      role: await svc.canRead(WS, ROLE_MEMBER, DOC),
      group: await svc.canRead(WS, GROUP_MEMBER, DOC),
    };
  }

  it('a bare grant reaches the role only', async () => {
    expect(await readers(['Reviewer'])).toEqual({ role: true, group: false });
  });

  it('a bare denial reaches the role only: the members of the same-named group are untouched', async () => {
    expect(await readers(['everyone', 'deny Reviewer'])).toEqual({ role: false, group: true });
  });

  it('a group grant beside a bare denial lets the group in', async () => {
    expect(await readers(['group/Reviewer', 'deny Reviewer'])).toEqual({ role: false, group: true });
  });

  it('group/<Name> grants and denies the group only', async () => {
    expect(await readers(['group/Reviewer'])).toEqual({ role: false, group: true });
    expect(await readers(['everyone', 'deny group/Reviewer'])).toEqual({ role: true, group: false });
  });

  it('role/<Name> grants and denies the role only', async () => {
    expect(await readers(['role/Reviewer'])).toEqual({ role: true, group: false });
    expect(await readers(['everyone', 'deny role/Reviewer'])).toEqual({ role: false, group: true });
  });

  it('a bare name held only by a group still means the group, in grants and denials', async () => {
    await fs.writeFile(
      path.join(repo, 'roles.yaml'),
      `roles:\n  Admin:\n    - ${ADMIN}\n`,
    );
    expect(await readers(['Reviewer'])).toEqual({ role: false, group: true });
    expect(await readers(['everyone', 'deny Reviewer'])).toEqual({ role: true, group: false });
  });
});
