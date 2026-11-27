import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, Branch, IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/index.js';
import type { AuthService } from '../../auth/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { VersionControlEventBus } from '../event-bus.js';
import { createVersionControlRoutes } from '../version-control.routes.js';

/**
 * The route a person's client creates a branch through asks the service what
 * the branch is to be called (`draftNameFor`, the rule the `create_branch`
 * tool asks too, tested in `version-control.service.draft-name.test.ts`),
 * creates it under that name, and answers the branch as created. The service
 * here answers a fixed name, so these cases hold whatever the rule is.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };

let server: Server | null = null;
afterEach(async () => {
  const open = server;
  server = null;
  if (open) await new Promise<void>((resolve, reject) => open.close((err) => (err ? reject(err) : resolve())));
});

const NAMED_BY_THE_SERVICE = 'named/by-the-service';

/** The routes over a service that answers one name for every draft, and records what it was asked and what it creates. */
async function serve(): Promise<{
  baseUrl: string;
  asked: Array<{ workspaceId: string; name: string; user: AuthUser }>;
  created: Array<{ workspaceId: string; name: string; fromBase?: string }>;
}> {
  const asked: Array<{ workspaceId: string; name: string; user: AuthUser }> = [];
  const created: Array<{ workspaceId: string; name: string; fromBase?: string }> = [];
  const versionControl: Pick<IVersionControlService, 'draftNameFor' | 'createBranch'> = {
    draftNameFor: async (workspaceId, name, user) => {
      asked.push({ workspaceId, name, user });
      return NAMED_BY_THE_SERVICE;
    },
    createBranch: async (workspaceId, name, fromBase) => {
      created.push({ workspaceId, name, fromBase });
      return { name } as Branch;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ALICE.id;
    next();
  });
  app.use(
    '/api',
    createVersionControlRoutes(
      versionControl as IVersionControlService,
      {} as unknown as WorkspaceService,
      { getUserById: async () => ALICE } as unknown as AuthService,
      new VersionControlEventBus(),
      {} as unknown as IAccessControl,
      'knowledge-base',
    ),
  );
  const listening = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  server = listening;
  return { baseUrl: `http://127.0.0.1:${(listening.address() as AddressInfo).port}`, asked, created };
}

async function createBranch(baseUrl: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/workspace/main/workflow/branches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('POST /workspace/:id/workflow/branches', () => {
  it.each([
    ['a list', ['main']],
    ['an object', { ref: 'main' }],
    ['a number', 7],
  ])('answers a base that is %s with a 400, and asks the service nothing', async (_what, fromBase) => {
    const { baseUrl, asked, created } = await serve();

    const res = await createBranch(baseUrl, { name: 'copilot-check', fromBase });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'fromBase must be a branch name' });
    expect(asked).toEqual([]);
    expect(created).toEqual([]);
  });

  it('reads a base that is absent or null as none', async () => {
    const { baseUrl, created } = await serve();

    expect((await createBranch(baseUrl, { name: 'one' })).status).toBe(200);
    expect((await createBranch(baseUrl, { name: 'two', fromBase: null })).status).toBe(200);
    expect(created.map((c) => c.fromBase)).toEqual([undefined, undefined]);
  });

  it('creates the branch under the name the service gives the asked name for this person, and answers it', async () => {
    const { baseUrl, asked, created } = await serve();

    const res = await createBranch(baseUrl, { name: 'copilot-check', fromBase: 'main' });

    expect(res.status).toBe(200);
    expect(asked).toEqual([{ workspaceId: 'main', name: 'copilot-check', user: ALICE }]);
    expect(created).toEqual([{ workspaceId: 'main', name: NAMED_BY_THE_SERVICE, fromBase: 'main' }]);
    expect(res.json.name).toBe(NAMED_BY_THE_SERVICE);
  });

  it.each([
    ['no name', {}],
    ['an empty name', { name: '' }],
    ['a name that is no string', { name: { toString: 'x' } }],
    ['a name that is a list', { name: ['a/b'] }],
  ])('answers %s with a 400, and asks the service nothing', async (_what, body) => {
    const { baseUrl, asked, created } = await serve();

    const res = await createBranch(baseUrl, body);

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'name is required' });
    expect(asked).toEqual([]);
    expect(created).toEqual([]);
  });
});
