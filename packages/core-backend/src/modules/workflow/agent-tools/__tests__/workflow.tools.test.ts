import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../../tool-helpers/tool-handler.js';
import { createManualRoutes } from '../../../tool-registry/manual.routes.js';
import { registerWorkflowTools } from '../workflow.tools.js';

const WS = 'target-company-state';

let calls: unknown[][] = [];
const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_key' ? { user: { id: 'user-A', email: 'e@x', name: 'N' }, tokenId: 'tok' } : null,
} as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: WS }),
  getWorkspacePath: async () => '/tmp/ws',
  getOrCreateForBranch: async (b: string) => ({ id: b }),
  // Repo-global tools resolve any existing clone instead of cloning a named branch.
  findAnyWorkspaceId: async () => 'existing-ws',
} as never;
const workflowService = {
  listBranches: async (ws: string) => {
    calls.push(['listBranches', ws]);
    return [{ name: 'main', isProtected: true }];
  },
  commitChange: async (ws: string, user: { id: string }, body: unknown) => {
    calls.push(['commitChange', ws, user.id, body]);
    return { id: 'change-1', ...(body as object) };
  },
  openChangeRequest: async (ws: string, user: { id: string }, body: unknown) => {
    calls.push(['openChangeRequest', ws, user.id, body]);
    return { number: 7, url: 'http://cr/7' };
  },
  createBranch: async (ws: string, name: string) => {
    calls.push(['createBranch', ws, name]);
    return { name, isProtected: false, ahead: 0, behind: 0, hasRemote: true };
  },
  acquireLock: async (ws: string, branch: string, path: string) => {
    calls.push(['acquireLock', ws, branch, path]);
    return { acquired: true, lock: { branch, path, holderUserId: 'user-A', holderName: 'N' } };
  },
  releaseLock: async (ws: string, branch: string, path: string) => {
    calls.push(['releaseLock', ws, branch, path]);
  },
} as never;
const events = {
  emit: (p: unknown) => {
    calls.push(['emit', p]);
    return {};
  },
} as never;

const internalToken = new InternalTokenService({ secret: 's' });
let httpServer: HttpServer | undefined;
/** The registry the tools were mounted into, so a test can inspect their definitions. */
let registryRef: ToolRegistry | undefined;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  registryRef = registry;
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({ authService, workspaceService, workflowService, events, kbDirName: 'knowledge-base', creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} } });
  const toolHandler = createToolHandlerFactory(resolve);

  const router = express.Router();
  registerWorkflowTools(registry, router, toolAuth, toolHandler, 'knowledge-base');
  router.use(createManualRoutes(registry, toolAuth));

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const post = (url: string, bearer: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });

beforeEach(() => {
  calls = [];
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

const writeTok = () => internalToken.mint({ userId: 'user-A' });

describe('registerWorkflowTools', () => {
  it('commit_change commits as the context user + workspace', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/commit_change`, writeTok(), { summary: 'fix typo', branch: WS });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ change: { id: 'change-1', summary: 'fix typo' } });
    expect(calls).toContainEqual(['commitChange', WS, 'user-A', { summary: 'fix typo', description: undefined }]);
  });

  it('list_branches takes no branch and lists from any existing clone (repo-global)', async () => {
    const base = await start();
    // No `branch` in the body — the tool is repo-global. It must NOT try to
    // resolve/clone a model-named branch (the `-b <branch>` clone-failure bug).
    const res = await post(`${base}/api/agent/tools/list_branches`, writeTok(), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ branches: [{ name: 'main' }] });
    expect(calls).toContainEqual(['listBranches', 'existing-ws']);
  });

  it('open_change_request returns the CR detail', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/open_change_request`, writeTok(), {
      sourceBranch: 'me/draft',
      targetBranch: 'target-company-state',
      title: 'My change',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changeRequest: { number: 7 } });
    // The workspace must be derived from the SOURCE branch (not a separate
    // `branch` arg) — encodeURIComponent('me/draft'). Regression guard for the
    // `-b undefined` clone bug when the model omitted `branch`.
    expect(calls).toContainEqual([
      'openChangeRequest',
      'me%2Fdraft',
      'user-A',
      { sourceBranch: 'me/draft', targetBranch: 'target-company-state', title: 'My change', description: undefined },
    ]);
  });

  it('create_branch forks in the BASE branch\'s workspace, never the new draft\'s', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/create_branch`, writeTok(), {
      name: 'me/new-draft',
      branch: WS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ branch: { name: 'me/new-draft' } });
    // Workspace derived from the existing base `branch`, not the
    // not-yet-existing `name` — resolving `name`'s workspace lazily clones it
    // and 500s with "Remote branch not found in upstream origin". No fromBase:
    // the base is the workspace's own checked-out branch (HEAD).
    expect(calls).toContainEqual(['createBranch', WS, 'me/new-draft']);
  });

  it('create_branch rejects `branch` naming the draft being created with a 400, not a clone 500', async () => {
    const base = await start();
    // The exact reported failure: the caller filled `branch` with the draft
    // being created instead of the base to fork from.
    const res = await post(`${base}/api/agent/tools/create_branch`, writeTok(), {
      name: 'me/new-draft',
      branch: 'me/new-draft',
    });
    expect(res.status).toBe(400);
    expect(calls.filter((c) => c[0] === 'createBranch')).toHaveLength(0);
  });

  it('works under a connection key too (both surface)', async () => {
    const base = await start();
    expect((await post(`${base}/api/agent/tools/commit_change`, 'bevel_key', { summary: 's' })).status).toBe(200);
  });

  it('switch_branch validates + pre-warms + emits a user-scoped event (internal-only)', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/switch_branch`, writeTok(), { branch: 'main' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switched: true, branch: 'main' });
    expect(calls).toContainEqual([
      'emit',
      expect.objectContaining({ kind: 'branch-switched', forUserId: 'user-A', branch: 'main' }),
    ]);
    // unknown draft → 404
    expect((await post(`${base}/api/agent/tools/switch_branch`, writeTok(), { branch: 'nope' })).status).toBe(404);
  });

  it('refuses switch_branch to an external connection key — internal-only is enforced at the route, not just hidden', async () => {
    const base = await start();
    // `bevel_key` authenticates as an external caller; the internal-only route
    // must reject it (403) even though it knows the tool name.
    expect((await post(`${base}/api/agent/tools/switch_branch`, 'bevel_key', { branch: 'main' })).status).toBe(403);
  });

  it('registers workflow tools into the right catalogs (switch_branch internal-only)', async () => {
    const base = await start();
    const fetchManual = async (which: 'utcp' | 'internal/utcp') =>
      ((await (await fetch(`${base}/api/agent/${which}`, { headers: { authorization: `Bearer ${writeTok()}` } })).json()) as { tools: { name: string }[] }).tools
        .map((t) => t.name)
        .sort();
    const internal = await fetchManual('internal/utcp');
    const external = await fetchManual('utcp');
    expect(internal).toContain('switch_branch');
    expect(internal).toContain('commit_change');
    expect(external).toContain('commit_change');
    expect(external).not.toContain('switch_branch'); // internal-only
  });
});

describe('save_file and the repository folder', () => {
  // `save_file` commits whatever is on disk at `path` through the lock
  // protocol, bypassing the locking filesystem's own guard. A path without the
  // clone-folder prefix names a file git can never see, so it is refused here,
  // before a lock is taken, with the same corrected-path message the write
  // tools give.
  it('refuses a repo-relative path before taking any lock', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: 'KnowledgeBase/Reviews/PR-12.html',
      branch: WS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"knowledge-base/KnowledgeBase/Reviews/PR-12.html"');
    expect(calls.some((c) => c[0] === 'acquireLock')).toBe(false);
  });

  it('answers a missing path with a 400, not a crash', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), { branch: WS });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/path/i);
    expect(calls.some((c) => c[0] === 'acquireLock')).toBe(false);
  });

  it('schedules a prefixed path as before', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: 'knowledge-base/KnowledgeBase/Reviews/PR-12.html',
      branch: WS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true, queued: true });
    expect(calls).toContainEqual(['acquireLock', WS, WS, 'knowledge-base/KnowledgeBase/Reviews/PR-12.html']);
    expect(calls).toContainEqual(['releaseLock', WS, WS, 'knowledge-base/KnowledgeBase/Reviews/PR-12.html']);
  });

  it('describes the prefix on its path input', async () => {
    await start();
    const tools = await registryRef!.listInternal();
    const def = tools.find((t) => t.name === 'save_file');
    // `toolDef` wraps a tool's inputs under a single `body` property.
    const body = (def!.inputs as { properties: { body: { properties: Record<string, { description?: string }> } } }).properties.body;
    expect(body.properties.path.description).toContain('`knowledge-base/`');
  });
});
