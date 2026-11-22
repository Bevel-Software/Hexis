import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeRequestDetail, ChangedFile, FileApproval } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { hashEmail } from '../../../../shared/email-identity.js';
import { VersionControlDomainError } from '../../../../shared/domain-errors.js';
import { ToolRegistry } from '../../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../../tool-helpers/tool-handler.js';
import { registerChangeRequestApplyTools } from '../change-request-apply.tools.js';
import { APPLY_FAILURE_REASON_WITHHELD } from '../change-request-read-shape.js';

/**
 * "A bot may approve and merge change requests where it is granted"
 * (Bots-Are-Identities, Requirement 10), through `approve_change_request` and
 * `apply_change_request` — offered ONLY to a connection made as a bot. A
 * connection made as Myself is refused both by name, before anything is read:
 * an agent acting as a person proposes, and the person applies in the app.
 * The tools run on the real credential verifier, tool handler and context
 * resolver; the bots mechanism and the version-control service are stubs.
 */

const DANA = { id: 'u-dana', email: 'dana@acme.com', name: 'Dana' };
const OPS = { id: 'u-ops', email: 'ops@agent.hexis', name: 'ops' };
const AUTHOR = 'juan@acme.com';

function file(path: string): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 0, isBinary: false, sha: `b-${path}`, rawUrl: '' };
}

function approval(path: string, over: Partial<FileApproval> = {}): FileApproval {
  return {
    path,
    eligibleApprovers: { roles: [], users: [{ name: 'ops', email: OPS.email }] },
    approvedBy: [],
    eligibilityResolved: true,
    isApproved: false,
    inMergeGate: true,
    viewerCanApprove: true,
    ...over,
  };
}

function detail(over: Partial<ChangeRequestDetail> = {}): ChangeRequestDetail {
  const files = over.files ?? [file('Docs/a.md'), file('Docs/b.md')];
  return {
    number: 7,
    title: 'Update the docs',
    authorId: hashEmail(AUTHOR),
    author: { login: 'user-juan', name: 'Juan' },
    appAuthor: { name: 'Juan' },
    branch: 'juan/docs',
    base: 'main',
    state: 'open',
    createdAt: '2026-11-22T10:00:00.000Z',
    updatedAt: '2026-11-22T10:00:00.000Z',
    touchedNodePaths: files.map((f) => f.path),
    touchedNodeFiles: files.map((f) => ({ path: f.path })),
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://hexis.example.com/change-requests/7',
    body: '',
    headSha: 'head-1',
    baseSha: 'base-1',
    files,
    approvals: files.map((f) => approval(f.path)),
    mergeableInBevel: false,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: false,
    mergeBaseSha: 'fork-1',
    behind: false,
    needsUpdate: false,
    viewerCanUpdate: false,
    viewerIsAuthor: false,
    viewerCanDelete: false,
    ...over,
  };
}

// ── The world ───────────────────────────────────────────────────────────────

let current: ChangeRequestDetail | null = null;
let readable: string[] = [];
const approveFile = vi.fn();
const mergeChangeRequest = vi.fn();
const recordApplyFailure = vi.fn();
const beginApplyAttempt = vi.fn(() => 1);
const endApplyAttempt = vi.fn();
const getChangeRequestDetail = vi.fn(async (number: number) => (current && current.number === number ? current : null));

const versionControlService = {
  getChangeRequestDetail,
  approveFile,
  mergeChangeRequest,
  recordApplyFailure,
  beginApplyAttempt,
  endApplyAttempt,
} as never;

const accessControl = {
  canReadBatchAtRef: async (_ws: string, _ref: string, _email: string, paths: string[]) =>
    new Map(paths.map((p) => [p, readable.includes(p)])),
};

const users = new Map([DANA, OPS].map((u) => [u.id, u]));
const authService = { getUserById: async (id: string) => users.get(id) ?? null } as never;
const workspaceService = {
  findAnyWorkspaceId: async () => 'existing-ws',
  getOrCreateForUser: async () => ({ id: 'existing-ws' }),
  getWorkspacePath: async () => '/tmp/ws',
  getOrCreateForBranch: async (b: string) => ({ id: b }),
} as never;

/** `bevel_myself` is Dana's key made as Myself; `bevel_bot` is Dana's key made as the bot ops. */
const keys = {
  looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_myself'
      ? { tokenId: 'k1', user: DANA, botUserId: null, agentPath: null }
      : t === 'bevel_bot'
        ? { tokenId: 'k2', user: DANA, botUserId: OPS.id, agentPath: null }
        : null,
} as never;
const bots = {
  resolveConnection: async () => ({
    kind: 'bot' as const,
    actor: { id: OPS.id, email: OPS.email },
    madeBy: { id: DANA.id, email: DANA.email },
    bot: { id: 'ops', name: 'ops' },
    platformTools: null,
  }),
};

let httpServer: HttpServer | undefined;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware(keys, new InternalTokenService({ secret: 's' }), undefined, undefined, {
    bots,
    userOf: async (id: string) => users.get(id) ?? null,
  } as never);
  const resolve = createToolContextResolver({
    authService,
    workspaceService,
    versionControlService,
    events: { emit: () => ({}) },
    kbDirName: 'knowledge-base',
    creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} },
  } as never);
  const router = express.Router();
  registerChangeRequestApplyTools(registry, router, toolAuth, createToolHandlerFactory(resolve), accessControl, testKbContext());
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

async function call(base: string, tool: string, body: unknown, key = 'bevel_bot') {
  const res = await fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  current = detail();
  readable = ['Docs/a.md', 'Docs/b.md'];
  for (const m of [approveFile, mergeChangeRequest, recordApplyFailure, endApplyAttempt, getChangeRequestDetail]) m.mockClear();
  approveFile.mockReset().mockResolvedValue([]);
  mergeChangeRequest.mockReset().mockResolvedValue({ kind: 'merged', result: {} });
  recordApplyFailure.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

// ── Myself ──────────────────────────────────────────────────────────────────

describe('a connection made as Myself', () => {
  it.each(['approve_change_request', 'apply_change_request'])(
    'is refused %s by name, and nothing is read or written',
    async (tool) => {
      const base = await start();
      const res = await call(base, tool, { number: 7 }, 'bevel_myself');
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(new RegExp(`"${tool}" is offered only to a connection made as a bot`));
      expect(res.json.error).toMatch(/applied by a person in the app/);
      expect(getChangeRequestDetail).not.toHaveBeenCalled();
      expect(approveFile).not.toHaveBeenCalled();
      expect(mergeChangeRequest).not.toHaveBeenCalled();
    },
  );
});

// ── approve_change_request ──────────────────────────────────────────────────

describe('approve_change_request, as a bot', () => {
  it('approves every file it is shown and may approve, as the bot with the person behind it, at the fresh head', async () => {
    current = detail({ approvals: [approval('Docs/a.md'), approval('Docs/b.md', { viewerCanApprove: false })] });
    const base = await start();
    const res = await call(base, 'approve_change_request', { number: 7 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ number: 7, approved: ['Docs/a.md'], mergeBlockedReasons: [], mayApply: true });
    expect(approveFile).toHaveBeenCalledTimes(1);
    const [number, path, user, files, headSha, baseBranch] = approveFile.mock.calls[0]!;
    expect([number, path, headSha, baseBranch]).toEqual([7, 'Docs/a.md', 'head-1', 'main']);
    expect(files).toHaveLength(2);
    expect(user).toMatchObject({ id: OPS.id, email: OPS.email, madeBy: { email: DANA.email } });
    expect(getChangeRequestDetail.mock.calls[0]![1]).toMatchObject({ fresh: true, viewerEmail: OPS.email });
  });

  it('accepts a path spelled with the checkout folder, or with a leading slash, as the file the request lists', async () => {
    const base = await start();
    const res = await call(base, 'approve_change_request', { number: 7, paths: ['knowledge-base/Docs/a.md', '/knowledge-base/Docs/b.md'] });
    expect(res.status).toBe(200);
    expect(res.json.approved).toEqual(['Docs/a.md', 'Docs/b.md']);
  });

  it('refuses the whole call, approving nothing, when one named file may not be approved by it', async () => {
    current = detail({ approvals: [approval('Docs/a.md'), approval('Docs/b.md', { viewerCanApprove: false })] });
    const base = await start();
    const res = await call(base, 'approve_change_request', { number: 7, paths: ['Docs/a.md', 'Docs/b.md'] });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/You may not approve "Docs\/b\.md".*nothing was approved/);
    expect(approveFile).not.toHaveBeenCalled();
  });

  it('refuses a file the request does not change, and one it may not read, alike, approving nothing', async () => {
    readable = ['Docs/a.md'];
    const base = await start();
    for (const path of ['Docs/zzz.md', 'Docs/b.md']) {
      const res = await call(base, 'approve_change_request', { number: 7, paths: ['Docs/a.md', path] });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe(`Change request #7 does not change "${path}"; nothing was approved.`);
    }
    expect(approveFile).not.toHaveBeenCalled();
  });

  it('says it may approve nothing when no file it is shown is one it may approve', async () => {
    current = detail({ approvals: [approval('Docs/a.md', { viewerCanApprove: false }), approval('Docs/b.md', { viewerCanApprove: false })] });
    const base = await start();
    const res = await call(base, 'approve_change_request', { number: 7 });
    expect(res.status).toBe(403);
    expect(approveFile).not.toHaveBeenCalled();
  });

  it('answers a request it may not see exactly as one that does not exist, and a closed one as not open', async () => {
    const base = await start();
    readable = [];
    const hidden = await call(base, 'approve_change_request', { number: 7 });
    const kept = current;
    current = null;
    const missing = await call(base, 'approve_change_request', { number: 7 });
    current = kept;
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual({ status: 404, json: { error: 'Change request #7 not found.' } });
    readable = ['Docs/a.md', 'Docs/b.md'];
    current = detail({ state: 'merged' });
    const closed = await call(base, 'approve_change_request', { number: 7 });
    expect(closed.status).toBe(409);
    expect(approveFile).not.toHaveBeenCalled();
  });

  it('says which approvals landed when a later one is refused', async () => {
    approveFile.mockResolvedValueOnce([]).mockRejectedValueOnce(new VersionControlDomainError('not eligible any more', 403));
    const base = await start();
    const res = await call(base, 'approve_change_request', { number: 7 });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('Approved "Docs/a.md"; approving "Docs/b.md" was refused: not eligible any more');
  });

  it('refuses a malformed number or paths before reading anything', async () => {
    const base = await start();
    expect((await call(base, 'approve_change_request', { number: 0 })).status).toBe(400);
    expect((await call(base, 'approve_change_request', { number: 7, paths: [] })).status).toBe(400);
    expect((await call(base, 'approve_change_request', { number: 7, paths: ['../x.md'] })).status).toBe(400);
    expect(getChangeRequestDetail).not.toHaveBeenCalled();
  });
});

// ── apply_change_request ────────────────────────────────────────────────────

describe('apply_change_request, as a bot', () => {
  it('applies through the service as the bot, with the person behind it, on the fresh head and approvals', async () => {
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ number: 7, outcome: { kind: 'merged' } });
    const [number, user, headSha, approvals, state, title, baseBranch, , opts] = mergeChangeRequest.mock.calls[0]!;
    expect([number, headSha, state, title, baseBranch]).toEqual([7, 'head-1', 'open', 'Update the docs', 'main']);
    expect(approvals).toHaveLength(2);
    expect(user).toMatchObject({ id: OPS.id, email: OPS.email, madeBy: { email: DANA.email } });
    // A bot is never an admin: nothing here asks to bypass the gate.
    expect(opts).toBeUndefined();
    expect(endApplyAttempt).toHaveBeenCalledWith(7, 1);
  });

  it('passes the gate\'s refusal back, and records it on the request for its author', async () => {
    mergeChangeRequest.mockRejectedValue(
      new VersionControlDomainError('Merge gate rejected: Waiting on approval for Docs/b.md', 422, { mergeBlockedReasons: ['x'] }),
    );
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('Merge gate rejected: Waiting on approval for Docs/b.md');
    expect(recordApplyFailure).toHaveBeenCalledWith(7, { reason: 'Merge gate rejected: Waiting on approval for Docs/b.md', kind: 'gate' }, expect.objectContaining({ id: OPS.id }), 1);
    expect(endApplyAttempt).toHaveBeenCalledWith(7, 1);
  });

  it('refuses a request that changes access, as the service decides, and records nothing for a refusal of the caller', async () => {
    mergeChangeRequest.mockRejectedValue(new VersionControlDomainError('A bot never changes access: Docs/access.md', 403));
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/never changes access/);
    expect(recordApplyFailure).not.toHaveBeenCalled();
  });

  it('withholds a refusal\'s reason when the request holds a file it may not read', async () => {
    readable = ['Docs/a.md'];
    mergeChangeRequest.mockRejectedValue(new VersionControlDomainError('Merge gate rejected: Waiting on approval for Docs/b.md', 422, { mergeBlockedReasons: ['x'] }));
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe(APPLY_FAILURE_REASON_WITHHELD);
  });

  it('answers the reason when recording it for others fails, never that failure instead', async () => {
    mergeChangeRequest.mockRejectedValue(new VersionControlDomainError('Merge gate rejected: x', 422, { mergeBlockedReasons: ['x'] }));
    recordApplyFailure.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('Merge gate rejected: x');
  });

  it('names only the conflicting files it may read', async () => {
    readable = ['Docs/a.md'];
    mergeChangeRequest.mockResolvedValue({ kind: 'conflicts-need-resolution', conflictedPaths: ['Docs/a.md', 'Docs/b.md'] });
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.json).toEqual({ number: 7, outcome: { kind: 'conflicts-need-resolution', conflictedPaths: ['Docs/a.md'] } });
    expect(recordApplyFailure).toHaveBeenCalledWith(7, expect.objectContaining({ kind: 'conflicts' }), expect.anything(), 1);
  });

  it('refuses a request that is not open without trying to apply it', async () => {
    current = detail({ state: 'closed' });
    const base = await start();
    const res = await call(base, 'apply_change_request', { number: 7 });
    expect(res.status).toBe(409);
    expect(mergeChangeRequest).not.toHaveBeenCalled();
  });
});
