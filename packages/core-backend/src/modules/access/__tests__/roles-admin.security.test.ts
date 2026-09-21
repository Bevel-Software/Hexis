import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { NodeFs } from '../../kb-fs/node-fs.js';
import { AccessControlService } from '../access-control.service.js';
import { RolesAdminService } from '../roles-admin.service.js';
import { AdminAccessService } from '../../admin/admin-access.service.js';
import { createAccountRoutes } from '../../auth/account.routes.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAccountErasureService } from '../../auth/account-erasure.service.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';

/**
 * SECURITY: the revocation the tester could not reproduce.
 *
 * The report was "I removed an account from Admin and it kept every admin
 * screen" — true only because that account was the DEPLOYMENT ADMIN
 * (`ADMIN_EMAIL`), which the resolver admits ahead of `roles.yaml` on purpose
 * (the rescue path for a roles file with no Admin left). For a REGULAR
 * account, removal must bite on the very next request, with no sign-out and
 * no cache to wait out.
 *
 * So this pins both halves end-to-end, against a real `roles.yaml` on disk, a
 * real resolver, and a real admin-only HTTP route (`GET /api/admin/accounts`,
 * gated by the same `AdminAccessService.isAdmin` every admin surface uses):
 *   1. remove a regular admin  → their next admin-only request is 403;
 *   2. remove the deployment admin's address from the FILE → still 200,
 *      because the server configuration, not the file, makes them an admin.
 */

const KB = 'knowledge-base';
const WS = workspaceIdForBranch(DEFAULT_BRANCH);

const OWNER = 'owner@bevel.software';
const ACTOR: AuthUser = { id: 'u-actor', email: 'razvan@bevel.software', name: 'Razvan' } as AuthUser;
const ALICE = 'alice@bevel.software';

const ROLES = `roles:
  Admin:
    - razvan@bevel.software
    - ${ALICE}
  Sales:
    - felix@example.com
`;

/** Minimal WorkspaceService over a real temp workspace dir. */
function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    listFiles: async () => ({
      name: path.basename(workspaceDir),
      relativePath: '.',
      type: 'directory',
      children: [],
    }),
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      await fs.mkdir(path.dirname(resolve(wsRel)), { recursive: true });
      await fs.writeFile(resolve(wsRel), content, 'utf-8');
    },
  } as unknown as WorkspaceService;
}

/** Lock/commit stub: the real LockingFilesystem writes the bytes to disk. */
function stubWorkflow(): WorkflowService {
  const locks = new Map<string, AuthUser>();
  const row = (h: AuthUser) => ({ holderUserId: h.id, holderName: h.name });
  return {
    getLock: async (_w: string, _b: string, p: string) => {
      const h = locks.get(p);
      return h ? row(h) : null;
    },
    acquireLock: async (_w: string, _b: string, p: string, user: AuthUser) => {
      const h = locks.get(p);
      if (h) return { acquired: false, lock: row(h) };
      locks.set(p, user);
      return { acquired: true, lock: row(user) };
    },
    releaseLock: async (_w: string, _b: string, p: string) => void locks.delete(p),
    releaseLockNoCommit: async (_w: string, _b: string, p: string) => void locks.delete(p),
    commitChanges: async () => ({}) as unknown,
  } as unknown as WorkflowService;
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('SECURITY: Admin-role removal takes effect on the next request', () => {
  let repo: string;
  let access: AccessControlService;
  let rolesAdmin: RolesAdminService;
  let baseUrl: string;
  // Both stay undefined until `beforeEach` gets that far. Vitest runs
  // `afterEach` even when setup threw, so tear-down must not throw over the
  // top of the real failure.
  let root: string | undefined;
  let server: Server | undefined;

  /** The admin-only request under test, made AS `email`. */
  async function adminOnlyRequest(email: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/admin/accounts`, { headers: { 'x-test-email': email } });
    return res.status;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-roles-security-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), ROLES, 'utf-8');

    const ws = stubWorkspace(workspaceDir);
    // ONE resolver instance shared by the mutation path and the gate — exactly
    // how the composition root wires it. A second instance would have its own
    // cache and could pass this test while production still served stale
    // verdicts, which is the failure mode worth guarding.
    access = new AccessControlService(ws, KB, new NodeFs(), [OWNER]);
    rolesAdmin = new RolesAdminService(ws, stubWorkflow(), access, KB, () => DEFAULT_BRANCH, undefined, [
      OWNER,
    ]);
    const adminAccess = new AdminAccessService(access, ws, DEFAULT_BRANCH, [OWNER]);

    const authService = {
      listAccounts: async () => [],
    } as unknown as AuthService;
    const erasure = { eraseUser: async () => undefined } as unknown as Pick<
      IAccountErasureService,
      'eraseUser'
    >;

    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userEmail?: string }).userEmail = req.header('x-test-email') ?? undefined;
      next();
    });
    app.use('/api', createAccountRoutes(authService, adminAccess, erasure));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await close(server);
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('a regular account removed from Admin is denied its NEXT admin-only request', async () => {
    // Before: Alice holds Admin through roles.yaml and the gate lets her in.
    expect(await adminOnlyRequest(ALICE)).toBe(200);

    await rolesAdmin.removeMember(ACTOR, 'admin', ALICE, false);
    // The write really landed — the gate is reading a file that no longer
    // names her, not a stubbed verdict.
    expect(await fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8')).not.toContain(ALICE);

    // After: denied immediately. No sign-out, no token refresh, no TTL wait —
    // this is the same process, the very next request.
    expect(await adminOnlyRequest(ALICE)).toBe(403);
    // And the removal is surgical: the remaining admin is untouched.
    expect(await adminOnlyRequest(ACTOR.email)).toBe(200);
  });

  it('the deployment admin keeps access even when the roles FILE never named them', async () => {
    // The by-design half of the report. `owner@` is not in roles.yaml at all,
    // yet the server configuration makes them an admin — this is the rescue
    // path, and it is why the page now lists them as a fixed member.
    expect(ROLES).not.toContain(OWNER);
    expect(await adminOnlyRequest(OWNER)).toBe(200);

    // Rewriting the file without them changes nothing, which is exactly the
    // confusion the fixed member row exists to explain.
    await fs.writeFile(path.join(repo, 'roles.yaml'), `roles:\n  Admin:\n    - ${ACTOR.email}\n`, 'utf-8');
    access.invalidate(WS);
    expect(await adminOnlyRequest(OWNER)).toBe(200);
  });

  it('an account that never held Admin is refused throughout', async () => {
    expect(await adminOnlyRequest('felix@example.com')).toBe(403);
  });
});
