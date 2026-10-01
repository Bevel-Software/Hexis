import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChangeRequest,
  ChangeRequestComment,
  ChangeRequestDetail,
  ChangeRequestState,
  ChangedFile,
  FileApproval,
} from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { hashEmail } from '../../../../shared/email-identity.js';
import { ToolRegistry } from '../../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../../tool-helpers/tool-handler.js';
import { registerChangeRequestReadTools } from '../change-request-read.tools.js';

/** The signed-in caller of every test below, unless it says otherwise. */
const VIEWER = 'mia@bevel.software';
const AUTHOR = 'juan@bevel.software';

const TOOLS = [
  'list_change_requests',
  'get_change_request',
  'list_change_request_files',
  'list_change_request_reviews',
  'list_change_request_comments',
] as const;

// ── The world each test sets up ─────────────────────────────────────────────

/** Repo-relative paths THIS caller may read at `origin/<base>`. Null = the access tree does not resolve. */
let readable: string[] | null = [];
/** The summaries `listChangeRequestsByState` answers with, per state asked for. */
let summaries: ChangeRequest[] = [];
/** The details `getChangeRequestDetail` answers with, by number. */
let details = new Map<number, ChangeRequestDetail>();
/** Every service call the tools made, so a test can prove none of them wrote. */
let calls: unknown[][] = [];

function file(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: 'modified',
    additions: 2,
    deletions: 1,
    isBinary: false,
    sha: `blob-${path}`,
    rawUrl: '',
    patch: `@@ ${path} @@`,
    ...over,
  };
}

function approval(path: string, over: Partial<FileApproval> = {}): FileApproval {
  return {
    path,
    eligibleApprovers: { roles: ['Engineering'], users: [] },
    approvedBy: [],
    eligibilityResolved: true,
    isApproved: false,
    inMergeGate: true,
    viewerCanApprove: false,
    ...over,
  };
}

function approvedBy(email: string, name: string, at: string, isStale = false) {
  return { email, name, approvedAt: at, isStale, isSelfApproval: false };
}

function summary(over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    number: 12,
    title: 'Rework the onboarding note',
    authorId: hashEmail(AUTHOR),
    author: { login: `user-${hashEmail(AUTHOR).slice(0, 12)}`, name: 'Juan' },
    appAuthor: { name: 'Juan' },
    branch: 'juan/my-draft',
    base: 'main',
    state: 'open',
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    touchedNodePaths: ['Knowledge/A.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://hexis.example.com/change-requests/12',
    ...over,
  };
}

function detail(over: Partial<ChangeRequestDetail> = {}): ChangeRequestDetail {
  const files = over.files ?? [file('Knowledge/A.md')];
  return {
    ...summary(over),
    body: 'Why this change is needed.',
    headSha: 'head-1',
    baseSha: 'base-1',
    files,
    comments: [],
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

// ── Harness ─────────────────────────────────────────────────────────────────

const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async () => null,
} as never;

/** The caller the internal token resolves to — swapped by `asUser`. */
let callerEmail = VIEWER;
const authService = {
  getUserById: async (id: string) => ({ id, email: callerEmail, name: 'Caller' }),
} as never;

const workspaceService = {
  // The read tools resolve any existing clone: every verdict is read at
  // `origin/<base>`, so no draft has to be cloned to answer.
  findAnyWorkspaceId: async () => 'existing-ws',
  getOrCreateForUser: async () => ({ id: 'existing-ws' }),
  getWorkspacePath: async () => '/tmp/ws',
  getOrCreateForBranch: async (b: string) => ({ id: b }),
} as never;

const workflowService = {
  listChangeRequestsByState: async (states: ChangeRequestState[]) => {
    calls.push(['listChangeRequestsByState', [...states].sort()]);
    return summaries.filter((s) => states.includes(s.state));
  },
  getChangeRequestDetail: async (
    number: number,
    opts: { patches?: boolean; viewerEmail?: string },
  ) => {
    calls.push(['getChangeRequestDetail', number, opts.patches, opts.viewerEmail]);
    const found = details.get(number);
    if (!found) return null;
    // Mirror the service: `patches: false` means no patch is generated at all.
    if (opts.patches !== false) return found;
    return {
      ...found,
      files: found.files.map((f) => {
        const withoutPatch = { ...f };
        delete withoutPatch.patch;
        return withoutPatch;
      }),
    };
  },
} as never;

const accessControl = {
  canReadBatchAtRef: async (ws: string, ref: string, email: string, paths: string[]) => {
    calls.push(['canReadBatchAtRef', ws, ref, email]);
    if (readable === null) return null;
    return new Map(paths.map((p) => [p, readable!.includes(p)]));
  },
};

const events = { emit: () => ({}) } as never;
const internalToken = new InternalTokenService({ secret: 's' });

let httpServer: HttpServer | undefined;
let registryRef: ToolRegistry | undefined;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  registryRef = registry;
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({
    authService,
    workspaceService,
    workflowService,
    events,
    kbDirName: 'knowledge-base',
    creatorAccess: {
      planForCreate: async () => null,
      grantInExtractedFile: async () => null,
      noteAccessFileWritten: () => {},
    },
  } as never);
  const toolHandler = createToolHandlerFactory(resolve);

  const router = express.Router();
  registerChangeRequestReadTools(registry, router, toolAuth, toolHandler, accessControl, testKbContext());

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const tok = () => internalToken.mint({ userId: 'user-A' });

async function call(
  base: string,
  tool: (typeof TOOLS)[number],
  body: unknown = {},
): Promise<{ status: number; json: Record<string, never> }> {
  const res = await fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok()}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, never> };
}

beforeEach(() => {
  readable = ['Knowledge/A.md'];
  summaries = [];
  details = new Map();
  calls = [];
  callerEmail = VIEWER;
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  registryRef = undefined;
});

// ── The catalog ─────────────────────────────────────────────────────────────

describe('the five read tools', () => {
  it('are all registered, on both surfaces, by their GitHub-counterpart names', async () => {
    await start();
    const internal = (await registryRef!.listInternal()).map((t) => t.name);
    const external = (await registryRef!.listExternal()).map((t) => t.name);
    for (const name of TOOLS) {
      expect(internal, name).toContain(name);
      expect(external, name).toContain(name);
    }
  });

  // "None of the tools changes anything." A `write`-tagged tool is refused to
  // read-scoped callers; these must carry no such tag, because none writes.
  it('carry no `write` tag, so a read-scoped caller may use every one', async () => {
    await start();
    for (const def of await registryRef!.listExternal()) {
      if (!(TOOLS as readonly string[]).includes(def.name)) continue;
      expect(def.tags, def.name).not.toContain('write');
    }
  });

  it('name no branch: each is keyed by a change-request number, or by nothing', async () => {
    await start();
    for (const def of await registryRef!.listExternal()) {
      if (!(TOOLS as readonly string[]).includes(def.name)) continue;
      const body = (def.inputs as { properties: { body: { properties: Record<string, unknown> } } })
        .properties.body;
      expect(Object.keys(body.properties), def.name).not.toContain('branch');
    }
  });

  it('call only reads on the workflow service', async () => {
    const base = await start();
    summaries = [summary()];
    details.set(12, detail());
    for (const tool of TOOLS) {
      await call(base, tool, tool === 'list_change_requests' ? {} : { number: 12 });
    }
    const methods = new Set(calls.map((c) => c[0]));
    expect([...methods].sort()).toEqual([
      'canReadBatchAtRef',
      'getChangeRequestDetail',
      'listChangeRequestsByState',
    ]);
  });
});

// ── Scenario: list by state and source branch ───────────────────────────────

describe('list_change_requests', () => {
  // WHEN an agent calls `list_change_requests` with `state: open` and
  // `head: juan/my-draft` THEN it gets the open request from that branch, with
  // `number`, `title`, `state`, `user`, `head`, `base`, `created_at`,
  // `updated_at` and `html_url`.
  it('answers the open request from the named source branch, in GitHub fields', async () => {
    const base = await start();
    summaries = [
      summary(),
      summary({ number: 13, branch: 'juan/other', touchedNodePaths: ['Knowledge/A.md'] }),
    ];
    const { status, json } = await call(base, 'list_change_requests', {
      state: 'open',
      head: 'juan/my-draft',
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({ total_count: 1, page: 1, per_page: 30, has_next_page: false });
    expect(json.change_requests).toEqual([
      {
        number: 12,
        state: 'open',
        title: 'Rework the onboarding note',
        user: { login: `user-${hashEmail(AUTHOR).slice(0, 12)}`, name: 'Juan' },
        head: { ref: 'juan/my-draft' },
        base: { ref: 'main' },
        created_at: '2026-09-28T10:00:00.000Z',
        updated_at: '2026-09-28T10:00:00.000Z',
        merged: false,
        html_url: 'https://hexis.example.com/change-requests/12',
        changed_files: 1,
        withheld_files: 0,
      },
    ]);
    expect(calls).toContainEqual(['listChangeRequestsByState', ['open']]);
  });

  it('defaults to the open ones, as GitHub does', async () => {
    const base = await start();
    summaries = [summary(), summary({ number: 13, state: 'merged' })];
    await call(base, 'list_change_requests', {});
    expect(calls).toContainEqual(['listChangeRequestsByState', ['open']]);
  });

  it('`state: closed` asks for the applied and the declined alike; `all` for everything', async () => {
    const base = await start();
    await call(base, 'list_change_requests', { state: 'closed' });
    expect(calls).toContainEqual(['listChangeRequestsByState', ['closed', 'merged']]);
    calls = [];
    await call(base, 'list_change_requests', { state: 'all' });
    expect(calls).toContainEqual(['listChangeRequestsByState', ['closed', 'merged', 'open']]);
  });

  it('filters by target branch and by author', async () => {
    const base = await start();
    summaries = [
      summary(),
      summary({ number: 13, base: 'release', touchedNodePaths: ['Knowledge/A.md'] }),
      summary({
        number: 14,
        authorId: hashEmail('ana@bevel.software'),
        author: { login: 'user-ana', name: 'Ana' },
        appAuthor: { name: 'Ana' },
        touchedNodePaths: ['Knowledge/A.md'],
      }),
    ];
    const byBase = await call(base, 'list_change_requests', { base: 'release' });
    expect(byBase.json.change_requests).toHaveLength(1);
    expect((byBase.json.change_requests as unknown as { number: number }[])[0].number).toBe(13);

    const byAuthor = await call(base, 'list_change_requests', { author: AUTHOR });
    expect((byAuthor.json.change_requests as unknown as { number: number }[]).map((c) => c.number))
      .toEqual([12, 13]);
  });

  it('resolves each target branch once, not each request', async () => {
    const base = await start();
    summaries = [
      summary({ number: 12 }),
      summary({ number: 13 }),
      summary({ number: 14, base: 'release' }),
    ];
    await call(base, 'list_change_requests', { state: 'open' });
    const refs = calls.filter((c) => c[0] === 'canReadBatchAtRef').map((c) => c[2]);
    expect(refs.sort()).toEqual(['origin/main', 'origin/release']);
  });

  it('leaves out a request whose every file is closed to the caller', async () => {
    const base = await start();
    readable = [];
    summaries = [summary()];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.change_requests).toEqual([]);
    expect(json.total_count).toBe(0);
  });

  it('still shows the author their own request when they may read none of it', async () => {
    const base = await start();
    readable = [];
    callerEmail = AUTHOR;
    summaries = [summary()];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.change_requests).toHaveLength(1);
    expect((json.change_requests as unknown as { withheld_files: number }[])[0].withheld_files).toBe(1);
  });

  it('counts the files it withheld without naming them', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    summaries = [summary({ touchedNodePaths: ['Knowledge/A.md', 'Payroll/Rates.md'] })];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.change_requests).toHaveLength(1);
    expect(json.change_requests[0]).toMatchObject({ changed_files: 1, withheld_files: 1 });
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('pages after the access filter, so a page length says nothing about what was withheld', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    summaries = Array.from({ length: 40 }, (_, i) =>
      summary({ number: i + 1, touchedNodePaths: i % 2 === 0 ? ['Knowledge/A.md'] : ['Payroll/Rates.md'] }),
    );
    const { json } = await call(base, 'list_change_requests', {});
    // 20 of the 40 are visible — a full page of 30 would have been the giveaway.
    expect(json.total_count).toBe(20);
    expect(json.change_requests).toHaveLength(20);
    expect(json.has_next_page).toBe(false);
  });
});

// ── Scenario: read one request ──────────────────────────────────────────────

describe('get_change_request', () => {
  // WHEN it calls `get_change_request` with that number THEN it also gets
  // `body`, `merged`, `mergeable`, and `access` with the blockers.
  it('adds body, merged, mergeable and the access block with the blockers', async () => {
    const base = await start();
    const waiting = ['Waiting on approval for Knowledge/A.md from Engineering.'];
    details.set(
      12,
      detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting, mergeableInBevel: false }),
    );
    const { status, json } = await call(base, 'get_change_request', { number: 12 });
    expect(status).toBe(200);
    expect(json.change_request).toMatchObject({
      number: 12,
      state: 'open',
      title: 'Rework the onboarding note',
      body: 'Why this change is needed.',
      merged: false,
      mergeable: false,
      head: { ref: 'juan/my-draft', sha: 'head-1' },
      base: { ref: 'main', sha: 'base-1' },
      html_url: 'https://hexis.example.com/change-requests/12',
      access: {
        merge_blockers: waiting,
        withheld_merge_blockers: 0,
        may_approve: false,
        may_merge: false,
        is_author: false,
      },
    });
  });

  it('tells the author it is theirs, and an approver that they may approve', async () => {
    const base = await start();
    callerEmail = AUTHOR;
    details.set(12, detail({ approvals: [approval('Knowledge/A.md', { viewerCanApprove: true })] }));
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json.change_request).toMatchObject({ access: { is_author: true, may_approve: true } });
  });

  // WHEN the request is merged THEN `state` is `closed` and `merged` is true.
  it('reports a merged request as closed and merged', async () => {
    const base = await start();
    details.set(
      12,
      detail({
        state: 'merged',
        mergeBlockedReasons: ['This pull request has already been merged.'],
      }),
    );
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json.change_request).toMatchObject({ state: 'closed', merged: true });
    expect(json.change_request).toMatchObject({ access: { may_merge: false } });
  });

  // Applying a request retires its source branch, so its diff can no longer be
  // computed and no file of it can be proven readable. Fail-closed therefore
  // leaves it readable by its author alone — the honest answer, since "we cannot
  // tell what it touched" is not "you may see it".
  it('leaves an applied request whose files can no longer be resolved to its author', async () => {
    const base = await start();
    details.set(12, detail({ state: 'merged', files: [], approvals: [] }));
    expect((await call(base, 'get_change_request', { number: 12 })).status).toBe(404);

    callerEmail = AUTHOR;
    const mine = await call(base, 'get_change_request', { number: 12 });
    expect(mine.status).toBe(200);
    expect(mine.json.change_request).toMatchObject({
      state: 'closed',
      merged: true,
      changed_files: 0,
      withheld_files: 0,
      access: { is_author: true, may_merge: false },
    });
  });

  it('reports a declined request as closed and NOT merged', async () => {
    const base = await start();
    details.set(12, detail({ state: 'closed' }));
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json.change_request).toMatchObject({ state: 'closed', merged: false });
  });

  // WHEN the caller may read none of the request's files and is not its author
  // THEN `get_change_request` answers 404.
  it('answers not found when the caller may read none of its files', async () => {
    const base = await start();
    readable = [];
    details.set(12, detail());
    const { status, json } = await call(base, 'get_change_request', { number: 12 });
    expect(status).toBe(404);
    // Word for word what a number that was never issued gets: the answer is a
    // function of the number alone, so a probe learns nothing from the
    // difference between a request withheld and a request that never existed.
    expect(json.error).toBe('Change request #12 not found.');
    const absent = await call(base, 'get_change_request', { number: 99 });
    expect(absent.status).toBe(404);
    expect(absent.json.error).toBe('Change request #99 not found.');
  });

  it('answers not found when the access tree at the target cannot be resolved', async () => {
    const base = await start();
    readable = null;
    details.set(12, detail());
    expect((await call(base, 'get_change_request', { number: 12 })).status).toBe(404);
  });

  it('withholds a merge blocker that would name a file the caller may not read', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    const reasons = [
      'Waiting on approval for Knowledge/A.md from Engineering.',
      'Waiting on approval for Payroll/Rates.md from Finance.',
    ];
    details.set(
      12,
      detail({
        files: [file('Knowledge/A.md'), file('Payroll/Rates.md')],
        mergeBlockedReasons: reasons,
        mergeWarnings: reasons,
      }),
    );
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json.change_request).toMatchObject({
      changed_files: 1,
      withheld_files: 1,
      access: { merge_blockers: [reasons[0]], withheld_merge_blockers: 1 },
    });
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('refuses a number that is not a positive integer', async () => {
    const base = await start();
    for (const number of [0, -3, 1.5, 'twelve', undefined]) {
      expect((await call(base, 'get_change_request', { number })).status, String(number)).toBe(400);
    }
  });
});

// ── Scenario: files, approvals and patches ──────────────────────────────────

describe('list_change_request_files', () => {
  // WHEN a reviewer approved two of three files THEN `list_change_request_files`
  // shows `approved_by` on those two and the missing approver on the third.
  it('shows approved_by on the approved files and the missing approver on the rest', async () => {
    const base = await start();
    readable = ['A.md', 'B.md', 'C.md'];
    const mia = approvedBy(VIEWER, 'Mia', '2026-09-29T08:00:00.000Z');
    details.set(
      12,
      detail({
        files: [file('A.md'), file('B.md'), file('C.md')],
        approvals: [
          approval('A.md', { approvedBy: [mia], isApproved: true }),
          approval('B.md', { approvedBy: [mia], isApproved: true }),
          approval('C.md', {
            eligibleApprovers: { roles: [], users: [{ name: 'Ana', email: 'ana@bevel.software' }] },
          }),
        ],
      }),
    );
    const { status, json } = await call(base, 'list_change_request_files', { number: 12 });
    expect(status).toBe(200);
    const files = json.files as unknown as {
      filename: string;
      approved: boolean;
      approved_by: { user: { name: string } }[];
      required_approvers: { roles: string[]; users: { email: string }[] };
    }[];
    expect(files.map((f) => f.filename)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(files[0].approved_by.map((a) => a.user.name)).toEqual(['Mia']);
    expect(files[1].approved_by.map((a) => a.user.name)).toEqual(['Mia']);
    expect(files[2].approved_by).toEqual([]);
    expect(files[2].approved).toBe(false);
    expect(files[2].required_approvers.users.map((u) => u.email)).toEqual(['ana@bevel.software']);
  });

  // WHEN the request touches one file in a folder the caller may not read THEN
  // the files list leaves it out and `withheld_files` is 1.
  it('leaves out a file in a folder the caller may not read, and counts it', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    details.set(12, detail({ files: [file('Knowledge/A.md'), file('Payroll/Rates.md')] }));
    const { json } = await call(base, 'list_change_request_files', { number: 12 });
    expect((json.files as unknown as { filename: string }[]).map((f) => f.filename)).toEqual([
      'Knowledge/A.md',
    ]);
    expect(json.withheld_files).toBe(1);
    expect(json.total_count).toBe(1);
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  // WHEN the request has 40 files THEN the first page holds 30 and says there
  // is a second.
  it('pages 40 files into 30 and a second page', async () => {
    const base = await start();
    const paths = Array.from({ length: 40 }, (_, i) => `Knowledge/F${i}.md`);
    readable = paths;
    details.set(12, detail({ files: paths.map((p) => file(p)) }));
    const first = await call(base, 'list_change_request_files', { number: 12 });
    expect(first.json.files).toHaveLength(30);
    expect(first.json).toMatchObject({ total_count: 40, page: 1, per_page: 30, has_next_page: true });
    const second = await call(base, 'list_change_request_files', { number: 12, page: 2 });
    expect(second.json.files).toHaveLength(10);
    expect(second.json.has_next_page).toBe(false);
  });

  it('returns no patch unless `include: ["patches"]` asks for one', async () => {
    const base = await start();
    details.set(12, detail());
    const without = await call(base, 'list_change_request_files', { number: 12 });
    expect((without.json.files as unknown as { patch?: string }[])[0].patch).toBeUndefined();
    expect(calls).toContainEqual(['getChangeRequestDetail', 12, false, VIEWER]);

    calls = [];
    const withPatches = await call(base, 'list_change_request_files', {
      number: 12,
      include: ['patches'],
    });
    expect((withPatches.json.files as unknown as { patch?: string }[])[0].patch).toBe(
      '@@ Knowledge/A.md @@',
    );
    expect(calls).toContainEqual(['getChangeRequestDetail', 12, true, VIEWER]);
  });

  it('answers not found when the caller may read none of its files', async () => {
    const base = await start();
    readable = [];
    details.set(12, detail());
    expect((await call(base, 'list_change_request_files', { number: 12 })).status).toBe(404);
  });
});

// ── Scenario: reviews ───────────────────────────────────────────────────────

describe('list_change_request_reviews', () => {
  // WHEN a reviewer approved two of three files THEN
  // `list_change_request_reviews` names the reviewer and the two files.
  it('names the reviewer and the two files they approved', async () => {
    const base = await start();
    readable = ['A.md', 'B.md', 'C.md'];
    details.set(
      12,
      detail({
        files: [file('A.md'), file('B.md'), file('C.md')],
        approvals: [
          approval('A.md', { approvedBy: [approvedBy(VIEWER, 'Mia', '2026-09-29T08:00:00.000Z')], isApproved: true }),
          approval('B.md', { approvedBy: [approvedBy(VIEWER, 'Mia', '2026-09-29T09:00:00.000Z')], isApproved: true }),
          approval('C.md'),
        ],
      }),
    );
    const { status, json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(status).toBe(200);
    expect(json.reviews).toHaveLength(1);
    expect(json.reviews[0]).toMatchObject({
      user: { name: 'Mia', email: VIEWER },
      state: 'APPROVED',
      submitted_at: '2026-09-29T09:00:00.000Z',
      files: ['A.md', 'B.md'],
      withheld_files: 0,
    });
  });

  it("counts a reviewer's withheld files without naming them", async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    const mia = approvedBy(VIEWER, 'Mia', '2026-09-29T08:00:00.000Z');
    details.set(
      12,
      detail({
        files: [file('Knowledge/A.md'), file('Payroll/Rates.md')],
        approvals: [
          approval('Knowledge/A.md', { approvedBy: [mia], isApproved: true }),
          approval('Payroll/Rates.md', { approvedBy: [mia], isApproved: true }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json.reviews[0]).toMatchObject({ files: ['Knowledge/A.md'], withheld_files: 1 });
    expect(json.withheld_reviews).toBe(0);
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('drops a review about files the caller may not read, and counts it instead', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    details.set(
      12,
      detail({
        files: [file('Knowledge/A.md'), file('Payroll/Rates.md')],
        approvals: [
          approval('Knowledge/A.md'),
          approval('Payroll/Rates.md', {
            approvedBy: [approvedBy('ana@bevel.software', 'Ana', '2026-09-29T08:00:00.000Z')],
            isApproved: true,
          }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json.reviews).toEqual([]);
    expect(json.withheld_reviews).toBe(1);
    // Neither the reviewer nor the file they approved is named.
    expect(JSON.stringify(json)).not.toContain('Ana');
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('reports an approval a later push invalidated as DISMISSED', async () => {
    const base = await start();
    details.set(
      12,
      detail({
        approvals: [
          approval('Knowledge/A.md', {
            approvedBy: [approvedBy(VIEWER, 'Mia', '2026-09-28T08:00:00.000Z', true)],
          }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json.reviews[0]).toMatchObject({ state: 'DISMISSED', files: ['Knowledge/A.md'] });
  });

  it('answers an empty list when nobody has approved anything yet', async () => {
    const base = await start();
    details.set(12, detail());
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json).toMatchObject({ reviews: [], withheld_reviews: 0, total_count: 0, has_next_page: false });
  });
});

// ── Scenario: comments ──────────────────────────────────────────────────────

describe('list_change_request_comments', () => {
  const comment = (over: Partial<ChangeRequestComment>): ChangeRequestComment => ({
    id: 'c-1',
    author: { email: VIEWER, name: 'Mia' },
    body: 'This line is out of date.',
    headSha: 'head-1',
    createdAt: '2026-09-29T08:00:00.000Z',
    ...over,
  });

  // WHEN a reviewer left an inline comment and a reply followed THEN
  // `list_change_request_comments` returns both, the reply with `in_reply_to`.
  it('returns the inline comment and its reply, the reply carrying in_reply_to', async () => {
    const base = await start();
    details.set(
      12,
      detail({
        comments: [
          comment({ id: 'c-1', path: 'Knowledge/A.md', line: 14 }),
          comment({
            id: 'c-2',
            author: { email: AUTHOR, name: 'Juan' },
            body: 'Fixed.',
            path: 'Knowledge/A.md',
            line: 14,
            parentId: 'c-1',
            createdAt: '2026-09-29T09:00:00.000Z',
          }),
        ],
      }),
    );
    const { status, json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect(status).toBe(200);
    expect(json.comments).toHaveLength(2);
    expect(json.comments[0]).toMatchObject({
      id: 'c-1',
      user: { name: 'Mia', email: VIEWER },
      body: 'This line is out of date.',
      path: 'Knowledge/A.md',
      line: 14,
      commit_id: 'head-1',
      created_at: '2026-09-29T08:00:00.000Z',
    });
    expect(json.comments[1]).toMatchObject({ id: 'c-2', in_reply_to: 'c-1' });
    expect(json.withheld_comments).toBe(0);
  });

  it('keeps a general comment, which belongs to the request rather than a file', async () => {
    const base = await start();
    details.set(12, detail({ comments: [comment({ id: 'c-9', body: 'Ready for review.' })] }));
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect(json.comments).toHaveLength(1);
    expect((json.comments as unknown as { path?: string }[])[0].path).toBeUndefined();
  });

  it('leaves out a comment on a file the caller may not read, and counts it', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    details.set(
      12,
      detail({
        files: [file('Knowledge/A.md'), file('Payroll/Rates.md')],
        comments: [
          comment({ id: 'c-1', path: 'Knowledge/A.md', line: 1 }),
          comment({ id: 'c-2', path: 'Payroll/Rates.md', line: 2, body: 'The band is wrong.' }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect((json.comments as unknown as { id: string }[]).map((c) => c.id)).toEqual(['c-1']);
    expect(json.withheld_comments).toBe(1);
    expect(JSON.stringify(json)).not.toContain('Payroll');
    expect(JSON.stringify(json)).not.toContain('band is wrong');
  });

  it('keeps a comment on a file the request no longer changes but the caller may read', async () => {
    const base = await start();
    readable = ['Knowledge/A.md', 'Knowledge/Gone.md'];
    details.set(12, detail({ comments: [comment({ id: 'c-7', path: 'Knowledge/Gone.md', line: 3 })] }));
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect((json.comments as unknown as { id: string }[]).map((c) => c.id)).toEqual(['c-7']);
    expect(json.withheld_comments).toBe(0);
  });

  it('pages the comments', async () => {
    const base = await start();
    details.set(
      12,
      detail({
        comments: Array.from({ length: 40 }, (_, i) =>
          comment({ id: `c-${i}`, createdAt: `2026-09-29T08:00:${String(i).padStart(2, '0')}.000Z` }),
        ),
      }),
    );
    const first = await call(base, 'list_change_request_comments', { number: 12 });
    expect(first.json.comments).toHaveLength(30);
    expect(first.json.has_next_page).toBe(true);
    const second = await call(base, 'list_change_request_comments', { number: 12, page: 2 });
    expect(second.json.comments).toHaveLength(10);
    expect(second.json.has_next_page).toBe(false);
  });

  it('answers not found when the caller may read none of its files', async () => {
    const base = await start();
    readable = [];
    details.set(12, detail({ comments: [comment({ id: 'c-1' })] }));
    expect((await call(base, 'list_change_request_comments', { number: 12 })).status).toBe(404);
  });
});
