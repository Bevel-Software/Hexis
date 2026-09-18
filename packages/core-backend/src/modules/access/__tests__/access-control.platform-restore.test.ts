import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * `canRestorePlatformFile` — the one write allowed to land where the
 * destination's own rules refuse it.
 *
 * The repository this exists for is the broken one: `access.md` moved out of
 * the root, so the root resolves to default-deny and the move that would put
 * it back is the move the gate refuses. The rescue is therefore judged on
 * WHERE THE MOVE LANDS, is admin-only, and reaches nothing else — those three
 * are what these cases hold down.
 */

const KB = 'knowledge-base';
const ADMIN = 'razvan@bevel.software';
const OWNER = 'owner@bevel.software';
const ENGINEER = 'ali@bevel.software';

const ROLES_YAML = `roles:
  Admin:
    - ${ADMIN}
  Engineer:
    - ${ENGINEER}
`;

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspace(workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async () => workspaceDir,
  } as unknown as WorkspaceService;
}

describe('restoring a platform file', () => {
  const WS = workspaceIdForBranch('main');
  let root: string;
  let repo: string;
  let ws: WorkspaceService;
  const service = () => new AccessControlService(ws, KB, new NodeFs(), [OWNER]);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-platform-restore-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await write(repo, 'roles.yaml', ROLES_YAML);
    ws = stubWorkspace(workspaceDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lets an admin land the three root-only platform files at the root of a repository whose root denies everyone', async () => {
    // The state the ticket describes: the root's own rules are gone, so the
    // ordinary gate has no grant to give anyone.
    const svc = service();
    for (const name of ['roles.yaml', '.bevelignore', 'AGENTS.md']) {
      expect(await svc.canRestorePlatformFile(WS, ADMIN, name)).toBe(true);
    }
  });

  it('lets an admin land the three root-only platform files even when the root access.md denies Admin outright', async () => {
    await write(repo, 'access.md', '---\nwrite:\n  - deny everyone\n  - deny Admin\n---\n');
    const svc = service();
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'roles.yaml')).toBe(true);
    expect(await svc.canRestorePlatformFile(WS, ADMIN, '.bevelignore')).toBe(true);
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'AGENTS.md')).toBe(true);
  });

  it('the three root-only names are a restore at the root and nowhere else', async () => {
    const svc = service();
    for (const dest of ['Sales/roles.yaml', 'Sales/.bevelignore', 'Sales/AGENTS.md']) {
      expect(await svc.canRestorePlatformFile(WS, ADMIN, dest)).toBe(false);
    }
  });

  it('an access.md goes back into a folder that has none, never over one that has', async () => {
    await write(repo, 'Sales/access.md', '---\nwrite:\n  - Engineer\n---\n');
    await fs.mkdir(path.join(repo, 'Legal'), { recursive: true });
    const svc = service();
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'access.md')).toBe(true);
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'Legal/access.md')).toBe(true);
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'Sales/access.md')).toBe(false);
  });

  it('a non-admin never gets the exception, wherever it would land', async () => {
    const svc = service();
    for (const dest of ['roles.yaml', '.bevelignore', 'AGENTS.md', 'access.md', 'Legal/access.md']) {
      expect(await svc.canRestorePlatformFile(WS, ENGINEER, dest)).toBe(false);
    }
  });

  it('the deployment owner is an admin for it, and an ordinary destination is not a restore for anyone', async () => {
    const svc = service();
    expect(await svc.canRestorePlatformFile(WS, OWNER, 'roles.yaml')).toBe(true);
    for (const email of [ADMIN, OWNER]) {
      expect(await svc.canRestorePlatformFile(WS, email, 'Sales/deal.md')).toBe(false);
      expect(await svc.canRestorePlatformFile(WS, email, 'Sales/notes.md')).toBe(false);
    }
  });

  it('with roles.yaml itself missing, the deployment owner is the only admin left', async () => {
    // The lockout in its worst form: the file that says who is an Admin is
    // the file that was moved. There is no model to read, so the answer comes
    // from the person who can already set ADMIN_EMAIL — and from nobody else.
    await fs.rm(path.join(repo, 'roles.yaml'));
    const svc = service();
    expect(await svc.canRestorePlatformFile(WS, OWNER, 'roles.yaml')).toBe(true);
    expect(await svc.canRestorePlatformFile(WS, ADMIN, 'roles.yaml')).toBe(false);
    expect(await svc.canRestorePlatformFile(WS, ENGINEER, 'roles.yaml')).toBe(false);
  });
});
