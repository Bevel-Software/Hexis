import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { Database } from '../../database/connection.js';
import { prMergeLog } from '../../database/schema.js';
import type { GitService } from '../git/git.service.js';
import { PullRequestService } from '../git/pull-request.service.js';
import type { WorkflowEventBus } from '../event-bus.js';
import { createWorkflowRoutes } from '../workflow.routes.js';

/**
 * A patch is a file's content. The detail route serves the file LIST to any
 * signed-in viewer (the dialog shows an unreadable file locked, by name), but
 * the patch of a file the viewer may not read never leaves the server — not
 * hidden by the dialog, absent from the JSON. Driven through the real
 * `getPrDetail`, including the applied-with-no-commit-of-its-own path, whose
 * file list (and patches) comes from the proposal head its apply recorded.
 */

const PAT = { id: 'u-pat', email: 'pat@example.com', name: 'Pat' };
const PROPOSAL_HEAD = '9'.repeat(40);
const SECRET = 'SECRET-PRICE-42';
const MOVED_SECRET = 'MOVED-FROM-RESTRICTED';
const PUBLIC = 'PUBLIC-LINE';

const FILES = [
  { path: 'Knowledge/Public.md', patch: `@@ -1 +1 @@\n+${PUBLIC}` },
  { path: 'Restricted/Secret.md', patch: `@@ -1 +1 @@\n+${SECRET}` },
  { path: 'Knowledge/Moved.md', previousPath: 'Restricted/Old.md', patch: `@@ -1 +1 @@\n+${MOVED_SECRET}` },
].map((f) => ({
  status: f.previousPath ? ('renamed' as const) : ('modified' as const),
  additions: 1,
  deletions: 1,
  isBinary: false,
  sha: '',
  rawUrl: '',
  ...f,
}));

async function makeHarness(opts: { state?: 'open' | 'merged'; signedIn?: boolean; verdicts?: 'null' | 'throws' } = {}) {
  const row = {
    number: 4,
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    title: 'A proposal',
    body: 'why',
    authorEmail: 'juan@example.com',
    authorName: 'Juan',
    state: opts.state ?? 'merged',
    // No merge commit of its own: the target already held everything.
    mergedSha: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: null,
    closedAt: opts.state === 'open' ? null : new Date('2026-10-10T09:30:00Z'),
    applyFailureReason: null,
    applyFailureConflicts: null,
    applyFailedAt: null,
    applyFailedByName: null,
    applyFailureKind: null,
    closedReason: null,
  };
  const db = {
    select: () => ({
      from: (table: unknown) =>
        table === prMergeLog
          ? {
              where: async () => [
                {
                  name: 'Robin Lee',
                  headSha: PROPOSAL_HEAD,
                  succeeded: true,
                  hasError: false,
                  startedAt: new Date('2026-10-10T09:29:00Z'),
                },
              ],
            }
          : { where: () => ({ limit: async () => [row] }) },
    }),
  } as unknown as Database;
  const git = {
    changedFilesOfProposalHead: vi.fn(async () => FILES),
    resolvePrShas: async () => ({ baseSha: '1'.repeat(40), headSha: '2'.repeat(40) }),
    changedFilesForPr: async () => FILES,
    forkPointForPr: async () => ({ mergeBaseSha: '1'.repeat(40), behind: false }),
    pathsChangedBetween: async () => [],
  } as unknown as GitService;
  const workspaceService = {
    ensureRemotesFetched: async () => undefined,
    findAnyWorkspaceId: async () => 'ws-any',
    getOrCreateForUser: async () => ({ id: 'ws-pat' }),
  } as unknown as WorkspaceService;
  // Pat reads Knowledge/ and nothing under Restricted/.
  const canReadBatchAtRef = vi.fn(async (_w: string, _ref: string, _e: string, paths: string[]) => {
    if (opts.verdicts === 'null') return null;
    if (opts.verdicts === 'throws') throw new Error('access tree unreadable');
    return new Map(paths.map((p) => [p, !p.startsWith('Restricted/')]));
  });
  const access = { canWriteAtRef: async () => false, canReadBatchAtRef } as unknown as IAccessControl;
  const prs = new PullRequestService(db, workspaceService, access, git);
  const workflow = {
    getChangeRequestDetail: (n: number, o: Parameters<PullRequestService['getPrDetail']>[1]) => prs.getPrDetail(n, o),
  };
  const app = express();
  app.use(express.json());
  if (opts.signedIn !== false) {
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = PAT.id;
      next();
    });
  }
  app.use(
    '/api',
    createWorkflowRoutes(
      workflow as unknown as IWorkflowService,
      workspaceService,
      { getUserById: vi.fn(async () => PAT) } as unknown as AuthService,
      { subscribe: vi.fn(), publish: vi.fn() } as unknown as WorkflowEventBus,
      access,
      'knowledge-base',
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, git, canReadBatchAtRef, baseUrl: `http://127.0.0.1:${port}` };
}

describe('GET /workflow/change-requests/:number/detail — patches only where the viewer may read', () => {
  let h: Awaited<ReturnType<typeof makeHarness>> | null = null;
  afterEach(async () => {
    if (h) await new Promise<void>((r) => h!.server.close(() => r()));
    h = null;
  });
  const detail = async () => {
    const res = await fetch(`${h!.baseUrl}/api/workflow/change-requests/4/detail`);
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, json: JSON.parse(text) as { files: { path: string; patch?: string }[]; finished: unknown } };
  };

  it('a partial reader of a no-own-commit apply gets every file named, and only the readable patch', async () => {
    h = await makeHarness();
    const { text, json } = await detail();
    // The real no-commit path ran: the files came from the recorded proposal head.
    expect(h.git.changedFilesOfProposalHead).toHaveBeenCalledWith('ws-pat', 'main', PROPOSAL_HEAD, {
      sourceBranch: 'feature/x',
    });
    expect(json.finished).toMatchObject({ appliedSha: null });
    expect(json.files.map((f) => f.path)).toEqual(['Knowledge/Public.md', 'Restricted/Secret.md', 'Knowledge/Moved.md']);
    expect(json.files[0].patch).toContain(PUBLIC);
    expect(json.files[1]).not.toHaveProperty('patch');
    // A move out of a closed folder stays closed: its old side is judged too.
    expect(json.files[2]).not.toHaveProperty('patch');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(MOVED_SECRET);
    expect(h.canReadBatchAtRef).toHaveBeenCalledWith('ws-pat', 'origin/main', PAT.email, [
      'Knowledge/Public.md',
      'Restricted/Secret.md',
      'Knowledge/Moved.md',
      'Restricted/Old.md',
    ]);
  });

  it('an open request is gated the same way', async () => {
    h = await makeHarness({ state: 'open' });
    const { text, json } = await detail();
    expect(json.files).toHaveLength(3);
    expect(text).toContain(PUBLIC);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(MOVED_SECRET);
  });

  it('an unresolvable access tree, a failed lookup or an anonymous caller gets no patch at all', async () => {
    for (const o of [{ verdicts: 'null' as const }, { verdicts: 'throws' as const }, { signedIn: false }]) {
      h = await makeHarness(o);
      const { text, json } = await detail();
      expect(json.files).toHaveLength(3);
      expect(json.files.every((f) => f.patch === undefined)).toBe(true);
      expect(text).not.toContain(PUBLIC);
      expect(text).not.toContain(SECRET);
      await new Promise<void>((r) => h!.server.close(() => r()));
      h = null;
    }
  });
});
