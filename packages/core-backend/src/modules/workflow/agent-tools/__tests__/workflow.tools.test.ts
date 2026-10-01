import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../../../tool-helpers/tool-context.js';
import { createToolHandlerFactory } from '../../../tool-helpers/tool-handler.js';
import { createManualRoutes } from '../../../tool-registry/manual.routes.js';
import { registerWorkflowTools } from '../workflow.tools.js';
import { OpenChangeRequestBlocksMergeError } from '../../../../shared/domain-errors.js';

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
    return { number: 7, url: 'https://bevel.example.com/change-requests/7' };
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
  getChangeRequestDetail: async (number: number) => ({
    number,
    url: `https://bevel.example.com/change-requests/${number}`,
    headSha: 'head-1',
    approvals: [],
    state: 'open',
    title: 'T',
    base: 'main',
  }),
  mergeChangeRequest: async (number: number) => {
    calls.push(['mergeChangeRequest', number]);
    return { kind: 'merged', result: { prNumber: number, sha: 'sha-1', mergedAt: '2026-09-17T00:00:00Z' } };
  },
  mergeBranch: async (user: { id: string }, source: string, target: string) => {
    calls.push(['mergeBranch', user.id, source, target]);
    if (source === 'me/conflicting') return { kind: 'conflicts-need-resolution', conflictedPaths: ['A.md'] };
    if (source === 'me/proposed') {
      throw new OpenChangeRequestBlocksMergeError(source, target, 12);
    }
    return { kind: 'merged', sha: 'merge-sha' };
  },
  postComment: async (number: number, _user: unknown, input: { path?: string }) => {
    calls.push(['postComment', number, input.path]);
    return { id: 'c-1' };
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
  registerWorkflowTools(registry, router, toolAuth, toolHandler, testKbContext());
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

  // A change request's files are repository-relative; the Copy path form
  // carries the clone folder, which is dropped so the comment lands on the file.
  it('post_change_request_comment anchors a copied workspace path to the repository-relative file', async () => {
    const base = await start();
    for (const path of ['/knowledge-base/KnowledgeBase/Foo.md', 'knowledge-base/KnowledgeBase/Foo.md', 'KnowledgeBase/Foo.md']) {
      const res = await post(`${base}/api/agent/tools/post_change_request_comment`, writeTok(), { number: 3, body: 'hi', path });
      expect(res.status, path).toBe(200);
    }
    expect(calls.filter((c) => c[0] === 'postComment')).toEqual([
      ['postComment', 3, 'KnowledgeBase/Foo.md'],
      ['postComment', 3, 'KnowledgeBase/Foo.md'],
      ['postComment', 3, 'KnowledgeBase/Foo.md'],
    ]);
  });

  // An agent hands the change request's link to a person, so the tools that
  // act on one by number return its `{ number, url }` beside their own payload.
  it('post_change_request_comment returns the change request link', async () => {
    const base = await start();
    const comment = await post(`${base}/api/agent/tools/post_change_request_comment`, writeTok(), { number: 3, body: 'hi' });
    expect(comment.status).toBe(200);
    const commentBody = await comment.json();
    expect(commentBody).toMatchObject({
      comment: { id: 'c-1' },
      changeRequest: { number: 3, url: 'https://bevel.example.com/change-requests/3' },
    });
    // A configured address yields an absolute link, so no note rides along.
    expect(commentBody.changeRequest).not.toHaveProperty('urlNote');
  });

  // An agent proposes and syncs; a person merges.
  describe('merging', () => {
    it('merge_change_request is gone: its old path answers who merges now, and never merges', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/merge_change_request`, writeTok(), { number: 4 });
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: string }).error).toMatch(/a change request is merged by a person in the app/);
      expect(calls.some((c) => c[0] === 'mergeChangeRequest')).toBe(false);
    });

    it('merge_branch merges as the caller and returns merged', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/merge_branch`, writeTok(), { source: 'target-company-state', target: 'me/draft' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: { kind: 'merged', sha: 'merge-sha' } });
      expect(calls).toContainEqual(['mergeBranch', 'user-A', 'target-company-state', 'me/draft']);
    });

    it('merge_branch returns conflicts-need-resolution with the conflicting paths', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/merge_branch`, writeTok(), { source: 'me/conflicting', target: 'me/draft' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: { kind: 'conflicts-need-resolution', conflictedPaths: ['A.md'] } });
    });

    it('merge_branch surfaces the open-request refusal, naming the request', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/merge_branch`, writeTok(), { source: 'me/proposed', target: 'target-company-state' });
      expect(res.status).toBe(409);
      const body = JSON.stringify(await res.json());
      expect(body).toContain('#12');
      expect(body).toMatch(/review #12 in the app/);
    });

    it('merge_branch requires both branches', async () => {
      const base = await start();
      expect((await post(`${base}/api/agent/tools/merge_branch`, writeTok(), { source: 'a' })).status).toBe(400);
      expect(calls.some((c) => c[0] === 'mergeBranch')).toBe(false);
    });

    it('no catalog offers merge_change_request or any approval tool; merge_branch documents the sync path', async () => {
      await start();
      for (const tools of [await registryRef!.listInternal(), await registryRef!.listExternal()]) {
        const names = tools.map((t) => t.name);
        expect(names).not.toContain('merge_change_request');
        expect(names).toContain('merge_branch');
        expect(names.filter((n) => /approv|bypass/i.test(n))).toEqual([]);
        for (const t of tools) {
          const inputs = JSON.stringify(t.inputs);
          expect(inputs, t.name).not.toMatch(/"(bypass|approve|unapprove)"/);
        }
        const mergeBranch = tools.find((t) => t.name === 'merge_branch')!;
        expect(mergeBranch.description).toMatch(/a person merges/);
        expect(mergeBranch.description).toMatch(/SYNC/);
      }
    });
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
    expect(await res.json()).toMatchObject({
      changeRequest: { number: 7, url: 'https://bevel.example.com/change-requests/7' },
    });
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

  /**
   * These tools address their workspace by ID — `workspaceIdForBranch(branch)`
   * straight from the argument — so they never pass the `getFilesystem` choke
   * point that guards the file tools. A branch-less call used to commit to a
   * workspace id that was literally the string "undefined" — and `create_branch`
   * used to fork from one, cloning a branch of that name and answering "There is
   * no branch named undefined." The guard sits on the mount and is keyed on
   * whether the tool's declared inputs REQUIRE `branch`, so it covers the
   * injected input and a tool's own alike, without any of them remembering it.
   */
  describe('a branch-less call to a tool that declares `branch`', () => {
    /**
     * Every tool whose DECLARED inputs require `branch`, read off the mounted
     * registry — not a list written by hand. The hand-written list is how the
     * gap that failed Local Testing stayed invisible: it named the three tools
     * that take the injected input and missed `create_branch`, whose `branch`
     * is its own (the fork base) and is just as required. Anything mounted
     * later is swept in without this file being touched.
     */
    const branchTakingTools = async (): Promise<string[]> =>
      (await registryRef!.listInternal())
        .filter((t) => {
          const body = (t.inputs as { properties?: { body?: { required?: string[] } } }).properties?.body;
          return (body?.required ?? []).includes('branch');
        })
        .map((t) => t.name);

    // The inputs each tool needs BESIDES `branch`, so the only thing wrong with
    // every call below is the missing branch.
    const bodyFor = (tool: string): Record<string, unknown> =>
      ({
        commit_change: { summary: 's' },
        save_file: { path: 'KnowledgeBase/x.md', content: 'c' },
        create_branch: { name: 'alice/new-draft' },
        write_file: { path: 'KnowledgeBase/x.md', content: 'c' },
      })[tool] ?? {};

    it('400s branch-required on every mounted tool that declares `branch`, and acts on nothing', async () => {
      const base = await start();
      const tools = await branchTakingTools();
      // Both kinds are in here: the injected input and a tool's own required
      // `branch`. `create_branch` is the one the reported bug survived on.
      expect(tools).toContain('commit_change');
      expect(tools).toContain('create_branch');
      expect(tools).toContain('switch_branch');

      for (const tool of tools) {
        const res = await post(`${base}/api/agent/tools/${tool}`, writeTok(), bodyFor(tool));

        expect(res.status, `${tool} must 400 on a branch-less call`).toBe(400);
        expect(await res.json(), `${tool} must answer the shared refusal`).toEqual({
          kind: 'branch-required',
          error: '`branch` is required: pass the branch (draft) you are working on.',
        });
      }
      // No workflow call was made at all — least of all one naming a workspace
      // id built out of the missing value, or a branch forked from it.
      expect(calls).toEqual([]);
    });

    /**
     * The exact shapes Local Testing drove over MCP against `create_branch`:
     * a missing branch answered 404 `There is no branch named undefined.`
     * (a clone of that "branch" was attempted), an empty one 500 'Invalid
     * workspace ID', and `["main"]` — which `encodeURIComponent` stringifies
     * straight back to `main` — answered 200 and really created and pushed a
     * branch off the default. All four are one refusal now.
     */
    it('refuses every absent shape on create_branch, and forks from nothing', async () => {
      const base = await start();
      const absent: Array<[string, Record<string, unknown>]> = [
        ['missing', { name: 'alice/new-draft' }],
        ['empty', { name: 'alice/new-draft', branch: '' }],
        ['null', { name: 'alice/new-draft', branch: null }],
        ['a number', { name: 'alice/new-draft', branch: 42 }],
        ['an array (stringifies to a real branch name)', { name: 'alice/new-draft', branch: ['main'] }],
        ['the literal "undefined"', { name: 'alice/new-draft', branch: 'undefined' }],
        ['the literal "null"', { name: 'alice/new-draft', branch: 'null' }],
      ];

      for (const [label, body] of absent) {
        const res = await post(`${base}/api/agent/tools/create_branch`, writeTok(), body);
        expect(res.status, `branch ${label} must 400`).toBe(400);
        const answered = await res.json();
        expect(answered.kind, `branch ${label} must answer branch-required`).toBe('branch-required');
        expect(JSON.stringify(answered), `branch ${label} must not echo an absent value`).not.toContain('undefined');
      }
      // Nothing was forked, from any workspace id.
      expect(calls).toEqual([]);
    });

    /**
     * `create_branch` compares `branch` (the fork base) to `name` and refuses
     * the two being equal, QUOTING the name. A call that sent neither compared
     * undefined to undefined, matched, and answered "not 'undefined', the draft
     * being created" — an absent value presented as a draft name. `name` is
     * refused by name instead, so no such sentence can be produced.
     */
    it('refuses a missing `name` without quoting it back', async () => {
      const base = await start();

      const res = await post(`${base}/api/agent/tools/create_branch`, writeTok(), { branch: 'main' });

      expect(res.status).toBe(400);
      const answered = await res.json();
      expect(answered).toEqual({ kind: 'name-required', error: '`name` is required: pass the name of the draft to create.' });
      expect(JSON.stringify(answered)).not.toContain('undefined');
      expect(calls).toEqual([]);
    });

    it('still forks from a named base once both inputs are given', async () => {
      const base = await start();
      // The guards refuse absent inputs, not the tool.
      const res = await post(`${base}/api/agent/tools/create_branch`, writeTok(), { name: 'alice/new-draft', branch: 'main' });

      expect(res.status).toBe(200);
      expect(calls).toContainEqual(['createBranch', 'main', 'alice/new-draft']);
    });

    it('refuses the stringified absent values the same way', async () => {
      const base = await start();
      for (const literal of ['undefined', 'null']) {
        const res = await post(`${base}/api/agent/tools/commit_change`, writeTok(), { summary: 's', branch: literal });
        expect(res.status, `branch "${literal}" must 400`).toBe(400);
        expect((await res.json()).kind).toBe('branch-required');
      }
      expect(calls).toEqual([]);
    });

    it('leaves a tool that declares no `branch` alone', async () => {
      const base = await start();
      // `list_branches` is repo-global and deliberately takes no branch: the
      // guard must not start demanding one from the tools that opted out.
      expect((await post(`${base}/api/agent/tools/list_branches`, writeTok(), {})).status).toBe(200);
    });
  });

  it('works under a connection key too (both surface)', async () => {
    const base = await start();
    // `branch` is named because every caller must name it — this test is about
    // the connection-key SURFACE, and an external key is precisely the caller
    // that carries no focused branch to fall back on.
    expect((await post(`${base}/api/agent/tools/commit_change`, 'bevel_key', { summary: 's', branch: WS })).status).toBe(200);
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
  // clone-folder prefix used to be refused here; the one normaliser PLACES it
  // inside the clone now, so the lock is taken on the repository path — the
  // file git can actually see — and the refusal is kept for the spellings no
  // prefix can rescue.
  it('places a repo-relative path inside the clone and locks THAT path', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: 'KnowledgeBase/Reviews/PR-12.html',
      branch: WS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true });
    expect(calls).toContainEqual(['acquireLock', WS, WS, 'knowledge-base/KnowledgeBase/Reviews/PR-12.html']);
  });

  it('still refuses a traversing path before taking any lock', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: 'KnowledgeBase/../../etc/passwd',
      branch: WS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('outside the knowledge base repository');
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

  it('accepts the root-anchored form Copy path gives, as the same path', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: '/knowledge-base/KnowledgeBase/Reviews/PR-12.html',
      branch: WS,
    });
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(['acquireLock', WS, WS, 'knowledge-base/KnowledgeBase/Reviews/PR-12.html']);
  });

  it('still refuses a slash-led path outside the repository', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/save_file`, writeTok(), {
      path: '/KnowledgeBase/Reviews/PR-12.html',
      branch: WS,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('outside the knowledge base repository');
    expect(calls.some((c) => c[0] === 'acquireLock')).toBe(false);
  });

  it('describes the prefix on its path input', async () => {
    await start();
    const tools = await registryRef!.listInternal();
    const def = tools.find((t) => t.name === 'save_file');
    // `toolDef` wraps a tool's inputs under a single `body` property.
    const body = (def!.inputs as { properties: { body: { properties: Record<string, { description?: string }> } } }).properties.body;
    expect(body.properties.path.description).toContain('`knowledge-base/`');
    expect(body.properties.path.description).toContain('with or without a leading slash');
  });
});
