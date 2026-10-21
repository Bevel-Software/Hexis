import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { createWorkflowRoutes } from '../workflow.routes.js';

/**
 * `POST /api/workflow/change-requests` answers the opened request as the
 * service hands it over, `notified` included: the channels the deployment's
 * change-request listeners said reached the approvers, so the dialog can say
 * "the reviewers were emailed" — or hand over the link when nobody was.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };

async function serve(workflow: Partial<IWorkflowService>): Promise<{ server: Server; baseUrl: string }> {
  const authService = { getUserById: vi.fn(async () => ALICE) } as unknown as AuthService;
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: encodeURIComponent(branch) })),
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ALICE.id;
    next();
  });
  app.use(
    '/api',
    createWorkflowRoutes(
      workflow as IWorkflowService,
      workspaceService,
      authService,
      new WorkflowEventBus(),
      {} as unknown as IAccessControl,
      'knowledge-base',
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('POST /workflow/change-requests answers who was notified', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    server = undefined;
  });

  it.each([
    ['the channels that reached the approvers', ['email']],
    ['nobody, truthfully', []],
  ])('carries `notified`: %s', async (_what, notified) => {
    const openChangeRequest = vi.fn(async () => ({ number: 12, branch: 'alice/deal', base: 'main', notified }) as never);
    let baseUrl: string;
    ({ server, baseUrl } = await serve({ openChangeRequest }));

    const res = await fetch(`${baseUrl}/api/workflow/change-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceBranch: 'alice/deal', targetBranch: 'main', title: 'Deal' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ number: 12, branch: 'alice/deal', base: 'main', notified });
    // The open runs in the SOURCE branch's workspace, by the caller.
    expect(openChangeRequest).toHaveBeenCalledTimes(1);
    expect(openChangeRequest).toHaveBeenCalledWith(
      encodeURIComponent('alice/deal'),
      ALICE,
      { sourceBranch: 'alice/deal', targetBranch: 'main', title: 'Deal', description: undefined },
    );
  });
});
