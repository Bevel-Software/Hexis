import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowDomainError } from '../../../shared/domain-errors.js';
import { createWorkflowRoutes } from '../workflow.routes.js';

/**
 * The two routes a folder delete calls. What they must get right on their
 * own: `under-folder` is not a change-request number (the `/:number` route
 * registered after it would answer 400 "invalid change request number"), a
 * folder that could step outside the knowledge base is refused before the
 * service sees it, and a refusal keeps its status.
 */

const ALICE: AuthUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };

describe('folder change-request routes', () => {
  let server: Server;
  let baseUrl: string;
  const workflow = {
    changeRequestsUnderFolder: vi.fn(),
    removeFolderFromChangeRequests: vi.fn(),
  };

  beforeEach(async () => {
    workflow.changeRequestsUnderFolder.mockReset();
    workflow.removeFolderFromChangeRequests.mockReset();
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = ALICE.id;
      next();
    });
    app.use(
      '/api',
      createWorkflowRoutes(
        workflow as unknown as IWorkflowService,
        {} as WorkspaceService,
        { getUserById: vi.fn(async () => ALICE) } as unknown as AuthService,
        new WorkflowEventBus(),
        {} as IAccessControl,
        'knowledge-base',
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

  it('lists the requests under a folder for the caller', async () => {
    workflow.changeRequestsUnderFolder.mockResolvedValue([{ number: 12, mayRemove: true }]);
    const res = await fetch(`${baseUrl}/api/workflow/change-requests/under-folder?path=Data%2FReports%2F`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [{ number: 12, mayRemove: true }] });
    expect(workflow.changeRequestsUnderFolder).toHaveBeenCalledWith('Data/Reports', ALICE);
  });

  it('removes the folder from the requests', async () => {
    workflow.removeFolderFromChangeRequests.mockResolvedValue([
      { number: 12, removedPaths: ['Data/Reports/a.md'], withdrawn: true },
    ]);
    const res = await fetch(`${baseUrl}/api/workflow/change-requests/under-folder/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Data/Reports' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).results[0]).toMatchObject({ number: 12, withdrawn: true });
    expect(workflow.removeFolderFromChangeRequests).toHaveBeenCalledWith('Data/Reports', ALICE);
  });

  const MALFORMED = [
    '',
    '../Data',
    'Data/../roles.yaml',
    '/Data',
    'Data//Reports',
    'Data\\Reports',
    'Data/Rep\u0000orts',
    'Data/Rep\norts',
    '-Data',
    `Data/${'x'.repeat(1030)}`,
  ];

  it.each(MALFORMED)('refuses the folder %j before the service sees it', async (folder) => {
    const res = await fetch(
      `${baseUrl}/api/workflow/change-requests/under-folder?path=${encodeURIComponent(folder)}`,
    );
    expect(res.status).toBe(400);
    expect(workflow.changeRequestsUnderFolder).not.toHaveBeenCalled();
  });

  it.each(MALFORMED)('refuses to remove the folder %j before the service sees it', async (folder) => {
    const res = await fetch(`${baseUrl}/api/workflow/change-requests/under-folder/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    expect(res.status).toBe(400);
    expect(workflow.removeFolderFromChangeRequests).not.toHaveBeenCalled();
  });

  it('keeps the service’s refusal status', async () => {
    workflow.removeFolderFromChangeRequests.mockRejectedValue(
      new WorkflowDomainError("You can't remove proposed changes from #40", 403),
    );
    const res = await fetch(`${baseUrl}/api/workflow/change-requests/under-folder/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Data/Reports' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('#40');
  });
});
