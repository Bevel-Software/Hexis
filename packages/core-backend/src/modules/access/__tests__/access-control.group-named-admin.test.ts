/**
 * QA reproduction (v0.28.0 hunt, decisions #312/#315): a Business user's
 * agent proposed a group named `Admin` in groups.yaml, an Admin approved the
 * change request, and every member of the group then received the Admin
 * role's grants wherever an access rule said `Admin` — because a bare name
 * meant the GROUP when a group and a role shared it.
 *
 * The rule now: a bare name means the ROLE when one of that name exists; the
 * group is reachable only as `group/<Name>`. This pins that the approved
 * group gives its members nothing the Admin role is granted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';
const WS = 'ws-group-named-admin';

const ADMIN = 'admin@x.io';
const BUSINESS = 'business@x.io';

const BEFORE: Record<string, string> = {
  'roles.yaml': `roles:\n  Admin:\n    - ${ADMIN}\n`,
  'groups.yaml': `groups:\n  Sales:\n    - ${BUSINESS}\n`,
  // The root: Admin writes everything, Sales reads.
  'access.md': '---\nwrite:\n  - Admin\n---\nread:\n  - group/Sales\nwrite:\n  - Admin\n',
  // An admin-only folder, granted by the bare role name and closed to the rest.
  'Knowledge/Board/access.md': '---\nwrite:\n  - Admin\n---\nread:\n  - Admin\n  - deny everyone\nwrite:\n  - Admin\nowner:\n  - Admin\n',
  'Knowledge/Board/Minutes.md': '# Minutes\n',
};

/** The change request's one edit: a group named Admin, holding the proposer. */
const PROPOSED_GROUPS = `groups:\n  Sales:\n    - ${BUSINESS}\n  Admin:\n    - ${BUSINESS}\n`;

describe('a group named Admin (QA reproduction)', () => {
  let root: string;
  let repo: string;
  let svc: AccessControlService;
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-group-admin-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, text] of Object.entries(BEFORE)) {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), text);
    }
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@x.io');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '-m', 'seed');

    // The Business user's proposal, on its own branch…
    await git('checkout', '-b', 'proposal/admin-group');
    await fs.writeFile(path.join(repo, 'groups.yaml'), PROPOSED_GROUPS);
    await git('commit', '-am', 'Add group Admin');
    // …approved by an Admin and merged into main.
    await git('checkout', 'main');
    await git('merge', '--no-ff', '-m', 'Approve: Add group Admin', 'proposal/admin-group');

    const workspaceService = {
      getWorkspacePath: async () => workspaceDir,
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    svc = new AccessControlService(workspaceService, KB_DIR, new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('its members receive none of the Admin role grants', async () => {
    expect(await fs.readFile(path.join(repo, 'groups.yaml'), 'utf-8')).toBe(PROPOSED_GROUPS);

    // `read: Admin` / `write: Admin` / `owner: Admin` are the ROLE's.
    expect(await svc.canRead(WS, BUSINESS, 'Knowledge/Board/Minutes.md')).toBe(false);
    expect(await svc.canWrite(WS, BUSINESS, 'Knowledge/Board/Minutes.md')).toBe(false);
    expect(await svc.canWrite(WS, BUSINESS, 'Knowledge/Doc.md')).toBe(false);
    // …and the gate paths, which read the committed state, agree.
    expect(await svc.canWriteAtRef(WS, 'main', BUSINESS, 'Knowledge/Board/Minutes.md')).toBe(false);
    // The Admin capability is the role's alone.
    expect(await svc.canWrite(WS, BUSINESS, 'roles.yaml')).toBe(false);
    expect(await svc.adminEmails(WS)).toEqual([ADMIN]);

    // The real Admin keeps everything, and Sales keeps what Sales had.
    expect(await svc.canRead(WS, ADMIN, 'Knowledge/Board/Minutes.md')).toBe(true);
    expect(await svc.canWrite(WS, ADMIN, 'Knowledge/Board/Minutes.md')).toBe(true);
    expect(await svc.canRead(WS, BUSINESS, 'Knowledge/Doc.md')).toBe(true);

    // The dialog's lists name the ROLE, never the group.
    const readers = await svc.eligibleReaders(WS, 'Knowledge/Board/Minutes.md');
    expect(readers.principals).toContainEqual({ name: 'Admin', kind: 'role' });
    expect(readers.principals).not.toContainEqual({ name: 'Admin', kind: 'group' });
  });

  it('the group is reachable only by its explicit spelling, group/Admin', async () => {
    await fs.writeFile(
      path.join(repo, 'Knowledge/Board/access.md'),
      '---\nwrite:\n  - Admin\n---\nread:\n  - Admin\n  - group/Admin\n  - deny everyone\nwrite:\n  - Admin\n',
    );
    svc.invalidate(WS);
    expect(await svc.canRead(WS, BUSINESS, 'Knowledge/Board/Minutes.md')).toBe(true);
    // Reading is all `group/Admin` was granted.
    expect(await svc.canWrite(WS, BUSINESS, 'Knowledge/Board/Minutes.md')).toBe(false);
    const readers = await svc.eligibleReaders(WS, 'Knowledge/Board/Minutes.md');
    expect(readers.principals).toContainEqual({ name: 'Admin', kind: 'group' });
    expect(readers.principals).toContainEqual({ name: 'Admin', kind: 'role' });
  });
});
