import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { AccessControlService } from '../access-control.service.js';
import { createAccessRoutes } from '../access.routes.js';
import { branchForWorkspaceId, workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * Manage access on a file that exists ONLY on a change request's branch.
 *
 * The share dialog addresses such a file through the proposal branch's
 * workspace. These tests run the real routes, the real resolver and the real
 * splice against real git clones, and check what matters to the user: the
 * grant is a commit on the proposal branch that shows up in the request's
 * diff, it takes effect on the default branch by merging alone, the gate is
 * the one every mutation uses (evaluated on the proposal branch), and revoke
 * is symmetric.
 */

const KB = 'knowledge-base';
const MAIN = 'main';
const PROPOSAL = 'suggestions/alice/knowledge';
const NEW_FILE = 'Sales/New.md';

const USERS = {
  alice: { id: 'u-alice', email: 'alice@bevel.software', name: 'Alice' },
  carol: { id: 'u-carol', email: 'carol@bevel.software', name: 'Carol' },
};
const BOB = { kind: 'user' as const, email: 'bob@bevel.software', displayName: 'Bob' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@bevel.software', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  );
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

describe('access routes on a proposal branch (real git)', () => {
  let root: string;
  let mainRepo: string;
  let proposalRepo: string;
  let access: AccessControlService;
  let server: Server;
  let baseUrl: string;
  const releaseLock = vi.fn();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-proposal-access-'));
    const dirFor = (branch: string) => path.join(root, workspaceIdForBranch(branch));

    // The default branch: Alice writes Sales; nobody else does.
    mainRepo = path.join(dirFor(MAIN), KB);
    await fs.mkdir(mainRepo, { recursive: true });
    git(mainRepo, 'init', '-q', '-b', MAIN);
    await write(mainRepo, 'roles.yaml', 'roles:\n  Admin:\n    - razvan@bevel.software\n');
    await write(mainRepo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    await write(mainRepo, 'Sales/access.md', '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n# Sales\n');
    git(mainRepo, 'add', '-A');
    git(mainRepo, 'commit', '-q', '-m', 'base');

    // Alice's change request ADDS a file that the default branch lacks.
    git(mainRepo, 'checkout', '-q', '-b', PROPOSAL);
    await write(mainRepo, NEW_FILE, '# New\n\nProposed page.\n');
    git(mainRepo, 'add', '-A');
    git(mainRepo, 'commit', '-q', '-m', 'propose New.md');
    git(mainRepo, 'checkout', '-q', MAIN);

    // One clone per branch, as the workspace service keeps them.
    proposalRepo = path.join(dirFor(PROPOSAL), KB);
    git(mainRepo, 'worktree', 'add', '-q', proposalRepo, PROPOSAL);

    // Ids arrive decoded from the URL; normalise the way the service does.
    const dirOf = (id: string) => dirFor(branchForWorkspaceId(id));
    const workspaceService = {
      getWorkspacePath: async (id: string) => dirOf(id),
      getOrCreateForBranch: async (branch: string) => ({ id: workspaceIdForBranch(branch), kbDirName: KB }),
      readFile: async (id: string, wsRel: string) => fs.readFile(path.join(dirOf(id), wsRel), 'utf-8'),
      readFileBinary: async (id: string, wsRel: string) => fs.readFile(path.join(dirOf(id), wsRel)),
      writeFile: async (id: string, wsRel: string, content: string) => {
        await fs.writeFile(path.join(dirOf(id), wsRel), content, 'utf-8');
      },
    } as unknown as WorkspaceService;

    access = new AccessControlService(workspaceService, KB, new NodeFs());

    const authService = {
      getUserById: async (id: string) => Object.values(USERS).find((u) => u.id === id) ?? null,
    } as unknown as AuthService;

    // Releasing the edit lock is what commits the write — here, synchronously.
    releaseLock.mockReset();
    releaseLock.mockImplementation(async (id: string, branch: string, wsPath: string) => {
      const repo = path.join(dirOf(id), KB);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `access: ${wsPath} on ${branch}`);
    });
    const workflowService = {
      getLock: async () => null,
      acquireLock: async () => ({ acquired: true, lock: {} }),
      releaseLock,
      releaseLockNoCommit: async () => undefined,
    } as unknown as WorkflowService;

    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = String(req.headers['x-test-user']);
      next();
    });
    app.use(
      '/api',
      createAccessRoutes(
        access,
        workspaceService,
        authService,
        workflowService,
        { emit: () => {} } as unknown as WorkflowEventBus,
        {} as Database,
        KB,
      ),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    // A setup failure leaves no server; closing it anyway would mask that
    // failure and skip removing the temp dir.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Exactly the URL the share dialog builds: the raw workspace id in the path. */
  function post(route: 'grant' | 'revoke', as: keyof typeof USERS, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/workspace/${workspaceIdForBranch(PROPOSAL)}/access/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': USERS[as].id },
      body: JSON.stringify({ path: `${KB}/${NEW_FILE}`, kind: 'file', principal: BOB, ...body }),
    });
  }

  const requestDiff = () => git(mainRepo, 'diff', `${MAIN}...${PROPOSAL}`, '--', NEW_FILE);

  it('reads current access from the proposal branch', async () => {
    const res = await fetch(
      `${baseUrl}/api/workspace/${workspaceIdForBranch(PROPOSAL)}/access?path=${encodeURIComponent(`${KB}/${NEW_FILE}`)}&kind=file`,
      { headers: { 'x-test-user': USERS.alice.id } },
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as { canWrite: boolean };
    // The author writes the proposed file there (inherited from Sales).
    expect(view.canWrite).toBe(true);
  });

  it('lands the grant in the proposed file, visible in the request diff, and effective on merge', async () => {
    const res = await post('grant', 'alice', { verb: 'write' });
    expect(res.status).toBe(200);
    // The id reaches the route decoded (Express decodes params); what matters
    // is that the commit is released on the proposal branch.
    expect(releaseLock).toHaveBeenCalledWith(
      expect.any(String),
      PROPOSAL,
      `${KB}/${NEW_FILE}`,
      expect.anything(),
    );

    // Written into the proposed file on its branch — and nowhere on main.
    expect(await fs.readFile(path.join(proposalRepo, NEW_FILE), 'utf-8')).toContain('bob@bevel.software');
    await expect(fs.access(path.join(mainRepo, NEW_FILE))).rejects.toThrow();
    expect(git(mainRepo, 'status', '--porcelain')).toBe('');
    expect(requestDiff()).toMatch(/^\+.*bob@bevel\.software/m);

    // Merge the request: Bob holds exactly what was granted on main.
    git(mainRepo, 'merge', '-q', '--no-edit', PROPOSAL);
    access.invalidate(workspaceIdForBranch(MAIN));
    const mainWs = workspaceIdForBranch(MAIN);
    expect(await access.canWrite(mainWs, BOB.email, NEW_FILE)).toBe(true);
    expect(await access.canRead(mainWs, BOB.email, NEW_FILE)).toBe(true);
    expect(await access.canOwner(mainWs, BOB.email, NEW_FILE)).toBe(false);
    expect(await access.canDownload(mainWs, BOB.email, NEW_FILE)).toBe(false);
    // Only the new file carries the grant.
    expect(await access.canWrite(mainWs, BOB.email, 'Sales/access.md')).toBe(false);
  });

  it('refuses a caller who fails the mutation gate on the proposal branch — nothing written', async () => {
    const before = git(proposalRepo, 'rev-parse', 'HEAD');
    const res = await post('grant', 'carol', { verb: 'write' });

    expect(res.status).toBe(403);
    expect(releaseLock).not.toHaveBeenCalled();
    expect(git(proposalRepo, 'rev-parse', 'HEAD')).toBe(before);
    expect(await fs.readFile(path.join(proposalRepo, NEW_FILE), 'utf-8')).not.toContain('bob@');
  });

  it('revokes symmetrically on the proposal branch', async () => {
    expect((await post('grant', 'alice', { verb: 'write' })).status).toBe(200);
    expect(requestDiff()).toContain('bob@bevel.software');

    const res = await post('revoke', 'alice', {});
    expect(res.status).toBe(200);
    expect(releaseLock).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(proposalRepo, NEW_FILE), 'utf-8')).not.toContain('bob@');
    expect(requestDiff()).not.toContain('bob@bevel.software');
  });

  it('refuses a revoke from a caller who fails the gate', async () => {
    expect((await post('grant', 'alice', { verb: 'write' })).status).toBe(200);
    const res = await post('revoke', 'carol', {});
    expect(res.status).toBe(403);
    expect(await fs.readFile(path.join(proposalRepo, NEW_FILE), 'utf-8')).toContain('bob@bevel.software');
  });
});
