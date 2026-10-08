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
import { APPLY_FAILURE_REASON_WITHHELD } from '../change-request-read-shape.js';

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

/** A comment as the detail carries one. Module-level: the rename suite needs it too. */
function comment(over: Partial<ChangeRequestComment>): ChangeRequestComment {
  return {
    id: 'c-1',
    author: { email: VIEWER, name: 'Mia' },
    body: 'This line is out of date.',
    headSha: 'head-1',
    createdAt: '2026-09-29T08:00:00.000Z',
    ...over,
  };
}

function approvedBy(email: string, name: string, at: string, isStale = false) {
  return { email, name, approvedAt: at, isStale, isSelfApproval: false };
}

/**
 * A summary as `PullRequestService.summaryOf` builds one — `touchedNodeFiles`
 * included, derived from `touchedNodePaths` unless a test overrides it. A
 * fixture that left it out would be testing a summary no builder produces, and
 * would hide whether the list reads it at all.
 */
function summary(over: Partial<ChangeRequest> = {}): ChangeRequest {
  const paths = over.touchedNodePaths ?? ['Knowledge/A.md'];
  return {
    touchedNodeFiles: paths.map((path) => ({ path })),
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
    // `getPrDetail` pairs the summary off its real file list, so a detail used
    // as a list row carries the same files its own file tool would answer.
    touchedNodeFiles: files.map((f) => ({
      path: f.path,
      ...(f.previousPath ? { previousPath: f.previousPath } : {}),
    })),
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

/** The clone the workspace service knows of — null for a deployment where none has been created yet. */
let anyWorkspaceId: string | null = 'existing-ws';
const workspaceService = {
  // The read tools resolve any existing clone: every verdict is read at
  // `origin/<base>`, so no draft has to be cloned to answer.
  findAnyWorkspaceId: async () => anyWorkspaceId,
  getOrCreateForUser: async () => ({ id: 'existing-ws' }),
  getWorkspacePath: async () => '/tmp/ws',
  getOrCreateForBranch: async (b: string) => ({ id: b }),
} as never;

/** The workspace each listing was asked to read in, in order. */
let listedIn: Array<string | undefined> = [];
const workflowService = {
  listChangeRequestsByState: async (states: ChangeRequestState[], opts?: { workspaceId?: string }) => {
    calls.push(['listChangeRequestsByState', [...states].sort()]);
    listedIn.push(opts?.workspaceId);
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

/** Every path the access tree was asked about, across the call under test. */
let accessAskedFor: string[] = [];

const accessControl = {
  canReadBatchAtRef: async (ws: string, ref: string, email: string, paths: string[]) => {
    calls.push(['canReadBatchAtRef', ws, ref, email]);
    accessAskedFor.push(...paths);
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
  accessAskedFor = [];
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
  // `head: juan/my-draft` THEN it gets the open request from that branch — in
  // HEXIS's field names, the ones `open_change_request` answers in: `url`
  // first, `number`, `title`, `state`, `author`, `sourceBranch`,
  // `targetBranch`, `createdAt`, `updatedAt`.
  it("answers the open request from the named source branch, in Hexis's field names", async () => {
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
    expect(json).toMatchObject({ totalCount: 1, page: 1, perPage: 30, hasNextPage: false });
    expect(json.changeRequests).toEqual([
      {
        url: 'https://hexis.example.com/change-requests/12',
        number: 12,
        title: 'Rework the onboarding note',
        state: 'open',
        author: { login: `user-${hashEmail(AUTHOR).slice(0, 12)}`, name: 'Juan' },
        sourceBranch: 'juan/my-draft',
        targetBranch: 'main',
        createdAt: '2026-09-28T10:00:00.000Z',
        updatedAt: '2026-09-28T10:00:00.000Z',
        changedFiles: 1,
        withheldFiles: 0,
      },
    ]);
    // No GitHub field names anywhere in the answer, and no `merged` flag: the
    // state says it.
    const row = json.changeRequests[0] as Record<string, unknown>;
    for (const gh of ['html_url', 'user', 'head', 'base', 'merged', 'created_at', 'changed_files']) {
      expect(row).not.toHaveProperty(gh);
    }
    // `url` is the first key, so a truncated answer still carries the link.
    expect(Object.keys(row)[0]).toBe('url');
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

  it('refuses a `state` it does not know instead of answering the open ones', async () => {
    const base = await start();
    // `merged` is what the ANSWER says for an applied request, so it is the
    // word an agent is most likely to feed back in; a typo is refused too.
    for (const state of ['merged', 'applied', 'OPEN', '', 7, null]) {
      calls = [];
      const { status, json } = await call(base, 'list_change_requests', { state });
      expect(status, JSON.stringify(state)).toBe(400);
      expect(JSON.stringify(json), JSON.stringify(state)).toMatch(/open.*closed.*all/);
      expect(calls, JSON.stringify(state)).toEqual([]);
    }
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
    expect(byBase.json.changeRequests).toHaveLength(1);
    expect((byBase.json.changeRequests as unknown as { number: number }[])[0].number).toBe(13);

    const byAuthor = await call(base, 'list_change_requests', { author: AUTHOR });
    expect((byAuthor.json.changeRequests as unknown as { number: number }[]).map((c) => c.number))
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
    expect(json.changeRequests).toEqual([]);
    expect(json.totalCount).toBe(0);
  });

  it('lists in the same clone the by-number tools read in — the default one when none exists yet', async () => {
    // The by-number tools fall back to the default workspace; a listing that
    // fell back to nothing built every file list empty and hid every request
    // the caller did not author, while `get_change_request` served them. One
    // resolution, handed to both.
    const base = await start();
    summaries = [summary()];
    listedIn = [];
    await call(base, 'list_change_requests', {});
    expect(listedIn).toEqual(['existing-ws']);
    anyWorkspaceId = null;
    try {
      listedIn = [];
      await call(base, 'list_change_requests', {});
      expect(listedIn).toEqual([testKbContext().defaultWorkspaceId()]);
    } finally {
      anyWorkspaceId = 'existing-ws';
    }
  });

  it('still shows the author their own request when they may read none of it', async () => {
    const base = await start();
    readable = [];
    callerEmail = AUTHOR;
    summaries = [summary()];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.changeRequests).toHaveLength(1);
    expect((json.changeRequests as unknown as { withheldFiles: number }[])[0].withheldFiles).toBe(1);
  });

  it('counts the files it withheld without naming them', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    summaries = [summary({ touchedNodePaths: ['Knowledge/A.md', 'Payroll/Rates.md'] })];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.changeRequests).toHaveLength(1);
    expect(json.changeRequests[0]).toMatchObject({ changedFiles: 1, withheldFiles: 1 });
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('tells why the last Apply failed, in its own words only when every file is readable', async () => {
    const base = await start();
    const failure = { reason: 'Conflicts in Payroll/Rates.md', conflicts: true, at: '2026-09-29T09:00:00.000Z' };
    readable = ['Knowledge/A.md'];
    summaries = [summary({ touchedNodePaths: ['Knowledge/A.md', 'Payroll/Rates.md'], lastApplyFailure: failure })];
    const withheld = await call(base, 'list_change_requests', {});
    expect(withheld.json.changeRequests[0]).toMatchObject({
      lastApplyFailure: { reason: APPLY_FAILURE_REASON_WITHHELD, conflicts: true, at: failure.at },
    });
    expect(JSON.stringify(withheld.json)).not.toContain('Payroll');
    // The detail withholds on the same verdict, through its own path.
    details.set(
      12,
      detail({
        files: [file('Knowledge/A.md'), file('Payroll/Rates.md')],
        touchedNodePaths: ['Knowledge/A.md', 'Payroll/Rates.md'],
        lastApplyFailure: failure,
      }),
    );
    const detailWithheld = (await call(base, 'get_change_request', { number: 12 })).json;
    expect(detailWithheld).toMatchObject({ lastApplyFailure: { reason: APPLY_FAILURE_REASON_WITHHELD } });
    expect(JSON.stringify(detailWithheld)).not.toContain('Payroll');
    readable = ['Knowledge/A.md', 'Payroll/Rates.md'];
    const shown = await call(base, 'list_change_requests', {});
    expect(shown.json.changeRequests[0]).toMatchObject({ lastApplyFailure: failure });
    expect((await call(base, 'get_change_request', { number: 12 })).json).toMatchObject({ lastApplyFailure: failure });
  });

  it('pages after the access filter, so a page length says nothing about what was withheld', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    summaries = Array.from({ length: 40 }, (_, i) =>
      summary({ number: i + 1, touchedNodePaths: i % 2 === 0 ? ['Knowledge/A.md'] : ['Payroll/Rates.md'] }),
    );
    const { json } = await call(base, 'list_change_requests', {});
    // 20 of the 40 are visible — a full page of 30 would have been the giveaway.
    expect(json.totalCount).toBe(20);
    expect(json.changeRequests).toHaveLength(20);
    expect(json.hasNextPage).toBe(false);
  });
});

// ── Scenario: read one request ──────────────────────────────────────────────

describe('get_change_request', () => {
  // WHEN it calls `get_change_request` with that number THEN it also gets
  // `body`, `mergeable`, the blockers and the `viewer` block — unwrapped, the
  // way `open_change_request` answers since #349.
  it('adds body, mergeable, the blockers and the viewer block', async () => {
    const base = await start();
    const waiting = ['Waiting on approval for Knowledge/A.md from Engineering.'];
    details.set(
      12,
      detail({ mergeBlockedReasons: waiting, mergeWarnings: waiting, mergeableInBevel: false }),
    );
    const { status, json } = await call(base, 'get_change_request', { number: 12 });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      url: 'https://hexis.example.com/change-requests/12',
      number: 12,
      title: 'Rework the onboarding note',
      state: 'open',
      body: 'Why this change is needed.',
      sourceBranch: 'juan/my-draft',
      targetBranch: 'main',
      headSha: 'head-1',
      baseSha: 'base-1',
      mergeable: false,
      mergeBlockedReasons: waiting,
      withheldMergeBlockedReasons: 0,
      viewer: { mayApprove: false, mayMerge: false, isAuthor: false },
    });
    // Not wrapped in `change_request`, and `url` still first.
    expect(json).not.toHaveProperty('change_request');
    expect(Object.keys(json)[0]).toBe('url');
  });

  it('tells the author it is theirs, and an approver that they may approve', async () => {
    const base = await start();
    callerEmail = AUTHOR;
    details.set(12, detail({ approvals: [approval('Knowledge/A.md', { viewerCanApprove: true })] }));
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json).toMatchObject({ viewer: { isAuthor: true, mayApprove: true } });
  });

  // WHEN the request is merged THEN `state` says `merged` — Hexis's own state,
  // not GitHub's `closed` plus a flag a reader has to look for.
  it('reports a merged request as merged, with no flag to cross-read', async () => {
    const base = await start();
    details.set(
      12,
      detail({
        state: 'merged',
        mergeBlockedReasons: ['This pull request has already been merged.'],
      }),
    );
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json).toMatchObject({ state: 'merged', viewer: { mayMerge: false } });
    expect(json).not.toHaveProperty('merged');
  });

  // An applied request is normally read from its merge commit (the 2026-10-02
  // decision), so this is the corner that is left: a row whose file set could not
  // be resolved AT ALL — no `merged_sha`, or a clone that does not hold the
  // commit yet. No file of it can be proven readable, so fail-closed leaves it to
  // its author alone: "we cannot tell what it touched" is not "you may see it".
  it('leaves an applied request whose files could not be resolved at all to its author', async () => {
    const base = await start();
    details.set(12, detail({ state: 'merged', files: [], approvals: [] }));
    expect((await call(base, 'get_change_request', { number: 12 })).status).toBe(404);

    callerEmail = AUTHOR;
    const mine = await call(base, 'get_change_request', { number: 12 });
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({
      state: 'merged',
      changedFiles: 0,
      withheldFiles: 0,
      viewer: { isAuthor: true, mayMerge: false },
    });
  });

  // The AUTHOR reads it, because nobody else can: a declined request is read
  // from nothing (no sha is recorded, and its branch now holds later work), so
  // its file set is empty and an empty file set proves no read access. Asking as
  // a stranger would pin the state mapping on a combination the service cannot
  // produce — a non-author holding a readable file list for a declined request.
  it('reports a declined request as closed, which in Hexis means declined', async () => {
    const base = await start();
    callerEmail = AUTHOR;
    details.set(12, detail({ state: 'closed', files: [], approvals: [] }));
    const { json } = await call(base, 'get_change_request', { number: 12 });
    expect(json).toMatchObject({ state: 'closed', changedFiles: 0, viewer: { isAuthor: true } });
    expect(json).not.toHaveProperty('merged');
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

  // An OPEN request that proposes nothing, before the background sweep has
  // closed it: still "not found" to an agent that is not its author. Closing
  // empty requests changed nothing about what agents may see.
  it('answers not found for an open request with no files to an agent that is not its author', async () => {
    const base = await start();
    details.set(12, detail({ state: 'open', files: [], approvals: [] }));
    const { status, json } = await call(base, 'get_change_request', { number: 12 });
    expect(status).toBe(404);
    expect(json.error).toBe('Change request #12 not found.');
    callerEmail = AUTHOR;
    expect((await call(base, 'get_change_request', { number: 12 })).status).toBe(200);
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
    expect(json).toMatchObject({
      changedFiles: 1,
      withheldFiles: 1,
      mergeBlockedReasons: [reasons[0]],
      withheldMergeBlockedReasons: 1,
    });
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('refuses a number that is not a positive integer', async () => {
    const base = await start();
    // 2^53 and above are integers JSON can spell that a double cannot hold
    // exactly: refused like a fraction, rather than rounded on the way to
    // the database or turned into its error.
    for (const number of [0, -3, 1.5, 2 ** 53, 1e300, 'twelve', undefined]) {
      expect((await call(base, 'get_change_request', { number })).status, String(number)).toBe(400);
    }
  });
});

// ── Scenario: files, approvals and patches ──────────────────────────────────

describe('list_change_request_files', () => {
  // WHEN a reviewer approved two of three files THEN `list_change_request_files`
  // shows `approvedBy` on those two and the missing approver on the third.
  it('shows approvedBy on the approved files and the missing approver on the rest', async () => {
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
      path: string;
      approved: boolean;
      approvedBy: { user: { name: string } }[];
      requiredApprovers: { roles: string[]; users: { email: string }[] };
    }[];
    expect(files.map((f) => f.path)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(files[0].approvedBy.map((a) => a.user.name)).toEqual(['Mia']);
    expect(files[1].approvedBy.map((a) => a.user.name)).toEqual(['Mia']);
    expect(files[2].approvedBy).toEqual([]);
    expect(files[2].approved).toBe(false);
    expect(files[2].requiredApprovers.users.map((u) => u.email)).toEqual(['ana@bevel.software']);
  });

  // WHEN the request touches one file in a folder the caller may not read THEN
  // the files list leaves it out and `withheldFiles` is 1.
  it('leaves out a file in a folder the caller may not read, and counts it', async () => {
    const base = await start();
    readable = ['Knowledge/A.md'];
    details.set(12, detail({ files: [file('Knowledge/A.md'), file('Payroll/Rates.md')] }));
    const { json } = await call(base, 'list_change_request_files', { number: 12 });
    expect((json.files as unknown as { path: string }[]).map((f) => f.path)).toEqual([
      'Knowledge/A.md',
    ]);
    expect(json.withheldFiles).toBe(1);
    expect(json.totalCount).toBe(1);
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
    expect(first.json).toMatchObject({ totalCount: 40, page: 1, perPage: 30, hasNextPage: true });
    const second = await call(base, 'list_change_request_files', { number: 12, page: 2 });
    expect(second.json.files).toHaveLength(10);
    expect(second.json.hasNextPage).toBe(false);
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
      reviewer: { name: 'Mia', email: VIEWER },
      stale: false,
      submittedAt: '2026-09-29T09:00:00.000Z',
      files: ['A.md', 'B.md'],
      withheldFiles: 0,
    });
    // Hexis's own word for an approval that still stands, not GitHub's review
    // state: nothing here says APPROVED or DISMISSED.
    expect(JSON.stringify(json)).not.toContain('APPROVED');
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
    expect(json.reviews[0]).toMatchObject({ files: ['Knowledge/A.md'], withheldFiles: 1 });
    expect(json.withheldReviews).toBe(0);
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
    expect(json.withheldReviews).toBe(1);
    // Neither the reviewer nor the file they approved is named.
    expect(JSON.stringify(json)).not.toContain('Ana');
    expect(JSON.stringify(json)).not.toContain('Payroll');
  });

  it('reports an approval a later push invalidated as stale, in Hexis\'s own word', async () => {
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
    expect(json.reviews[0]).toMatchObject({ stale: true, files: ['Knowledge/A.md'] });
    expect(JSON.stringify(json)).not.toContain('DISMISSED');
  });

  it('answers an empty list when nobody has approved anything yet', async () => {
    const base = await start();
    details.set(12, detail());
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json).toMatchObject({ reviews: [], withheldReviews: 0, totalCount: 0, hasNextPage: false });
  });
});

// ── Scenario: comments ──────────────────────────────────────────────────────

describe('list_change_request_comments', () => {
  // WHEN a reviewer left an inline comment and a reply followed THEN
  // `list_change_request_comments` returns both, the reply with `parentId`.
  it('returns the inline comment and its reply, the reply carrying parentId', async () => {
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
      author: { name: 'Mia', email: VIEWER },
      body: 'This line is out of date.',
      path: 'Knowledge/A.md',
      line: 14,
      headSha: 'head-1',
      createdAt: '2026-09-29T08:00:00.000Z',
    });
    expect(json.comments[1]).toMatchObject({ id: 'c-2', parentId: 'c-1' });
    expect(json.withheldComments).toBe(0);
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
    expect(json.withheldComments).toBe(1);
    expect(JSON.stringify(json)).not.toContain('Payroll');
    expect(JSON.stringify(json)).not.toContain('band is wrong');
  });

  it('keeps a comment on a file the request no longer changes but the caller may read', async () => {
    const base = await start();
    readable = ['Knowledge/A.md', 'Knowledge/Gone.md'];
    details.set(12, detail({ comments: [comment({ id: 'c-7', path: 'Knowledge/Gone.md', line: 3 })] }));
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect((json.comments as unknown as { id: string }[]).map((c) => c.id)).toEqual(['c-7']);
    expect(json.withheldComments).toBe(0);
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
    expect(first.json.hasNextPage).toBe(true);
    const second = await call(base, 'list_change_request_comments', { number: 12, page: 2 });
    expect(second.json.comments).toHaveLength(10);
    expect(second.json.hasNextPage).toBe(false);
  });

  it('answers not found when the caller may read none of its files', async () => {
    const base = await start();
    readable = [];
    details.set(12, detail({ comments: [comment({ id: 'c-1' })] }));
    expect((await call(base, 'list_change_request_comments', { number: 12 })).status).toBe(404);
  });
});

/**
 * Reproductions of what Local Testing found on sha ae2f49d9, through the HTTP
 * tool surface it found them on — not just the pure mapper underneath.
 */
describe('a mixed-access caller is never handed a path they may not read', () => {
  /** A body exactly as `openChangeRequest` builds it: prose, then the block. */
  const bodyWithOwnersBlock = [
    'Please review the check-in note.',
    '',
    '## Affected owners',
    '',
    '- `KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md` — Admin',
    '- `KnowledgeBase/GTM/Notes.md` — GTM Team',
  ].join('\n');

  /** The reader of one folder of a two-folder request — john.newcomer's case. */
  function mixedAccessRequest(): void {
    readable = ['KnowledgeBase/GTM/Notes.md'];
    const waiting = [
      'Waiting on approval for KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md from Admin.',
      'Waiting on approval for KnowledgeBase/GTM/Notes.md from GTM Team.',
    ];
    details.set(
      1,
      detail({
        number: 1,
        body: bodyWithOwnersBlock,
        files: [
          file('KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md'),
          file('KnowledgeBase/GTM/Notes.md'),
        ],
        approvals: [
          approval('KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md', {
            eligibleApprovers: { roles: ['Admin'], users: [] },
          }),
          approval('KnowledgeBase/GTM/Notes.md', {
            eligibleApprovers: { roles: ['GTM Team'], users: [] },
          }),
        ],
        mergeBlockedReasons: waiting,
        mergeWarnings: waiting,
      }),
    );
  }

  it('get_change_request answers the author\'s reason and names no withheld file anywhere', async () => {
    const base = await start();
    mixedAccessRequest();
    const { status, json } = await call(base, 'get_change_request', { number: 1 });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      body: 'Please review the check-in note.',
      changedFiles: 1,
      withheldFiles: 1,
    });
    // The whole payload, not just `body` — this is the assertion whose absence
    // let the leak through the first time.
    const whole = JSON.stringify(json);
    expect(whole).not.toContain('Avi-Checkin');
    expect(whole).not.toContain('KnowledgeBase/Engineering');
    expect(whole).not.toContain('Affected owners');
    // The file they CAN read is still named, and its blocker still readable.
    expect(whole).toContain('KnowledgeBase/GTM/Notes.md');
    expect(json).toMatchObject({ withheldMergeBlockedReasons: 1 });
  });

  it('no tool of the five names the withheld file, in any field', async () => {
    const base = await start();
    mixedAccessRequest();
    summaries = [details.get(1)!];
    for (const tool of TOOLS) {
      // `include` only where the tool declares it: a call naming an argument
      // its tool does not have is refused before it runs.
      const args =
        tool === 'list_change_requests'
          ? {}
          : tool === 'list_change_request_files'
            ? { number: 1, include: ['patches'] }
            : { number: 1 };
      const { status, json } = await call(base, tool, args);
      expect(status, tool).toBe(200);
      const whole = JSON.stringify(json);
      expect(whole, tool).not.toContain('Avi-Checkin');
      expect(whole, tool).not.toContain('KnowledgeBase/Engineering');
    }
  });

  it('the author sees their own body too — the cut is the same for everyone', async () => {
    const base = await start();
    mixedAccessRequest();
    callerEmail = AUTHOR;
    readable = [
      'KnowledgeBase/GTM/Notes.md',
      'KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md',
    ];
    const { json } = await call(base, 'get_change_request', { number: 1 });
    // A caller who may read everything gets the same author text, not the
    // machine block — one body nobody has to reason about.
    expect(json).toMatchObject({
      body: 'Please review the check-in note.',
      changedFiles: 2,
      withheldFiles: 0,
    });
    expect(JSON.stringify(json)).not.toContain('Affected owners');
  });
});

describe('a file renamed out of a folder the caller may not read', () => {
  /**
   * Two files: one renamed out of a closed folder, one plainly readable. The
   * readable one keeps the REQUEST visible, so what this suite measures is the
   * rename's own treatment rather than the 404 that an all-withheld request
   * already gets (covered above).
   */
  function renameRequest(): void {
    readable = ['Knowledge/Open.md', 'Knowledge/Plain.md'];
    details.set(
      12,
      detail({
        files: [
          file('Knowledge/Open.md', { status: 'renamed', previousPath: 'Payroll/Rates.md' }),
          file('Knowledge/Plain.md'),
        ],
        approvals: [approval('Knowledge/Open.md'), approval('Knowledge/Plain.md')],
      }),
    );
  }

  it('is withheld whole, so `previousPath` can never name the closed path', async () => {
    const base = await start();
    renameRequest();
    const { json } = await call(base, 'list_change_request_files', {
      number: 12,
      include: ['patches'],
    });
    // `Knowledge/Open.md` is readable by its new name, but its diff shows what
    // was at `Payroll/Rates.md` — so it is withheld, counted, and neither of
    // its two names appears. The plainly readable file is unaffected.
    expect((json.files as unknown as { path: string }[]).map((f) => f.path)).toEqual([
      'Knowledge/Plain.md',
    ]);
    expect(json.withheldFiles).toBe(1);
    const whole = JSON.stringify(json);
    expect(whole).not.toContain('Payroll');
    expect(whole).not.toContain('Rates');
    expect(whole).not.toContain('Knowledge/Open.md');
  });

  it('is listed, with `previousPath`, once both of its names are readable', async () => {
    const base = await start();
    renameRequest();
    readable = ['Knowledge/Open.md', 'Knowledge/Plain.md', 'Payroll/Rates.md'];
    const { json } = await call(base, 'list_change_request_files', { number: 12 });
    expect(json.files).toHaveLength(2);
    expect(json.files[0]).toMatchObject({
      path: 'Knowledge/Open.md',
      previousPath: 'Payroll/Rates.md',
      // `open_change_request`'s word for it, from the same `changeKindOf`:
      // git's `renamed` and `copied` both read `moved`.
      change: 'moved',
    });
    expect(json.files[0]).not.toHaveProperty('status');
    expect(json.withheldFiles).toBe(0);
  });

  it('keeps a comment anchored to the withheld rename out of the comment list', async () => {
    const base = await start();
    renameRequest();
    details.set(
      12,
      detail({
        files: [
          file('Knowledge/Open.md', { status: 'renamed', previousPath: 'Payroll/Rates.md' }),
          file('Knowledge/Plain.md'),
        ],
        approvals: [approval('Knowledge/Open.md'), approval('Knowledge/Plain.md')],
        comments: [
          comment({ id: 'c-1', path: 'Knowledge/Plain.md', line: 4 }),
          comment({ id: 'c-2', path: 'Knowledge/Open.md', line: 9, body: 'Rate band looks off.' }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    // `Knowledge/Open.md` passes a bare read check — it is the file's new name —
    // but the file is withheld whole, so a comment on it is withheld too. Were
    // it kept, it would print the name the files tool refuses to print.
    expect((json.comments as unknown as { id: string }[]).map((c) => c.id)).toEqual(['c-1']);
    expect(json.withheldComments).toBe(1);
    const whole = JSON.stringify(json);
    expect(whole).not.toContain('Knowledge/Open.md');
    expect(whole).not.toContain('Payroll');
    expect(whole).not.toContain('Rate band');
  });

  it('keeps the withheld rename out of the files a review names, and counts it', async () => {
    const base = await start();
    renameRequest();
    details.set(
      12,
      detail({
        files: [
          file('Knowledge/Open.md', { status: 'renamed', previousPath: 'Payroll/Rates.md' }),
          file('Knowledge/Plain.md'),
        ],
        approvals: [
          approval('Knowledge/Open.md', {
            approvedBy: [approvedBy('ali@bevel.software', 'Ali', '2026-09-30T11:00:00.000Z')],
          }),
          approval('Knowledge/Plain.md', {
            approvedBy: [approvedBy('ali@bevel.software', 'Ali', '2026-09-30T09:00:00.000Z')],
          }),
        ],
      }),
    );
    const { json } = await call(base, 'list_change_request_reviews', { number: 12 });
    expect(json.reviews).toHaveLength(1);
    expect(json.reviews[0]).toMatchObject({
      reviewer: { name: 'Ali' },
      files: ['Knowledge/Plain.md'],
      withheldFiles: 1,
      // Taken from the readable approval alone — the later one is withheld.
      submittedAt: '2026-09-30T09:00:00.000Z',
    });
    const whole = JSON.stringify(json);
    expect(whole).not.toContain('Knowledge/Open.md');
    expect(whole).not.toContain('Payroll');
    expect(whole).not.toContain('11:00:00');
  });

  it('answers mayApprove false when the only approvable file is the withheld one', async () => {
    const base = await start();
    renameRequest();
    details.set(
      12,
      detail({
        files: [
          file('Knowledge/Open.md', { status: 'renamed', previousPath: 'Payroll/Rates.md' }),
          file('Knowledge/Plain.md'),
        ],
        // A write grant at `origin/<base>` can hold for a file the read verdict
        // withholds, so the request's whole approval set says the caller may
        // approve something — but not anything they are shown.
        approvals: [
          approval('Knowledge/Open.md', { viewerCanApprove: true }),
          approval('Knowledge/Plain.md', { viewerCanApprove: false }),
        ],
      }),
    );
    const first = await call(base, 'get_change_request', { number: 12 });
    expect(first.json).toMatchObject({ withheldFiles: 1 });
    expect((first.json as unknown as { viewer: { mayApprove: boolean } }).viewer.mayApprove).toBe(false);
    // Readable, and the answer turns true — the filter is the read verdict, not
    // a blanket false.
    readable = ['Knowledge/Open.md', 'Knowledge/Plain.md', 'Payroll/Rates.md'];
    const second = await call(base, 'get_change_request', { number: 12 });
    expect((second.json as unknown as { viewer: { mayApprove: boolean } }).viewer.mayApprove).toBe(true);
  });

  it('counts a withheld rename ONCE, though it goes by two names', async () => {
    const base = await start();
    readable = [];
    details.set(
      12,
      detail({
        files: [file('Knowledge/Open.md', { status: 'renamed', previousPath: 'Payroll/Rates.md' })],
        approvals: [approval('Knowledge/Open.md')],
      }),
    );
    callerEmail = AUTHOR;
    const { json } = await call(base, 'list_change_request_files', { number: 12 });
    expect(json.withheldFiles).toBe(1);
  });
});

/**
 * The contradiction Local Testing found on sha 45f18939: `list_change_requests`
 * advertised change request #3 to a caller for whom all four by-number tools
 * answered 404, and reported `withheldFiles: 0` where it was 1. The list judged
 * the flat `touchedNodePaths`, which names a rename by its new path alone.
 */
describe('the list and the by-number tools never disagree about a request', () => {
  const OLD = 'KnowledgeBase/Engineering/Knowledge/Avi-Checkin.md';
  const NEW = 'KnowledgeBase/GTM/Knowledge/Moved-From-Engineering.md';

  /**
   * CR#3 from the report: one file, renamed out of Engineering (which john
   * cannot read) into GTM (which he can). `touchedNodePaths` carries the new
   * path only — exactly as `changedPathsForPr` reports a detected rename.
   */
  function renamedOutOfReach(): ChangeRequest {
    return summary({
      number: 3,
      title: 'Local test: rename out of a folder john cannot read',
      touchedNodePaths: [NEW],
      touchedNodeFiles: [{ path: NEW, previousPath: OLD }],
    });
  }

  beforeEach(() => {
    readable = [NEW];
  });

  it('does not list a request whose every file the by-number tools withhold', async () => {
    const base = await start();
    const cr = renamedOutOfReach();
    summaries = [cr];
    details.set(3, detail({ ...cr, files: [file(NEW, { status: 'renamed', previousPath: OLD })] }));

    const listed = await call(base, 'list_change_requests', {});
    expect(listed.json.changeRequests).toEqual([]);
    expect(listed.json.totalCount).toBe(0);

    // ...and the four by-number tools agree, as they already did.
    for (const tool of TOOLS.filter((t) => t !== 'list_change_requests')) {
      const { status, json } = await call(base, tool, { number: 3 });
      expect(status, tool).toBe(404);
      expect(json.error, tool).toBe('Change request #3 not found.');
    }
  });

  it('names neither side of the rename in the list it does answer', async () => {
    const base = await start();
    summaries = [renamedOutOfReach(), summary({ number: 2, touchedNodePaths: [NEW] })];
    const { json } = await call(base, 'list_change_requests', {});
    // #2 touches the readable file plainly, so it is listed; #3 is not, and
    // nothing of it — not its title, not either of its paths — comes back.
    expect((json.changeRequests as unknown as { number: number }[]).map((c) => c.number)).toEqual([2]);
    const whole = JSON.stringify(json);
    expect(whole).not.toContain('Avi-Checkin');
    expect(whole).not.toContain('rename out of a folder');
  });

  it('counts the withheld rename as one file for its author, who may see it', async () => {
    const base = await start();
    callerEmail = AUTHOR;
    summaries = [renamedOutOfReach()];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.changeRequests).toHaveLength(1);
    // The author may SEE their request; they still may not read the file, and
    // the count says so — one file, not two, though it goes by two names.
    expect(json.changeRequests[0]).toMatchObject({ changedFiles: 0, withheldFiles: 1 });
    expect(JSON.stringify(json)).not.toContain('Avi-Checkin');
  });

  it('lists the request once both of the rename\'s names are readable', async () => {
    const base = await start();
    readable = [NEW, OLD];
    summaries = [renamedOutOfReach()];
    const { json } = await call(base, 'list_change_requests', {});
    expect(json.changeRequests).toHaveLength(1);
    expect(json.changeRequests[0]).toMatchObject({ changedFiles: 1, withheldFiles: 0 });
  });

  it('asks the access tree about both of a rename\'s names', async () => {
    const base = await start();
    summaries = [renamedOutOfReach()];
    callerEmail = AUTHOR;
    await call(base, 'list_change_requests', {});
    // One lookup for the target branch, carrying both paths — the old side is
    // what the previous implementation never asked about.
    const asked = calls.filter((c) => c[0] === 'canReadBatchAtRef');
    expect(asked).toHaveLength(1);
    expect(asked[0][2]).toBe('origin/main');
    expect(accessAskedFor).toEqual(expect.arrayContaining([NEW, OLD]));
  });

  /**
   * A summary from somewhere that never filled `touchedNodeFiles` proves
   * nothing, rather than silently falling back to the flat paths — the fallback
   * is what this whole class of bug was.
   */
  it('treats a summary with no paired files as proving no read access', async () => {
    const base = await start();
    const bare = summary({ number: 5 });
    delete bare.touchedNodeFiles;
    summaries = [bare];
    const strangers = await call(base, 'list_change_requests', {});
    expect(strangers.json.changeRequests).toEqual([]);

    callerEmail = AUTHOR;
    const mine = await call(base, 'list_change_requests', {});
    expect(mine.json.changeRequests).toHaveLength(1);
  });
});

/**
 * Scenario (Razvan's decision, 2026-10-02): a MERGED request's files are
 * recovered from its merge commit and filtered by access like an open one, so a
 * reviewer can read back what happened. A DECLINED one has no merge commit and
 * stays readable by its author alone.
 *
 * The recovery itself is the service's (`getPrDetail` of an applied request, and
 * `changedFilesAtCommit` under it, both tested there). What these pin is the part
 * the tools own: a merged request with a resolved file set is read like any
 * other — same access filter, same withholding, same 404 — and nothing about
 * being applied makes it either more or less visible.
 */
describe('reading a request that is no longer open', () => {
  const applied = (over: Partial<ChangeRequestDetail> = {}) =>
    detail({
      number: 20,
      state: 'merged',
      files: [file('KnowledgeBase/GTM/Notes.md'), file('Payroll/Rates.md')],
      mergeBlockedReasons: ['This pull request has already been merged.'],
      ...over,
    });

  it('shows a non-author the applied files they may read, withholding the rest', async () => {
    const base = await start();
    readable = ['KnowledgeBase/GTM/Notes.md'];
    const cr = applied();
    details.set(20, cr);
    summaries = [cr];

    const got = await call(base, 'get_change_request', { number: 20 });
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ state: 'merged', changedFiles: 1, withheldFiles: 1 });

    const files = await call(base, 'list_change_request_files', { number: 20 });
    expect((files.json.files as unknown as { path: string }[]).map((f) => f.path)).toEqual([
      'KnowledgeBase/GTM/Notes.md',
    ]);
    expect(files.json.withheldFiles).toBe(1);
    // Applied or not, the withheld file is never named.
    expect(JSON.stringify(files.json)).not.toContain('Payroll');
  });

  it('lists it under `state: closed`, which covers applied and declined alike', async () => {
    const base = await start();
    readable = ['KnowledgeBase/GTM/Notes.md'];
    summaries = [applied()];
    const { json } = await call(base, 'list_change_requests', { state: 'closed' });
    expect(calls).toContainEqual(['listChangeRequestsByState', ['closed', 'merged']]);
    expect(json.changeRequests).toHaveLength(1);
    // And the row says WHICH of the two it is, where GitHub would say `closed`.
    expect(json.changeRequests[0]).toMatchObject({
      number: 20,
      state: 'merged',
      changedFiles: 1,
      withheldFiles: 1,
    });
  });

  it('still answers 404 to a caller who may read none of the applied files', async () => {
    const base = await start();
    readable = [];
    summaries = [applied()];
    details.set(20, applied());
    expect((await call(base, 'get_change_request', { number: 20 })).status).toBe(404);
    expect((await call(base, 'list_change_requests', { state: 'all' })).json.changeRequests).toEqual([]);
  });

  // A declined request records no sha, so the service reads it from nothing and
  // resolves no files for it — and an empty file set proves no read access.
  //
  // That precondition is the SERVICE's to keep, and this test cannot check it:
  // it hands the tools a detail directly. It used to be false. Declining does
  // not retire the source branch, so `getPrDetail` resolved a declined request's
  // branch pair and published its files, while the list — which asks git nothing
  // about a declined row — hid the same request from the same caller. What the
  // tools are shown here is now what the service produces, pinned by
  // `PullRequestService.getPrDetail of a declined request whose branch still
  // resolves`. Deliberately not re-asserted in the tool layer: a second copy of
  // the rule is what let the two surfaces disagree in the first place.
  it('leaves a declined request, whose files cannot be resolved, to its author', async () => {
    const base = await start();
    const declined = detail({ number: 21, state: 'closed', files: [], approvals: [] });
    details.set(21, declined);
    summaries = [declined];
    expect((await call(base, 'get_change_request', { number: 21 })).status).toBe(404);
    expect((await call(base, 'list_change_requests', { state: 'closed' })).json.changeRequests).toEqual([]);

    callerEmail = AUTHOR;
    const mine = await call(base, 'get_change_request', { number: 21 });
    expect(mine.status).toBe(200);
    expect(mine.json).toMatchObject({ state: 'closed', changedFiles: 0, viewer: { isAuthor: true } });
  });
});

/**
 * Scenario (Razvan's review, 2026-10-02, finding 3): a reply is shown only when
 * the comment it replies to is.
 *
 * `post_change_request_comment` takes `parentId` without requiring `path`, so a
 * reply to a comment on a withheld file has no path of its own — and judged on
 * itself it looked like a general comment about the whole request. It came back
 * with its body and a `parentId` naming a comment the caller cannot see.
 */
describe('a reply is shown only when the comment it replies to is', () => {
  /** A request whose two files the caller can read one of. */
  function threadRequest(comments: ChangeRequestComment[]) {
    readable = ['Knowledge/Open.md'];
    details.set(
      12,
      detail({
        files: [file('Knowledge/Open.md'), file('Payroll/Rates.md')],
        approvals: [approval('Knowledge/Open.md'), approval('Payroll/Rates.md')],
        comments,
      }),
    );
  }

  it('withholds a pathless reply to a comment on a file the caller may not read', async () => {
    const base = await start();
    threadRequest([
      comment({ id: 'c-1', path: 'Payroll/Rates.md', line: 3, body: 'This band is wrong.' }),
      comment({ id: 'c-2', parentId: 'c-1', body: 'Agreed, the band moved in April.' }),
    ]);
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect(json.comments).toEqual([]);
    expect(json.withheldComments).toBe(2);
    const whole = JSON.stringify(json);
    // Neither the parent's path, nor the reply's body, nor the id it answers.
    expect(whole).not.toContain('Payroll');
    expect(whole).not.toContain('band moved');
    expect(whole).not.toContain('c-1');
  });

  it('withholds every reply down the thread, however deep it runs', async () => {
    const base = await start();
    threadRequest([
      comment({ id: 'c-1', path: 'Payroll/Rates.md', body: 'This band is wrong.' }),
      comment({ id: 'c-2', parentId: 'c-1', body: 'Which one?' }),
      comment({ id: 'c-3', parentId: 'c-2', body: 'The senior one.' }),
    ]);
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect(json.comments).toEqual([]);
    expect(json.withheldComments).toBe(3);
    expect(JSON.stringify(json)).not.toContain('senior');
  });

  it('keeps a thread on a file the caller may read, replies and all', async () => {
    const base = await start();
    threadRequest([
      comment({ id: 'c-1', path: 'Knowledge/Open.md', line: 4, body: 'Out of date.' }),
      comment({ id: 'c-2', parentId: 'c-1', body: 'Fixed.' }),
      comment({ id: 'c-3', parentId: 'c-2', body: 'Thanks.' }),
    ]);
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect((json.comments as unknown as { id: string }[]).map((c) => c.id)).toEqual([
      'c-1',
      'c-2',
      'c-3',
    ]);
    expect(json.withheldComments).toBe(0);
  });

  it('keeps a general comment and its replies — neither is about a file', async () => {
    const base = await start();
    threadRequest([
      comment({ id: 'c-1', body: 'Ready for review.' }),
      comment({ id: 'c-2', parentId: 'c-1', body: 'Looking now.' }),
    ]);
    const { json } = await call(base, 'list_change_request_comments', { number: 12 });
    expect(json.comments).toHaveLength(2);
    expect(json.withheldComments).toBe(0);
  });
});
