import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import type { Database } from '../../database/connection.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { WorkflowEventBus } from '../event-bus.js';
import { WorkflowService } from '../workflow.service.js';
import { createWorkflowRoutes } from '../workflow.routes.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import {
  BranchDeleteRefusedError,
  PushNeedsAgentResolutionError,
} from '../../../shared/domain-errors.js';

/**
 * Every route whose operation pushes answers a push the repository host
 * refused the same way: 409, the saved-locally sentence naming the branch —
 * or, for a branch deletion, the host-refused sentence — and never
 * "Internal server error" or a line of git output.
 *
 * The services' own tests prove each operation THROWS the refusal; these
 * prove the routes answer it. The share route runs over the real service,
 * because it is the one that answered 500 for a raw push error before.
 */

const ALICE: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'alice@example.com', name: 'Alice' };
const BRANCH = 'alice/deal';
const WS = encodeURIComponent(BRANCH);
/** What GitHub answered during its incident — none of it may reach the body. */
const GIT_OUTPUT =
  'git push failed: remote: Internal Server Error\nTo https://x-access-token:ghp_abc@github.com/acme/kb.git\n ! [remote rejected] alice/deal -> alice/deal (Internal Server Error)';

function refused(path: string, branch = BRANCH): PushNeedsAgentResolutionError {
  return new PushNeedsAgentResolutionError(branch, path, GIT_OUTPUT, '(cooperative path not attempted)', 'refused');
}

/**
 * Each operation's refusal names its own branch, so a route that answered
 * with a fixed name — or another operation's — fails its case.
 */
const REVERT_BRANCH = 'alice/revert-src';
const OPEN_BRANCH = 'alice/open-src';
const UPDATE_BRANCH = 'alice/update-src';

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

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

async function call(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

function expectNoGitOutput(text: string): void {
  expect(text).not.toMatch(/Internal (server )?error|remote rejected|remote:|ghp_|github\.com/i);
}

describe('routes answer a push the host refused with 409 and the saved-locally sentence', () => {
  let server: Server;
  let baseUrl: string;

  const workflow: Partial<IWorkflowService> = {
    revertChangeRequestFile: vi.fn(async () => {
      throw refused('Sales/Deal.md', REVERT_BRANCH);
    }),
    openChangeRequest: vi.fn(async () => {
      throw refused('(opening a change request)', OPEN_BRANCH);
    }),
    getChangeRequest: vi.fn(async () => ({ number: 7, branch: BRANCH, base: 'main' }) as never),
    updateFromTarget: vi.fn(async () => {
      throw refused('(update from main)', UPDATE_BRANCH);
    }),
    deleteBranch: vi.fn(async () => {
      throw new BranchDeleteRefusedError(BRANCH, GIT_OUTPUT);
    }),
  };

  beforeEach(async () => {
    ({ server, baseUrl } = await serve(workflow));
  });
  afterEach(async () => {
    await close(server);
  });

  it.each([
    ['reverting a file of a change request', REVERT_BRANCH, 'POST', '/workflow/change-requests/7/files/revert', { path: 'Sales/Deal.md' }],
    ['opening a change request', OPEN_BRANCH, 'POST', '/workflow/change-requests', { sourceBranch: OPEN_BRANCH, targetBranch: 'main', title: 'Deal' }],
    ['updating a change request from its target', UPDATE_BRANCH, 'POST', '/workflow/change-requests/7/update-from-target', undefined],
  ])('%s', async (_what, branch, method, path, body) => {
    const res = await call(baseUrl, method, path, body);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(
      `Saved locally on "${branch}" but couldn't share with the team automatically — ` +
        'the repository host refused the push. The next save on this branch shares it.',
    );
    expect(res.json).toMatchObject({ kind: 'push-needs-resolution', branch });
    expect(res.json).not.toHaveProperty('originalDetail');
    expect(res.json).not.toHaveProperty('recoveryDetail');
    expectNoGitOutput(res.text);
  });

  it('deleting a branch: 409, the host refused, the branch is still there', async () => {
    const res = await call(baseUrl, 'DELETE', `/workspace/main/workflow/branches/${WS}`);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({
      kind: 'branch-delete-refused',
      branchName: BRANCH,
      error: `The repository host refused to delete "${BRANCH}"; it is still there. Try again later.`,
    });
    expectNoGitOutput(res.text);
  });
});

describe('the share route over the real service', () => {
  let server: Server;
  let baseUrl: string;
  let push: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Twice: `[remote rejected]` reads like a divergence, so the cooperative
    // pull-and-retry runs too — and is refused again.
    push = vi
      .fn()
      .mockRejectedValueOnce(new Error(GIT_OUTPUT))
      .mockRejectedValueOnce(new Error(GIT_OUTPUT))
      .mockResolvedValue(undefined);
    const git = {
      push,
      pull: vi.fn().mockResolvedValue({ treeChanged: false }),
    } as unknown as GitService;
    const workflow = new WorkflowService(
      {} as unknown as Database,
      git,
      {} as PullRequestService,
      {} as IReviewWorkflowService,
      {} as WorkspaceService,
      {} as IAccessControl,
      {} as FileLockService,
      {} as PendingCommitsService,
      testKbContext(),
      openChangeGate(),
    );
    ({ server, baseUrl } = await serve(workflow as unknown as IWorkflowService));
  });
  afterEach(async () => {
    await close(server);
  });

  it('answers 409 with the sentence instead of 500, then shares once the host accepts', async () => {
    const first = await call(baseUrl, 'POST', `/workspace/${WS}/workflow/share`);
    expect(first.status).toBe(409);
    expect(first.json.error).toContain(`Saved locally on "${BRANCH}"`);
    expectNoGitOutput(first.text);

    const second = await call(baseUrl, 'POST', `/workspace/${WS}/workflow/share`);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ status: 'shared' });
  });
});
