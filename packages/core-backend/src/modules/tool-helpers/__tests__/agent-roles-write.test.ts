import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { RoutineWritePolicyService } from '../../workspace/routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { DocExtractService } from '../../workspace/file-readers/doc-extract.service.js';
import { NEW_ROLE_GUIDANCE } from '../../access-model/roles-yaml-guard.js';
import { loadActiveGroups } from '../../access/access-control.service.js';

/**
 * The agent's file tools over the production context resolver and a real
 * workspace on disk: a roles.yaml write that creates a role is refused with a
 * 422 whose message the agent can relay verbatim, and nothing is written; a
 * write that only changes membership lands as before.
 */

const KB = 'knowledge-base';
const WS = 'target-company-state';
const ROLES = `${KB}/roles.yaml`;
const DRAFT = `${KB}/KnowledgeBase/draft-roles.yaml`;
const CURRENT = 'roles:\n  Admin:\n    - admin@x.io\n  Sales:\n    - felix@x.io\n';
const WITH_NEW_ROLE = `${CURRENT}  Project Phoenix:\n    - p@x.io\n`;

let root = '';
let docCache = '';
let httpServer: HttpServer | undefined;
const internalToken = new InternalTokenService({ secret: 's' });

async function start(): Promise<string> {
  const authService = { getUserById: async (id: string) => ({ id, email: 'admin@x.io', name: 'Admin' }) } as never;
  const workspaceService = {
    getOrCreateForUser: async () => ({ id: WS }),
    getWorkspacePath: async () => root,
  } as never;
  const workflowService = {
    acquireLock: async () => ({ acquired: true, lock: { holderUserId: 'user-A', holderName: 'Admin' } }),
    releaseLock: async () => null,
    releaseLockNoCommit: async () => undefined,
    commitChanges: async () => ({}),
  } as never;
  const resolve = createToolContextResolver({
    authService,
    workspaceService,
    workflowService,
    events: {} as never,
    kbDirName: KB,
    creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
    loadActiveGroups,
  });
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware({ verifyAndLoadToken: async () => null } as never, internalToken);
  const router = express.Router();
  const allowAll = {
    canRead: async () => true,
    canWrite: async () => true,
    canDownload: async () => true,
    canOwner: async () => true,
    canWriteBatchAtRef: async () => null,
    canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as never;
  registerWorkspaceTools(registry, router, toolAuth, createToolHandlerFactory(resolve), new SpillStore(path.join(os.tmpdir(), 'bevel-test-spills')), new DocExtractService(docCache), allowAll, KB, {
    service: {} as never,
    enabled: false, // ontology boundary not under test here
    kbDirName: KB,
    recoveryBotEmail: 'recovery-bot@bevel.local',
    hooks: new WorkflowHooks(),
  }, new RoutineWritePolicyService(), {} as never);
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const call = (base: string, tool: string, body: Record<string, unknown>) =>
  fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken.mint({ userId: 'user-A' })}` },
    body: JSON.stringify({ branch: 'main', ...body }),
  });

const rolesOnDisk = () => fs.readFile(path.join(root, ROLES), 'utf-8');

async function expectNewRoleRefused(res: Response, roleName: string): Promise<void> {
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as { error: string };
  expect(error).toContain(`'${roleName}'`);
  expect(error).toContain(NEW_ROLE_GUIDANCE);
  expect(await rolesOnDisk()).toBe(CURRENT);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-roles-'));
  docCache = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-roles-doc-'));
  await fs.mkdir(path.join(root, KB, 'KnowledgeBase'), { recursive: true });
  await fs.writeFile(path.join(root, ROLES), CURRENT);
  await fs.writeFile(path.join(root, DRAFT), WITH_NEW_ROLE);
});

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(docCache, { recursive: true, force: true });
});

describe('agent writes to roles.yaml never create a role', () => {
  it('write_file with a new role → 422 naming it, with the group redirect; nothing written', async () => {
    const base = await start();
    await expectNewRoleRefused(await call(base, 'write_file', { path: ROLES, content: WITH_NEW_ROLE, mode: 'overwrite' }), 'Project Phoenix');
  });

  it('edit_file renaming a role → 422 for the created name', async () => {
    const base = await start();
    const res = await call(base, 'edit_file', { path: ROLES, old_string: '  Sales:', new_string: '  Marketing:' });
    await expectNewRoleRefused(res, 'Marketing');
  });

  it('write_files carrying a new role → 422, and the batch lands nothing', async () => {
    const base = await start();
    const res = await call(base, 'write_files', {
      // roles.yaml exists, so the batch says it means to replace it — what the
      // guard refuses is the new role in the content, not the overwrite.
      mode: 'overwrite',
      files: [
        { path: `${KB}/KnowledgeBase/note.md`, content: 'hello' },
        { path: ROLES, content: WITH_NEW_ROLE },
      ],
    });
    await expectNewRoleRefused(res, 'Project Phoenix');
    await expect(fs.access(path.join(root, KB, 'KnowledgeBase/note.md'))).rejects.toBeDefined();
  });

  it('copy_file onto roles.yaml is checked with the bytes it would land', async () => {
    const base = await start();
    await expectNewRoleRefused(await call(base, 'copy_file', { src: DRAFT, dest: ROLES }), 'Project Phoenix');
    expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_NEW_ROLE);
  });

  it('move_file onto the existing roles.yaml is refused before any byte moves: a move never overwrites', async () => {
    const base = await start();
    const res = await call(base, 'move_file', { src: DRAFT, dest: ROLES });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('already exists');
    expect(await rolesOnDisk()).toBe(CURRENT);
    expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_NEW_ROLE);
  });

  it('a members-only edit_file succeeds exactly as before', async () => {
    const base = await start();
    const res = await call(base, 'edit_file', {
      path: ROLES,
      old_string: '    - felix@x.io\n',
      new_string: '    - felix@x.io\n    - dana@x.io\n',
    });
    expect(res.status).toBe(200);
    expect(await rolesOnDisk()).toBe(`${CURRENT}    - dana@x.io\n`);
  });
});

describe('agent writes to roles.yaml check `- group:<Name>` entries against the active group source', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(root, KB, 'groups.yaml'), 'groups:\n  Platform Team:\n    - p@x.io\n');
  });

  it('an entry naming a known group lands, matched case- and whitespace-insensitively', async () => {
    const base = await start();
    const res = await call(base, 'edit_file', {
      path: ROLES,
      old_string: '    - felix@x.io\n',
      new_string: '    - felix@x.io\n    - group:platform  team\n',
    });
    expect(res.status).toBe(200);
    expect(await rolesOnDisk()).toBe(`${CURRENT}    - group:platform  team\n`);
  });

  it('an unknown group → 422 naming the entry and its role; nothing written', async () => {
    const base = await start();
    const res = await call(base, 'write_file', { path: ROLES, content: `${CURRENT}    - group:Platfrom Team\n` });
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("'- group:Platfrom Team' under role 'Sales'");
    expect(error).toContain('groups.yaml');
    expect(await rolesOnDisk()).toBe(CURRENT);
  });

  it('in IdP mode the synced file is the source, and groups.yaml no longer counts', async () => {
    await fs.writeFile(path.join(root, KB, 'synced-groups.yaml'), 'groups:\n  Directory Team:\n    - d@x.io\n');
    const base = await start();
    const refused = await call(base, 'write_file', { path: ROLES, content: `${CURRENT}    - group:Platform Team\n` });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toContain('synced-groups.yaml');
    expect(await rolesOnDisk()).toBe(CURRENT);
    const landed = await call(base, 'write_file', { path: ROLES, content: `${CURRENT}    - group:Directory Team\n` });
    expect(landed.status).toBe(200);
    expect(await rolesOnDisk()).toBe(`${CURRENT}    - group:Directory Team\n`);
  });
});
