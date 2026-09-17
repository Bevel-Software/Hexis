import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { AccessControlService } from '../access-control.service.js';
import {
  ADMIN_ROOT_WRITE_MESSAGE,
  AccessMutationError,
  AccessMutationService,
} from '../access-mutation.service.js';
import { createAccessRoutes } from '../access.routes.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * The Admin write floor at the repository root, and the eligible lists that
 * must agree with the resolver.
 *
 * The reported contradiction (reproduced before the change): a root
 * `access.md` that stops granting Admin write — a revoke of `write: Admin` or
 * a `deny Admin` from the share dialog — really did take write away, so the
 * next folder creation at the root was refused. Separately, the eligible
 * lists behind the dialog and the "Eligible: …" message were built from a
 * closest-wins-per-principal flattening of the scopes, which keeps a farther
 * grant even when a nearer scope decides for that principal without naming
 * it (`deny everyone`), and names the Admin role to a deployment owner the
 * resolver refused. Both let the dialog and the message call someone eligible
 * whom the gate then refused.
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
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      const abs = resolve(wsRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },
  } as unknown as WorkspaceService;
}

describe('Admin write floor at the repository root', () => {
  const WS = workspaceIdForBranch('main');
  let root: string;
  let repo: string;
  let ws: WorkspaceService;
  const service = () => new AccessControlService(ws, KB, new NodeFs(), [OWNER]);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-admin-floor-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await write(repo, 'roles.yaml', ROLES_YAML);
    ws = stubWorkspace(workspaceDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('resolver', () => {
    for (const [label, body] of [
      ['denies Admin write', 'write:\n  - Engineer\n  - deny Admin\n'],
      ['no longer lists Admin', 'write:\n  - Engineer\ndownload:\n  - Admin\n'],
      ['denies everyone write', 'write:\n  - deny everyone\n'],
    ] as const) {
      it(`keeps write for the Admin role and the deployment owner when the root ${label}`, async () => {
        await write(repo, 'access.md', `---\n---\n${body}`);
        const svc = service();
        for (const who of [ADMIN, OWNER]) {
          expect(await svc.canWrite(WS, who, '')).toBe(true);
          expect(await svc.canWrite(WS, who, 'README.md')).toBe(true);
          // Creating a folder at the root gates on its placeholder.
          expect(await svc.canWrite(WS, who, 'New/.gitkeep')).toBe(true);
        }
        expect((await svc.eligibleWriters(WS, 'New/.gitkeep')).roles).toContain('Admin');
      });
    }

    it('lists the deployment owner among eligible writer emails wherever the floor admits them', async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - deny Admin\n');
      const svc = service();
      // The owner is not in roles.yaml; the floor still makes them a writer, so
      // approval routing must count them.
      const emails = [...(await svc.eligibleWriterEmails(WS, 'README.md')).keys()].sort();
      expect(emails).toEqual([OWNER, ADMIN].sort());
    });

    it('keeps the floor with no root access.md at all', async () => {
      const svc = service();
      expect(await svc.canWrite(WS, ADMIN, 'README.md')).toBe(true);
      expect(await svc.canWrite(WS, OWNER, 'README.md')).toBe(true);
      expect(await svc.canWrite(WS, ENGINEER, 'README.md')).toBe(false);
    });

    it("ignores a root file's own frontmatter denying Admin write", async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\n');
      await write(repo, 'README.md', '---\nwrite:\n  - deny Admin\n---\n# Readme\n');
      expect(await service().canWrite(WS, ADMIN, 'README.md')).toBe(true);
    });

    it('is write only: read and download still answer to the access tree', async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - deny Admin\n');
      const svc = service();
      expect(await svc.canDownload(WS, ADMIN, 'README.md')).toBe(false);
      expect(await svc.canWrite(WS, ENGINEER, 'README.md')).toBe(false);
    });

    describe('a subfolder that excludes Admin', () => {
      it('by denying Admin: not a writer, not eligible, for the role and the owner alike', async () => {
        await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\n');
        await write(repo, 'HR/access.md', '---\n---\nwrite:\n  - Engineer\n  - deny Admin\n');
        const svc = service();
        expect(await svc.canWrite(WS, ADMIN, 'HR/Salaries.md')).toBe(false);
        expect(await svc.canWrite(WS, OWNER, 'HR/Salaries.md')).toBe(false);
        expect(await svc.canWrite(WS, ENGINEER, 'HR/Salaries.md')).toBe(true);
        expect((await svc.eligibleWriters(WS, 'HR/Salaries.md')).roles).toEqual(['Engineer']);
        expect([...(await svc.eligibleWriterEmails(WS, 'HR/Salaries.md')).keys()]).toEqual([ENGINEER]);
      });

      it('by denying everyone: the inherited Admin grant is not listed as eligible', async () => {
        await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\ndownload:\n  - Admin\n');
        await write(
          repo,
          'HR/access.md',
          '---\n---\nwrite:\n  - deny everyone\n  - Engineer\ndownload:\n  - deny everyone\n',
        );
        const svc = service();
        expect(await svc.canWrite(WS, ADMIN, 'HR/Salaries.md')).toBe(false);
        expect(await svc.canDownload(WS, ADMIN, 'HR/Salaries.md')).toBe(false);
        expect((await svc.eligibleWriters(WS, 'HR/Salaries.md')).roles).toEqual(['Engineer']);
        expect((await svc.eligibleDownloaders(WS, 'HR/Salaries.md')).roles).toEqual([]);
      });
    });

    it('holdsAdminRootWrite is true for an Admin member and the deployment owner only', async () => {
      const svc = service();
      expect(await svc.holdsAdminRootWrite(WS, ADMIN)).toBe(true);
      expect(await svc.holdsAdminRootWrite(WS, OWNER)).toBe(true);
      expect(await svc.holdsAdminRootWrite(WS, ENGINEER)).toBe(false);
    });
  });

  describe('denial message', () => {
    const denial = async (relativePath: string) => {
      const eligible = await service().eligibleWriters(WS, relativePath);
      return new AccessDeniedError({ path: relativePath, eligibleRoles: eligible.roles, eligibleUsers: eligible.users });
    };

    it('never names the Admin role an admin was refused for: a subfolder denying Admin lists only who is allowed', async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\n');
      await write(repo, 'HR/access.md', '---\n---\nwrite:\n  - Engineer\n  - deny Admin\n');
      expect((await denial('HR/Salaries.md')).message).toBe(
        'You don\'t have permission to write to "HR/Salaries.md". Eligible: Engineer.',
      );
    });

    it('names no one when a subfolder denies everyone', async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\n');
      await write(repo, 'Ops/access.md', '---\n---\nwrite:\n  - deny everyone\n');
      expect((await denial('Ops/Runbook.md')).message).toBe(
        'You don\'t have permission to write to "Ops/Runbook.md". Eligible: none.',
      );
    });
  });

  describe('share dialog mutations', () => {
    let mutation: AccessMutationService;
    const admin = { kind: 'role' as const, role: 'Admin' };

    beforeEach(async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\ndownload:\n  - Admin\n');
      await write(repo, 'README.md', '# Readme\n');
      mutation = new AccessMutationService(ws, service(), KB);
    });

    const refusal = (p: Promise<unknown>) =>
      expect(p).rejects.toSatisfy(
        (e: unknown) => e instanceof AccessMutationError && e.message === ADMIN_ROOT_WRITE_MESSAGE,
      );

    it('refuses revoke, verb-scoped revoke, deny-here and role/Admin spellings at the root', async () => {
      await refusal(mutation.revoke(WS, 'folder', '', admin, ADMIN, 'write'));
      await refusal(mutation.revoke(WS, 'folder', '', admin, ADMIN));
      await refusal(mutation.denyHere(WS, 'folder', '', admin, 'write'));
      await refusal(mutation.denyHere(WS, 'folder', '', { kind: 'role', role: 'role/Admin' }));
      await refusal(mutation.denyHere(WS, 'file', 'README.md', admin, 'write'));
      expect(await fs.readFile(path.join(repo, 'access.md'), 'utf-8')).toContain('write:\n  - Admin');
    });

    it('refuses deny-here on a PERSON who is an admin at the root, with the reason, and writes nothing', async () => {
      const before = await fs.readFile(path.join(repo, 'access.md'), 'utf-8');
      for (const email of [ADMIN, OWNER]) {
        const person = { kind: 'user' as const, email, displayName: 'Admin Person' };
        await refusal(mutation.denyHere(WS, 'folder', '', person, 'write'));
        await refusal(mutation.denyHere(WS, 'folder', '', person));
        await refusal(mutation.denyHere(WS, 'file', 'README.md', person, 'write'));
      }
      expect(await fs.readFile(path.join(repo, 'access.md'), 'utf-8')).toBe(before);
    });

    it('still lets deny-here restrict an admin person at the root on other verbs, and in a subfolder', async () => {
      const person = { kind: 'user' as const, email: ADMIN, displayName: 'Razvan' };
      await expect(mutation.denyHere(WS, 'folder', 'HR', person, 'write')).resolves.toMatchObject({ changed: true });
      await expect(mutation.denyHere(WS, 'folder', '', person, 'download')).resolves.toMatchObject({
        changed: true,
      });
    });

    it('lets a whole-row Remove of Admin at the root strip its other verbs when no write line names it', async () => {
      await write(repo, 'access.md', '---\n---\nread:\n  - Admin\ndownload:\n  - Admin\n');
      await expect(mutation.revoke(WS, 'folder', '', admin, ADMIN)).resolves.toMatchObject({ changed: true });
      const after = await fs.readFile(path.join(repo, 'access.md'), 'utf-8');
      expect(after).not.toContain('Admin');
      // Write still comes from the floor.
      expect(await service().canWrite(WS, ADMIN, 'README.md')).toBe(true);
    });

    it("still lets the root drop Admin's other verbs, and a subfolder exclude Admin", async () => {
      await expect(mutation.revoke(WS, 'folder', '', admin, ADMIN, 'download')).resolves.toMatchObject({
        changed: true,
      });
      await expect(mutation.denyHere(WS, 'folder', 'HR', admin, 'write')).resolves.toMatchObject({
        changed: true,
      });
    });
  });

  describe('routes', () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
      await write(repo, 'access.md', '---\n---\nwrite:\n  - Admin\ndownload:\n  - Admin\n');
      await write(repo, 'HR/access.md', '---\n---\nwrite:\n  - Engineer\n  - deny Admin\ndownload:\n  - deny Admin\n');
      const users = { 'u-admin': { id: 'u-admin', email: ADMIN, name: 'Razvan' } };
      const app = express();
      app.use(express.json());
      app.use('/api', (req, _res, next) => {
        (req as unknown as { userId: string }).userId = 'u-admin';
        next();
      });
      app.use(
        '/api',
        createAccessRoutes(
          service(),
          { ...ws, getOrCreateForBranch: async () => ({ id: WS, kbDirName: KB }) } as unknown as WorkspaceService,
          { getUserById: async (id: string) => users[id as 'u-admin'] ?? null } as unknown as AuthService,
          {
            getLock: async () => null,
            acquireLock: async () => ({ acquired: true, lock: {} }),
            releaseLock: async () => undefined,
            releaseLockNoCommit: async () => undefined,
          } as unknown as WorkflowService,
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const revoke = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/workspace/${WS}/access/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('refuses removing Admin write at the root with the lockout message', async () => {
      for (const mode of [undefined, 'deny-here']) {
        const res = await revoke({
          path: KB,
          kind: 'folder',
          principal: { kind: 'role', role: 'Admin' },
          verb: 'write',
          ...(mode ? { mode } : {}),
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe(ADMIN_ROOT_WRITE_MESSAGE);
      }
    });

    it('refuses `.` segments at the boundary, so the view and the guard see one spelling', async () => {
      for (const p of [`${KB}/.`, `${KB}/./README.md`]) {
        const res = await revoke({
          path: p,
          kind: p.endsWith('.md') ? 'file' : 'folder',
          principal: { kind: 'role', role: 'Admin' },
          verb: 'write',
        });
        expect(res.status).toBe(400);
      }
      const view = await fetch(`${baseUrl}/api/workspace/${WS}/access?path=./README.md&kind=file`);
      expect(view.status).toBe(400);
      expect(await fs.readFile(path.join(repo, 'access.md'), 'utf-8')).toContain('write:\n  - Admin');
    });

    it('the dialog view of an Admin-excluded subfolder does not show Admin editing or downloading', async () => {
      const res = await fetch(`${baseUrl}/api/workspace/${WS}/access?path=${KB}/HR&kind=folder`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as {
        canWrite: boolean;
        canDownload: boolean;
        eligible: { roles: string[] };
        downloaders: { roles: string[] };
      };
      expect(view.canWrite).toBe(false);
      expect(view.canDownload).toBe(false);
      expect(view.eligible.roles).toEqual(['Engineer']);
      expect(view.downloaders.roles).not.toContain('Admin');
    });

    it('the root dialog view can be re-read (empty folder path) and shows Admin editing', async () => {
      const res = await fetch(`${baseUrl}/api/workspace/${WS}/access?path=&kind=folder`);
      expect(res.status).toBe(200);
      const view = (await res.json()) as { canWrite: boolean; eligible: { roles: string[] } };
      expect(view.canWrite).toBe(true);
      expect(view.eligible.roles).toContain('Admin');
    });
  });
});
