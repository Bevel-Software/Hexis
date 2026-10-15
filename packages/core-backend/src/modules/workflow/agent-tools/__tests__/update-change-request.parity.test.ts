import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../../tool-helpers/tool-handler.js';
import { WorkflowDomainError } from '../../../../shared/domain-errors.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import type { AuthService } from '../../../auth/auth.service.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { WorkflowEventBus } from '../../event-bus.js';
import { createWorkflowRoutes } from '../../workflow.routes.js';
import { registerWorkflowTools } from '../workflow.tools.js';

/**
 * The app's `PATCH /api/workflow/change-requests/:number` and the agent's
 * `update_change_request` are one verb: both reach the SAME service method
 * with the same caller and the same fields, and every refusal it makes reaches
 * both callers with the same status and the same words. The rule itself is
 * pinned in `workflow.service.update-change-request.test.ts`; this pins that
 * neither surface narrows, widens or rewords it.
 */

const CALLER = { id: 'user-A', email: 'alice@example.com', name: 'Alice' };

let calls: unknown[][] = [];
/** What the shared service does next: answer the request, or refuse. */
let outcome: () => unknown;

const updated = {
  number: 9,
  url: 'https://bevel.example.com/change-requests/9',
  title: 'New title',
  state: 'open',
  touchedNodePaths: ['Docs/a.md'],
};

const workflowService = {
  updateChangeRequest: async (number: number, user: { id: string; email: string }, input: unknown) => {
    calls.push(['updateChangeRequest', number, user.id, input]);
    return outcome();
  },
} as unknown as IWorkflowService;

const authService = { getUserById: async () => CALLER } as unknown as AuthService;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: 'ws' }),
  findAnyWorkspaceId: async () => 'ws',
} as unknown as WorkspaceService;
const events = { emit: () => ({}) } as unknown as WorkflowEventBus;
const internalToken = new InternalTokenService({ secret: 's' });

let httpServer: HttpServer | undefined;
/** The agent tools `start` registered, as the manual lists them. */
let registry: ToolRegistry;

async function start(): Promise<string> {
  const app = express();
  app.use(express.json());

  // The app's route, signed in as CALLER.
  const appRouter = express.Router();
  appRouter.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = CALLER.id;
    next();
  });
  appRouter.use(
    createWorkflowRoutes(
      workflowService,
      workspaceService,
      authService,
      events,
      { canReadBatch: async () => new Map() } as unknown as IAccessControl,
      'knowledge-base',
    ),
  );

  // The agent's tool, as CALLER over an internal token.
  registry = new ToolRegistry();
  const toolRouter = express.Router();
  const toolAuth = createToolAuthMiddleware(
    { looksLikeExternalApiKey: () => false, verifyAndLoadToken: async () => null } as never,
    internalToken,
  );
  const resolve = createToolContextResolver({
    authService,
    workspaceService,
    workflowService,
    events,
    kbDirName: 'knowledge-base',
    creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
  } as never);
  registerWorkflowTools(registry, toolRouter, toolAuth, createToolHandlerFactory(resolve), testKbContext(), async () => true);

  app.use('/api', toolRouter);
  app.use('/api', appRouter);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

async function viaRoute(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/workflow/change-requests/9`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function viaTool(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/api/agent/tools/update_change_request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken.mint({ userId: CALLER.id })}` },
    body: JSON.stringify({ number: 9, ...body }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  calls = [];
  outcome = () => updated;
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

describe('update_change_request ⇔ PATCH /workflow/change-requests/:number', () => {
  it('both hand the same service call the same caller and the same fields', async () => {
    const base = await start();
    const fields = { title: 'New title', description: 'P2 - Planned\n\nWhy.' };
    expect((await viaRoute(base, fields)).status).toBe(200);
    expect((await viaTool(base, fields)).status).toBe(200);
    expect(calls).toEqual([
      ['updateChangeRequest', 9, CALLER.id, fields],
      ['updateChangeRequest', 9, CALLER.id, fields],
    ]);
  });

  it('a description alone reaches the service as a description alone, from both', async () => {
    const base = await start();
    await viaRoute(base, { description: 'Only this.' });
    await viaTool(base, { description: 'Only this.' });
    expect(calls).toEqual([
      ['updateChangeRequest', 9, CALLER.id, { title: undefined, description: 'Only this.' }],
      ['updateChangeRequest', 9, CALLER.id, { title: undefined, description: 'Only this.' }],
    ]);
  });

  const refusals: [string, () => never][] = [
    [
      'neither the author nor someone who may merge it (403)',
      () => {
        throw new WorkflowDomainError(
          "Only the request's author, an admin, or someone who may approve every file it changes can edit its title and description.",
          403,
        );
      },
    ],
    [
      'a merged request (409)',
      () => {
        throw new WorkflowDomainError(
          'This change request has already been applied; its title and description can no longer be changed.',
          409,
        );
      },
    ],
    [
      'a closed request (409)',
      () => {
        throw new WorkflowDomainError(
          'This change request is closed; its title and description can no longer be changed.',
          409,
        );
      },
    ],
  ];

  for (const [name, refuse] of refusals) {
    it(`refuses ${name} with the same status and the same words`, async () => {
      const base = await start();
      outcome = refuse;
      const route = await viaRoute(base, { title: 'New title' });
      const tool = await viaTool(base, { title: 'New title' });
      expect(route.status).toBeGreaterThanOrEqual(400);
      expect(tool).toEqual(route);
      expect(typeof route.body.error).toBe('string');
      expect((route.body.error as string).length).toBeGreaterThan(20);
    });
  }

  it('the tool answers the request’s link and its title; the route the request', async () => {
    const base = await start();
    const tool = await viaTool(base, { title: 'New title' });
    expect(tool.body).toEqual({
      number: 9,
      url: 'https://bevel.example.com/change-requests/9',
      title: 'New title',
    });
    const route = await viaRoute(base, { title: 'New title' });
    expect(route.body).toMatchObject({ number: 9, title: 'New title' });
  });

  it('asks for something to change before reaching the service', async () => {
    const base = await start();
    const tool = await viaTool(base, {});
    expect(tool.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('the route refuses a non-string field before reaching the service', async () => {
    const base = await start();
    const route = await viaRoute(base, { title: 7 });
    expect(route.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * The comment system is gone: no screen ever showed a comment, so the routes,
 * the service methods, the storage and the two agent tools were removed
 * rather than surfaced. Its old addresses answer 404 and its tools are not
 * offered; the request itself still answers on its own address.
 */
describe('change-request comments are gone', () => {
  const routes: [string, string][] = [
    ['GET', '/api/workflow/change-requests/9/comments'],
    ['POST', '/api/workflow/change-requests/9/comments'],
    ['PATCH', '/api/workflow/change-requests/9/comments/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/api/workflow/change-requests/9/comments/00000000-0000-4000-8000-000000000000'],
  ];
  for (const [method, path] of routes) {
    it(`${method} ${path.replace('/api', '')} answers 404`, async () => {
      const base = await start();
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({ body: 'hi' }) }),
      });
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
    });
  }

  it('the agent is offered no comment tool, and calling one answers 404', async () => {
    const base = await start();
    for (const name of ['post_change_request_comment']) {
      const res = await fetch(`${base}/api/agent/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken.mint({ userId: CALLER.id })}` },
        body: JSON.stringify({ number: 9, body: 'hi' }),
      });
      expect(res.status).toBe(404);
    }
    const names = (await registry.listInternal()).map((t) => t.name);
    expect(names).toContain('update_change_request');
    expect(names.filter((n) => n.includes('comment'))).toEqual([]);
  });
});
