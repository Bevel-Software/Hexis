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
import { ToolError } from '../../../tool-helpers/tool.contract.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { ToolDescriptionNotes, type AgentAccessGate } from '../../../workspace/agent-access.gate.js';
import { registerWorkflowTools } from '../workflow.tools.js';
import {
  BranchAuthorshipError,
  BranchDeleteBlockedError,
  BranchNotFoundError,
  ChangeRequestConflictsError,
  OpenChangeRequestBlocksMergeError,
} from '../../../../shared/domain-errors.js';

const WS = 'target-company-state';

/**
 * One file of a change-request detail as the service returns it: a 15 KB
 * addition, patch included. The reported failure was 27 of these — the detail
 * answered ~445,000 characters and overflowed the agent's tool-result limit.
 */
function addedFile(i: number): Record<string, unknown> {
  const path = `KnowledgeBase/Engineering/Knowledge/Hexis/Generated-Node-${i}.md`;
  return {
    path,
    status: 'added',
    additions: 400,
    deletions: 0,
    // 400 × 37 characters ≈ 15 KB, as reported.
    patch: `@@ -0,0 +1,400 @@\n${'+a line of generated knowledge text\n'.repeat(400)}`,
    isBinary: false,
    sha: `blob-${i}`,
    rawUrl: `https://raw.example.com/blob-${i}`,
  };
}

/** The per-file approval state the detail carries, as the app's dialog reads it. */
function approvalOf(path: string): Record<string, unknown> {
  return {
    path,
    eligibleApprovers: {
      roles: ['Admin', 'Engineering'],
      users: [{ name: 'Razvan Radulescu', email: 'razvan.radulescu@bevel.software' }],
    },
    approvedBy: [],
    eligibilityResolved: true,
    isApproved: false,
    inMergeGate: true,
    viewerCanApprove: true,
  };
}

/** A full change-request detail over the given files — what `openChangeRequest` answers. */
function detailOf(files: Record<string, unknown>[]): Record<string, unknown> {
  return {
    number: 7,
    url: 'https://bevel.example.com/change-requests/7',
    title: 'My change',
    state: 'open',
    branch: 'me/draft',
    base: 'target-company-state',
    body: 'Body shown verbatim to reviewers.',
    author: { login: 'bevel-bot' },
    headSha: 'head-1',
    baseSha: 'base-1',
    files,
    comments: [],
    approvals: files.map((f) => approvalOf(f.path as string)),
    mergeableInBevel: false,
    mergeBlockedReasons: files.map((f) => `${f.path as string} is not approved`),
    mergeWarnings: files.map((f) => `${f.path as string} is not approved`),
  };
}

/** The reported case: 27 new files of 15 KB each. */
const BIG = () => detailOf(Array.from({ length: 27 }, (_, i) => addedFile(i)));

let calls: unknown[][] = [];
/** What the service answers `openChangeRequest` with; a test replaces it. */
let opened: Record<string, unknown> = BIG();
/** Set to make `openChangeRequest` throw instead. */
let openFails: Error | undefined;
const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_key' ? { user: { id: 'user-A', email: 'e@x', name: 'N' }, tokenId: 'tok' } : null,
} as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
/** A declined change request: no sha records what it proposed, so it has no head. */
const DECLINED_CR = 21;

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
    if (openFails) throw openFails;
    return opened;
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
  // #21 is DECLINED: the service reads such a row from nothing (no sha records
  // what it proposed), so its detail carries no head — which is what the comment
  // tool has to anchor to. Every other number is an ordinary open request.
  getChangeRequestDetail: async (number: number) => ({
    number,
    url: `https://bevel.example.com/change-requests/${number}`,
    headSha: number === DECLINED_CR ? '' : 'head-1',
    approvals: [],
    state: number === DECLINED_CR ? 'closed' : 'open',
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
  deleteBranchChecked: async (
    user: { id: string },
    name: string,
    { maySee, ...opts }: { dryRun?: boolean; discardUnmerged?: boolean; maySee?: (n: number) => Promise<boolean> },
  ) => {
    calls.push(['deleteBranchChecked', user.id, name, opts]);
    if (maySee) calls.push(['maySee', 12, await maySee(12)], ['maySee', 13, await maySee(13)]);
    if (name === 'me/missing') throw new BranchNotFoundError(name);
    if (name === 'ali/theirs') throw new BranchAuthorshipError(name);
    if (name === 'me/proposed') {
      throw new BranchDeleteBlockedError(
        'open-change-request',
        name,
        'Change request #12 is open from "me/proposed". Ask the user to withdraw or decline it in the app; then the branch can be deleted.',
        { number: 12 },
      );
    }
    if (name === 'me/unmerged' && !(opts as { discardUnmerged?: boolean }).discardUnmerged) {
      throw new BranchDeleteBlockedError('unmerged-commits', name, '"me/unmerged" holds 3 commits…', { unmergedCommits: 3 });
    }
    if (name === 'me/offline') {
      throw new BranchDeleteBlockedError('state-unconfirmed', name, 'Could not reach the shared repository…');
    }
    if ((opts as { dryRun?: boolean }).dryRun) {
      return { kind: 'preview', branch: name, exists: true, canDelete: true, refusals: [], unmergedCommits: 0, openChangeRequests: [], lastCommit: 'tip-1' };
    }
    return { kind: 'deleted', branch: name, lastCommit: 'tip-1', discardedCommits: name === 'me/unmerged' ? 3 : 0 };
  },
  postComment: async (number: number, _user: unknown, input: { path?: string }) => {
    calls.push(['postComment', number, input.path]);
    return { id: 'c-1' };
  },
  // The history and syncing reads, answered from a fixed script.
  listChangesForFile: async (ws: string, path: string, limit?: number) => {
    calls.push(['listChangesForFile', ws, path, limit]);
    return [{ sha: 'abc1234', authorName: 'Ada', authorEmail: 'ada@x.io', subject: 'edit', committedAt: '2026-10-16T00:00:00Z' }];
  },
  fileAtChange: async (ws: string, path: string, sha: string) => {
    calls.push(['fileAtChange', ws, path, sha]);
    return { baseline: 'before\n', current: 'after\n' };
  },
  fileAtBranch: async (ws: string, path: string, branch: string, authorize?: (commits: string[]) => Promise<void>) => {
    calls.push(['fileAtBranch', ws, path, branch]);
    // As the service: the verdict at every commit the branch resolves to,
    // before anything about the path there. `me/moved` is a branch whose
    // local head has moved past its published tip: two commits.
    await authorize?.(branch === 'me/moved' ? ['tip-of-me/moved', 'local-of-me/moved'] : ['tip-of-' + branch]);
    return { sha: 'tip-of-' + branch, ref: `refs/remotes/origin/${branch}`, content: `on ${branch}\n` };
  },
  showFileAtChange: async (ws: string, path: string, sha: string) => {
    calls.push(['showFileAtChange', ws, path, sha]);
    return '@@ patch of ' + sha;
  },
  compareFile: async (ws: string, path: string, from: string, to: string, authorize?: (s: { from: string[]; to: string[] }) => Promise<void>) => {
    calls.push(['compareFile', ws, path, from, to]);
    const commitsOf = (b: string) => (b === 'me/moved' ? ['tip-of-me/moved', 'local-of-me/moved'] : ['tip-of-' + b]);
    await authorize?.({ from: commitsOf(from), to: commitsOf(to) });
    return { diff: `@@ ${from}..${to}`, from: 'tip-of-' + from, to: 'tip-of-' + to };
  },
  branchStatus: async (ws: string) => {
    calls.push(['branchStatus', ws]);
    return { branch: ws, hasUpstream: true, unmergedFromUpstream: true };
  },
  listPendingChangePaths: async (ws: string) => {
    calls.push(['listPendingChangePaths', ws]);
    return ['knowledge-base/KnowledgeBase/Pending.md'];
  },
  resolveForkBase: async (ws: string, branch: string) => {
    calls.push(['resolveForkBase', ws, branch]);
    return 'main';
  },
  changedPathsBetweenBranches: async (ws: string, base: string, branch: string) => {
    calls.push(['changedPathsBetweenBranches', ws, base, branch]);
    return ['KnowledgeBase/Changed.md'];
  },
  updateBranch: async (
    ws: string,
    user: { id: string },
    opts: { from?: string; resolutions?: { path: string; content?: string }[]; validateWrite?: (wsPath: string, content: string) => Promise<void> },
  ) => {
    calls.push(['updateBranch', ws, user.id, opts]);
    // As the service: the caller's write gate is asked for every resolution that brings content.
    for (const r of opts.resolutions ?? []) if (r.content !== undefined && opts.validateWrite) await opts.validateWrite(`knowledge-base/${r.path}`, r.content);
    if (opts.from === 'me/conflicting' && opts.resolutions?.length) {
      return { kind: 'merged', sha: 'resolved-sha', from: 'me/conflicting', resolvedPaths: opts.resolutions.map((r) => r.path) };
    }
    if (opts.from === 'me/conflicting') {
      return {
        kind: 'conflicts',
        from: 'me/conflicting',
        mergeBase: 'b',
        ours: 'o',
        theirs: 't',
        unresolved: ['KnowledgeBase/Open.md', 'Secret/Plan.md'],
        files: [
          { path: 'KnowledgeBase/Open.md', base: 'b\n', ours: 'o\n', theirs: 't\n', merged: '<<<<<<<\n' },
          { path: 'Secret/Plan.md', base: 'b\n', ours: 'o\n', theirs: 't\n', merged: '<<<<<<<\n' },
        ],
      };
    }
    return { kind: 'merged', sha: 'merge-sha', from: 'main', resolvedPaths: [] };
  },
} as never;
const events = {
  emit: (p: unknown) => {
    calls.push(['emit', p]);
    return {};
  },
} as never;
/**
 * The per-file read gate the history tools take. `Secret/` is readable by
 * nobody on any branch; `me/hidden` is a branch whose refs grant nothing;
 * `me/unknown` a branch none of whose refs resolve.
 */
const accessControl = {
  canRead: async (ws: string, email: string, rel: string) => {
    calls.push(['canRead', ws, email, rel]);
    return !rel.startsWith('Secret/');
  },
  canReadAtRef: async (ws: string, ref: string, email: string, rel: string) => {
    calls.push(['canReadAtRef', ws, ref, email, rel]);
    if (ref.endsWith('me/unknown')) return null;
    if (ref.endsWith('me/hidden')) return false;
    // `me/moved`: its published tip grants, its local head (past it) denies.
    if (ref === 'local-of-me/moved') return false;
    return !rel.startsWith('Secret/');
  },
  canReadBatch: async (ws: string, email: string, rels: string[]) => {
    calls.push(['canReadBatch', ws, email, rels]);
    return new Map(rels.map((r) => [r, !r.startsWith('Secret/')]));
  },
  canReadBatchAtRef: async (ws: string, ref: string, email: string, rels: string[]) => {
    calls.push(['canReadBatchAtRef', ws, ref, email, rels]);
    if (ref.endsWith('me/unknown')) return null;
    return new Map(rels.map((r) => [r, !r.startsWith('Secret/')]));
  },
  canWrite: async (ws: string, email: string, rel: string) => {
    calls.push(['canWrite', ws, email, rel]);
    return !rel.startsWith('ReadOnly/');
  },
} as never;
/**
 * The deployment's hooks: the read hook refuses `Hooked/`, fails outright on
 * `Failing/` and records every read it is told of (with the session it was
 * told for); the write hook refuses `Locked/`.
 */
const agentHooks = new WorkflowHooks();
agentHooks.onAgentRead(async (op) => {
  calls.push(['agentRead', op.branch, op.wsPath, op.sessionId]);
  if (op.wsPath?.includes('Hooked/')) throw new ToolError('Not in this conversation.', 403);
  if (op.wsPath?.includes('Failing/')) throw new Error('hook store down');
});
agentHooks.onPreWrite(async (op) => {
  calls.push(['preWrite', op.branch, op.wsPath]);
  if (op.wsPath?.includes('Locked/')) throw new ToolError('Not yours to write here.', 403);
});
const agentAccessGate: AgentAccessGate = { recoveryBotEmail: 'recovery@x', hooks: agentHooks, notes: new ToolDescriptionNotes() };

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
  // Request #13 is one the caller may not see.
  registerWorkflowTools(
    registry,
    router,
    toolAuth,
    toolHandler,
    testKbContext(),
    async (ctx, number) => {
      calls.push(['maySeeAs', ctx.user.id, number]);
      return number !== 13;
    },
    accessControl,
    agentAccessGate,
  );
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
  opened = BIG();
  openFails = undefined;
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

  // A comment anchors to a commit. A declined request records none — nothing
  // durable says what it proposed, so it is read from nothing and its detail
  // carries no head. Say so, rather than letting the service's `head sha is
  // required` come back as a 400 about an argument the caller never passed.
  it('post_change_request_comment says why a declined request takes no comment', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/post_change_request_comment`, writeTok(), { number: DECLINED_CR, body: 'why was this turned down?' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      new RegExp(`#${DECLINED_CR} is closed and has no commit to anchor a comment to`),
    );
    // Nothing was written: the refusal happens before the service is asked.
    expect(calls.some((c) => c[0] === 'postComment')).toBe(false);
  });

  describe('delete_branch', () => {
    it('is on both catalogs, takes name, dryRun and discardUnmerged, and is a write tool', async () => {
      await start();
      for (const tools of [await registryRef!.listInternal(), await registryRef!.listExternal()]) {
        const tool = tools.find((t) => t.name === 'delete_branch');
        expect(tool).toBeDefined();
        // `toolDef` wraps a tool's own inputs under `body`.
        const inputs = (tool!.inputs as { properties: { body: { properties: Record<string, unknown>; required: string[] } } })
          .properties.body;
        expect(Object.keys(inputs.properties).sort()).toEqual(['discardUnmerged', 'dryRun', 'name']);
        expect(inputs.required).toEqual(['name']);
        expect(tool!.tags).toContain('write');
        // An empty request is closed by the delete; a live one refuses it, linked.
        expect(tool!.description).toContain('proposes nothing is closed');
        expect(tool!.description).toContain('its author withdraws it or an Admin declines it');
      }
    });

    it('deletes as the caller and answers the last commit', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/delete_branch`, writeTok(), { name: 'me/draft' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ kind: 'deleted', branch: 'me/draft', lastCommit: 'tip-1', discardedCommits: 0 });
      expect(calls).toContainEqual(['deleteBranchChecked', 'user-A', 'me/draft', { dryRun: false, discardUnmerged: false }]);
    });

    it('passes dryRun and discardUnmerged through', async () => {
      const base = await start();
      const preview = await post(`${base}/api/agent/tools/delete_branch`, writeTok(), { name: 'me/draft', dryRun: true });
      expect(await preview.json()).toMatchObject({ kind: 'preview', canDelete: true, lastCommit: 'tip-1' });
      const discarded = await post(`${base}/api/agent/tools/delete_branch`, writeTok(), { name: 'me/unmerged', discardUnmerged: true });
      expect(await discarded.json()).toMatchObject({ kind: 'deleted', discardedCommits: 3 });
      expect(calls).toContainEqual(['deleteBranchChecked', 'user-A', 'me/draft', { dryRun: true, discardUnmerged: false }]);
      expect(calls).toContainEqual(['deleteBranchChecked', 'user-A', 'me/unmerged', { dryRun: false, discardUnmerged: true }]);
    });

    it('answers each refusal with its status and message', async () => {
      const base = await start();
      const ask = async (name: string) => {
        const res = await post(`${base}/api/agent/tools/delete_branch`, writeTok(), { name });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      const missing = await ask('me/missing');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toMatch(/no branch named me\/missing/);
      const theirs = await ask('ali/theirs');
      expect(theirs.status).toBe(403);
      expect(theirs.body.error).toBe('Only the author of "ali/theirs" can delete it.');
      const proposed = await ask('me/proposed');
      expect(proposed.status).toBe(409);
      expect(proposed.body).toMatchObject({ reason: 'open-change-request', number: 12 });
      expect(proposed.body.error).toMatch(/#12.*withdraw or decline it in the app/);
      const unmerged = await ask('me/unmerged');
      expect(unmerged.status).toBe(409);
      expect(unmerged.body).toMatchObject({ reason: 'unmerged-commits', unmergedCommits: 3 });
      expect((await ask('me/offline')).status).toBe(503);
    });

    it('requires a name', async () => {
      const base = await start();
      const res = await post(`${base}/api/agent/tools/delete_branch`, writeTok(), {});
      expect(res.status).toBe(400);
      expect(calls.some((c) => c[0] === 'deleteBranchChecked')).toBe(false);
    });

    it("hands the service the caller's view of change requests, as get_change_request gates it", async () => {
      const base = await start();
      await post(`${base}/api/agent/tools/delete_branch`, writeTok(), { name: 'me/draft', dryRun: true });
      expect(calls).toContainEqual(['maySeeAs', 'user-A', 12]);
      expect(calls).toContainEqual(['maySee', 12, true]);
      expect(calls).toContainEqual(['maySee', 13, false]);
    });
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
        // Every outcome is named, and the asynchronous commit the merge waits for.
        for (const kind of ['merged', 'nothing-to-merge', 'pending-commits', 'conflicts-need-resolution']) {
          expect(mergeBranch.description, kind).toContain(`\`${kind}\``);
        }
        expect(mergeBranch.description).toMatch(/committed asynchronously/);
        expect(mergeBranch.description).toMatch(/waits up to 20s/);
        const outcome = (mergeBranch.outputs as { properties: { outcome: { description: string; properties: Record<string, { enum?: string[] }> } } })
          .properties.outcome;
        expect(outcome.properties.kind.enum).toEqual(['merged', 'nothing-to-merge', 'pending-commits', 'conflicts-need-resolution']);
        expect(Object.keys(outcome.properties)).toEqual(
          expect.arrayContaining(['sha', 'conflictedPaths', 'branch', 'pending', 'needsAttention', 'message']),
        );
        expect(outcome.description).toMatch(/committed asynchronously and the merge waits/);
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

  it('open_change_request acts on the SOURCE branch\'s workspace', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/open_change_request`, writeTok(), {
      sourceBranch: 'me/draft',
      targetBranch: 'target-company-state',
      title: 'My change',
    });
    expect(res.status).toBe(200);
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

  /**
   * One test per Scenario of the Specification
   * (`hx-change-request-answer-is-small-spec`). The reported failure: opening a
   * request for 27 files answered ~445,000 characters, because the answer was
   * the detail the app's dialog reads, every patch included. It overflowed the
   * tool-result limit, so the agent could not even read the link.
   */
  describe('what open_change_request answers', () => {
    const open = async (base: string, include?: string[]) => {
      const res = await post(`${base}/api/agent/tools/open_change_request`, writeTok(), {
        sourceBranch: 'me/draft',
        targetBranch: 'target-company-state',
        title: 'My change',
        ...(include ? { include } : {}),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };

    it('answers a summary for 27 new files: the link first, 25 paths of 27, approvers, blockers, no patch', async () => {
      const base = await start();
      const body = await open(base);

      // The link is the FIRST field: the one thing the agent must hand the
      // user, so it survives a truncation of anything after it.
      expect(Object.keys(body)[0]).toBe('url');
      expect(body).toMatchObject({
        url: 'https://bevel.example.com/change-requests/7',
        number: 7,
        title: 'My change',
        state: 'open',
        sourceBranch: 'me/draft',
        targetBranch: 'target-company-state',
        totalFiles: 27,
      });

      const files = body.files as { path: string; change: string }[];
      expect(files).toHaveLength(25);
      expect(new Set(files.map((f) => f.change))).toEqual(new Set(['added']));
      expect(files[0].path).toBe('KnowledgeBase/Engineering/Knowledge/Hexis/Generated-Node-0.md');

      // Who must approve, per path — what Juan found useful and must stay.
      expect(body.approvals).toHaveLength(25);
      expect((body.approvals as unknown[])[0]).toEqual({
        path: 'KnowledgeBase/Engineering/Knowledge/Hexis/Generated-Node-0.md',
        roles: ['Admin', 'Engineering'],
        users: ['Razvan Radulescu'],
        approved: false,
        inMergeGate: true,
      });
      // What blocks the merge: every reason, for cut paths too.
      expect(body.mergeBlockedReasons).toHaveLength(27);

      // No patch, and no file content under any other name.
      const json = JSON.stringify(body);
      expect(json).not.toContain('patch');
      expect(json).not.toContain('a line of generated knowledge text');
      expect(files.every((f) => !('patch' in f))).toBe(true);
    });

    it('keeps the 27-file answer under 10,000 characters', async () => {
      const base = await start();
      const body = await open(base);
      // The detail this was shaped from is the ~445,000-character one.
      expect(JSON.stringify(opened).length).toBeGreaterThan(400_000);
      // 8,918 characters as this fixture stands. The three per-path lists
      // (`files`, `approvals`, `mergeBlockedReasons`) are what fills it, so a
      // field added to any of them eats the margin ~25 times over.
      expect(JSON.stringify(body).length).toBeLessThan(10_000);
    });

    it('`include: ["all-paths"]` lists all 27 paths, still without patches', async () => {
      const base = await start();
      const body = await open(base, ['all-paths']);
      expect(body.files).toHaveLength(27);
      expect(body.totalFiles).toBe(27);
      expect(body.approvals).toHaveLength(27);
      expect(JSON.stringify(body)).not.toContain('a line of generated knowledge text');
    });

    it('`include: ["patches"]` gives each listed file its patch', async () => {
      const base = await start();
      const body = await open(base, ['patches']);
      const files = body.files as { path: string; patch?: string }[];
      expect(files).toHaveLength(25);
      expect(files.every((f) => f.patch?.startsWith('@@ -0,0 +1,400 @@'))).toBe(true);
      // Cut to 25 still: `patches` adds the diffs, it does not lift the cut.
      expect(body.totalFiles).toBe(27);
    });

    it('both together: every path, each with its patch', async () => {
      const base = await start();
      const body = await open(base, ['patches', 'all-paths']);
      const files = body.files as { patch?: string }[];
      expect(files).toHaveLength(27);
      expect(files.every((f) => typeof f.patch === 'string')).toBe(true);
    });

    it('reads a modification `changed` and a rename `moved`, with its old path', async () => {
      const base = await start();
      opened = detailOf([
        { path: 'KnowledgeBase/Kept.md', status: 'modified', additions: 2, deletions: 1, patch: '@@ x', isBinary: false, sha: 'b1', rawUrl: 'r1' },
        { path: 'KnowledgeBase/New-Home.md', previousPath: 'KnowledgeBase/Old-Home.md', status: 'renamed', additions: 0, deletions: 0, isBinary: false, sha: 'b2', rawUrl: 'r2' },
      ]);
      const body = await open(base);
      expect(body.files).toEqual([
        { path: 'KnowledgeBase/Kept.md', change: 'changed' },
        { path: 'KnowledgeBase/New-Home.md', change: 'moved', previousPath: 'KnowledgeBase/Old-Home.md' },
      ]);
      expect(body.totalFiles).toBe(2);
    });

    it('a deletion reads `deleted`', async () => {
      const base = await start();
      opened = detailOf([
        { path: 'KnowledgeBase/Gone.md', status: 'removed', additions: 0, deletions: 9, isBinary: false, sha: 'b3', rawUrl: 'r3' },
      ]);
      expect((await open(base)).files).toEqual([{ path: 'KnowledgeBase/Gone.md', change: 'deleted' }]);
    });

    it('says the approvers are unknown rather than implying nobody must approve', async () => {
      const base = await start();
      opened = detailOf([
        { path: 'KnowledgeBase/Opaque.md', status: 'added', additions: 1, deletions: 0, isBinary: false, sha: 'b4', rawUrl: 'r4' },
      ]);
      // No usable access config on the base: the empty approver set means "not
      // known", and nothing may be granted on the strength of that emptiness.
      opened.approvals = [
        { path: 'KnowledgeBase/Opaque.md', eligibleApprovers: { roles: [], users: [] }, approvedBy: [], eligibilityResolved: false, isApproved: false, inMergeGate: false },
      ];
      expect((await open(base)).approvals).toEqual([
        { path: 'KnowledgeBase/Opaque.md', roles: [], users: [], approved: false, inMergeGate: false, approversUnknown: true },
      ]);

      // A detail that carries no verdict at all reads the same way: absent is
      // not resolved, so the emptiness still means "not known".
      const legacy = { ...(opened.approvals as Record<string, unknown>[])[0] };
      delete legacy.eligibilityResolved;
      opened.approvals = [legacy];
      expect((await open(base)).approvals).toEqual([
        { path: 'KnowledgeBase/Opaque.md', roles: [], users: [], approved: false, inMergeGate: false, approversUnknown: true },
      ]);
    });

    it('surfaces the `change-request-conflicts` error as before', async () => {
      const base = await start();
      openFails = new ChangeRequestConflictsError('me/draft', 'target-company-state', ['KnowledgeBase/Clash.md']);
      const res = await post(`${base}/api/agent/tools/open_change_request`, writeTok(), {
        sourceBranch: 'me/draft',
        targetBranch: 'target-company-state',
        title: 'My change',
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        kind: 'change-request-conflicts',
        sourceBranch: 'me/draft',
        targetBranch: 'target-company-state',
        conflictedPaths: ['KnowledgeBase/Clash.md'],
      });
    });

    /**
     * The app's dialog reads the same detail from its own route. Shaping the
     * agent's answer must not touch it — so the detail the service handed back
     * still carries all 27 files and all their patches after the tool answered.
     */
    it('leaves the detail the app\'s dialog reads exactly as the service returned it', async () => {
      const base = await start();
      const before = JSON.stringify(opened);
      await open(base);
      expect(JSON.stringify(opened)).toBe(before);
      expect((opened.files as unknown[])).toHaveLength(27);
      expect((opened.files as { patch?: string }[]).every((f) => typeof f.patch === 'string')).toBe(true);
    });

    it('says in its description what the default answer holds and how to ask for more', async () => {
      await start();
      for (const tools of [await registryRef!.listInternal(), await registryRef!.listExternal()]) {
        const def = tools.find((t) => t.name === 'open_change_request')!;
        expect(def.description).toMatch(/SUMMARY/);
        expect(def.description).toMatch(/cut to 25/);
        expect(def.description).toMatch(/No patches and no file content/);
        expect(def.description).toMatch(/include: \["patches"\]/);
        expect(def.description).toMatch(/include: \["all-paths"\]/);
        // `toolDef` wraps a tool's flat inputs under `body`.
        const body = (def.inputs as { properties: { body: { properties: Record<string, { items?: { enum?: string[] }; description?: string }> } } })
          .properties.body;
        expect(body.properties.include.items?.enum).toEqual(['patches', 'all-paths']);
        expect(body.properties.include.description).toMatch(/every changed path instead of the first 25/);
      }
    });
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

/**
 * The history and syncing tools: what the app's History tab, compare view and
 * "update from target" do, each taking the per-file read the file itself
 * takes, and the branch update handing the service exactly what it was given.
 */
describe('history and syncing tools', () => {
  const DRAFT = 'me/draft';
  const DRAFT_WS = 'me%2Fdraft';
  const tool = (base: string, name: string) => `${base}/api/agent/tools/${name}`;
  const SHA = 'a'.repeat(40);

  it('list_file_changes answers the file\'s commits after the read gate, repository-relative', async () => {
    const base = await start();
    const res = await post(tool(base, 'list_file_changes'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', limit: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: 'KnowledgeBase/Foo.md',
      changes: [{ sha: 'abc1234', authorName: 'Ada', authorEmail: 'ada@x.io', subject: 'edit', committedAt: '2026-10-16T00:00:00Z' }],
    });
    expect(calls).toContainEqual(['canRead', DRAFT_WS, 'e@x', 'KnowledgeBase/Foo.md']);
    expect(calls).toContainEqual(['listChangesForFile', DRAFT_WS, 'knowledge-base/KnowledgeBase/Foo.md', 5]);
  });

  it('list_file_changes refuses a file the caller may not read, without reading its history', async () => {
    const base = await start();
    const res = await post(tool(base, 'list_file_changes'), writeTok(), { branch: DRAFT, path: 'Secret/Plan.md' });
    expect(res.status).toBe(403);
    expect(calls.some((c) => c[0] === 'listChangesForFile')).toBe(false);
  });

  it('read_file_at reads a commit on the branch\'s own history, with the version before it', async () => {
    const base = await start();
    const res = await post(tool(base, 'read_file_at'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: SHA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'KnowledgeBase/Foo.md', at: SHA, kind: 'commit', sha: SHA, content: 'after\n', before: 'before\n' });
    expect(calls).toContainEqual(['canRead', DRAFT_WS, 'e@x', 'KnowledgeBase/Foo.md']);
    expect(calls).toContainEqual(['fileAtChange', DRAFT_WS, 'knowledge-base/KnowledgeBase/Foo.md', SHA]);
  });

  it('read_file_at reads another branch at its published tip and authorizes at that very commit, never at a ref', async () => {
    const base = await start();
    const res = await post(tool(base, 'read_file_at'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: 'main' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'KnowledgeBase/Foo.md', at: 'main', kind: 'branch', sha: 'tip-of-main', content: 'on main\n' });
    expect(calls).toContainEqual(['fileAtBranch', DRAFT_WS, 'knowledge-base/KnowledgeBase/Foo.md', 'main']);
    expect(calls).toContainEqual(['canReadAtRef', DRAFT_WS, 'tip-of-main', 'e@x', 'KnowledgeBase/Foo.md']);
    expect(calls.filter((c) => c[0] === 'canReadAtRef').map((c) => c[2])).toEqual(['tip-of-main']);
  });

  it('read_file_at and compare_file require every commit a branch resolves to grant: a served tip that grants never outruns a local head that denies', async () => {
    const base = await start();
    const read = await post(tool(base, 'read_file_at'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: 'me/moved' });
    expect(read.status).toBe(403);
    expect(JSON.stringify(await read.json())).not.toContain('on me/moved');
    expect(calls.filter((c) => c[0] === 'canReadAtRef').map((c) => c[2])).toEqual(['tip-of-me/moved', 'local-of-me/moved']);

    calls = [];
    const diff = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', from: 'me/moved', to: DRAFT });
    expect(diff.status).toBe(403);
    expect(JSON.stringify(await diff.json())).not.toContain('@@');
    expect(calls.filter((c) => c[0] === 'canReadAtRef').map((c) => c[2])).toEqual(['tip-of-me/moved', 'local-of-me/moved']);
  });

  it('read_file_at refuses a branch whose commit denies the read, and one whose rules cannot be read, disclosing nothing', async () => {
    const base = await start();
    for (const at of ['me/hidden', 'me/unknown']) {
      const res = await post(tool(base, 'read_file_at'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at });
      expect(res.status, at).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain(`on ${at}`);
    }
  });

  it('compare_file diffs one commit, or two branches after gating both', async () => {
    const base = await start();
    const atCommit = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: SHA });
    expect(atCommit.status).toBe(200);
    expect(await atCommit.json()).toEqual({ path: 'KnowledgeBase/Foo.md', diff: `@@ patch of ${SHA}` });

    const between = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', from: 'main', to: DRAFT });
    expect(between.status).toBe(200);
    expect(await between.json()).toEqual({ path: 'KnowledgeBase/Foo.md', diff: '@@ main..me/draft' });
    // Authorized at the two commits the diff was made between, never at a ref.
    for (const b of ['main', DRAFT]) {
      expect(calls).toContainEqual(['canReadAtRef', DRAFT_WS, `tip-of-${b}`, 'e@x', 'KnowledgeBase/Foo.md']);
    }
    expect(calls.filter((c) => c[0] === 'canReadAtRef').map((c) => c[2])).toEqual(['tip-of-main', `tip-of-${DRAFT}`]);

    const neither = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md' });
    expect(neither.status).toBe(400);
    const hidden = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', from: 'me/hidden', to: DRAFT });
    expect(hidden.status).toBe(403);
    expect(JSON.stringify(await hidden.json())).not.toContain('@@');
  });

  it('branch_status composes the branch\'s standing, against the fork base unless a base is named', async () => {
    const base = await start();
    const res = await post(tool(base, 'branch_status'), writeTok(), { branch: DRAFT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      branch: DRAFT,
      // The listing double names only `main`, so the draft's own entry is unknown.
      isProtected: false,
      hasRemote: true,
      ahead: null,
      behind: null,
      behindRemote: true,
      uncommittedPaths: ['KnowledgeBase/Pending.md'],
      forkBase: 'main',
      base: 'main',
      changedPaths: ['KnowledgeBase/Changed.md'],
      withheldPaths: 0,
    });
    expect(calls).toContainEqual(['changedPathsBetweenBranches', DRAFT_WS, 'main', DRAFT]);

    calls = [];
    const named = await post(tool(base, 'branch_status'), writeTok(), { branch: DRAFT, base: 'release' });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ base: 'release' });
    expect(calls).toContainEqual(['changedPathsBetweenBranches', DRAFT_WS, 'release', DRAFT]);
  });

  it('update_branch hands the service the branch, the source and the resolutions as given', async () => {
    const base = await start();
    const res = await post(tool(base, 'update_branch'), writeTok(), {
      branch: DRAFT,
      from: 'main',
      resolutions: [
        { path: 'KnowledgeBase/Foo.md', content: 'resolved\n' },
        { path: 'KnowledgeBase/Bar.md', choose: 'theirs' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'merged', sha: 'merge-sha', from: 'main', resolvedPaths: [] });
    // Handed as given, plus the agent's write gate for the content one brings.
    expect(calls).toContainEqual([
      'updateBranch',
      DRAFT_WS,
      'user-A',
      expect.objectContaining({
        from: 'main',
        resolutions: [{ path: 'KnowledgeBase/Foo.md', content: 'resolved\n' }, { path: 'KnowledgeBase/Bar.md', choose: 'theirs' }],
        validateWrite: expect.any(Function),
      }),
    ]);

    calls = [];
    const own = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT });
    expect(own.status).toBe(200);
    expect(calls).toContainEqual(['updateBranch', DRAFT_WS, 'user-A', {}]);
  });

  it('update_branch refuses a malformed resolution before the service is asked', async () => {
    const base = await start();
    for (const resolutions of [
      'not a list',
      [{ content: 'no path' }],
      [{ path: 'A.md', choose: 'mine' }],
      [{ path: 'A.md', content: 42 }],
    ]) {
      const res = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, resolutions });
      expect(res.status, JSON.stringify(resolutions)).toBe(400);
    }
    expect(calls.some((c) => c[0] === 'updateBranch')).toBe(false);
  });

  it("tells the deployment's read hook of every history read, and a hook that refuses refuses the history", async () => {
    const base = await start();
    const res = await post(tool(base, 'list_file_changes'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md' });
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(['agentRead', DRAFT, 'knowledge-base/KnowledgeBase/Foo.md', undefined]);
    const hooked = { branch: DRAFT, path: 'Hooked/Foo.md' };
    for (const [name, body] of [
      ['list_file_changes', hooked],
      ['read_file_at', { ...hooked, at: SHA }],
      ['compare_file', { ...hooked, from: 'main', to: DRAFT }],
    ] as const) {
      const refused = await post(tool(base, name), writeTok(), body);
      expect(refused.status, name).toBe(403);
    }
    expect(
      calls.some((c) => ['listChangesForFile', 'fileAtChange', 'showFileAtChange', 'compareFile'].includes(c[0] as string) && String(c[2]).includes('Hooked/')),
    ).toBe(false);
  });

  it("compare_file takes the workspace's own read on the path before the branches' refs, as the compare route does", async () => {
    const base = await start();
    const res = await post(tool(base, 'compare_file'), writeTok(), { branch: DRAFT, path: 'Secret/Plan.md', from: 'main', to: DRAFT });
    expect(res.status).toBe(403);
    expect(calls).toContainEqual(['canRead', DRAFT_WS, 'e@x', 'Secret/Plan.md']);
    expect(calls.some((c) => c[0] === 'canReadAtRef')).toBe(false);
  });

  it('read_file_at takes a full commit id; a short hex string is a branch name', async () => {
    const base = await start();
    const res = await post(tool(base, 'read_file_at'), writeTok(), { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: 'abc1234' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'branch', at: 'abc1234' });
    expect(calls).toContainEqual(['fileAtBranch', DRAFT_WS, 'knowledge-base/KnowledgeBase/Foo.md', 'abc1234']);
  });

  it('branch_status shows only the changed and uncommitted paths the caller may read, and counts the rest', async () => {
    const base = await start();
    calls = [];
    const res = await post(tool(base, 'branch_status'), writeTok(), { branch: DRAFT, base: 'main' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changedPaths: ['KnowledgeBase/Changed.md'], uncommittedPaths: ['KnowledgeBase/Pending.md'], withheldPaths: 0 });
    expect(calls).toContainEqual(['canReadBatchAtRef', DRAFT_WS, 'origin/main', 'e@x', ['KnowledgeBase/Changed.md']]);
    expect(calls).toContainEqual(['canReadBatch', DRAFT_WS, 'e@x', ['KnowledgeBase/Pending.md']]);

    // A base whose rules do not resolve withholds every changed path.
    calls = [];
    const unknown = await post(tool(base, 'branch_status'), writeTok(), { branch: DRAFT, base: 'me/unknown' });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ changedPaths: [], withheldPaths: 1 });
  });

  it('update_branch leaves a conflicted file the caller may not read on both sides out by name, and refuses to let them settle it', async () => {
    const base = await start();
    const res = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, from: 'me/conflicting' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('conflicts');
    expect(body.unresolved).toEqual(['KnowledgeBase/Open.md']);
    expect(body.files).toEqual([{ path: 'KnowledgeBase/Open.md', base: 'b\n', ours: 'o\n', theirs: 't\n', merged: '<<<<<<<\n' }]);
    expect(body.withheldConflicts).toBe(1);
    expect(JSON.stringify(body)).not.toContain('Secret/Plan.md');
    // (Whether the caller may settle a file is the service's verdict, made
    // inside the merge against the source as fetched — see the facade test.)
    // A readable one is settled, and the service gets exactly that.
    calls = [];
    const side = await post(tool(base, 'update_branch'), writeTok(), {
      branch: DRAFT,
      from: 'me/conflicting',
      resolutions: [{ path: 'KnowledgeBase/Open.md', choose: 'theirs' }],
    });
    expect(side.status).toBe(200);
    expect(await side.json()).toEqual({ kind: 'merged', sha: 'resolved-sha', from: 'me/conflicting', resolvedPaths: ['KnowledgeBase/Open.md'] });
    expect(calls).toContainEqual(['updateBranch', DRAFT_WS, 'user-A', { from: 'me/conflicting', resolutions: [{ path: 'KnowledgeBase/Open.md', choose: 'theirs' }] }]);
  });

  it("update_branch takes the agent's pre-disk write gate for a resolution's content: a roles.yaml that creates a role is refused as the file tools refuse it", async () => {
    const base = await start();
    const res = await post(tool(base, 'update_branch'), writeTok(), {
      branch: DRAFT,
      from: 'me/conflicting',
      // Well-formed, and declaring a role the draft's (absent) roles.yaml does not: the agent gate's new-role refusal.
      resolutions: [{ path: 'roles.yaml', content: 'roles:\n  Admin:\n    - a@x.eu\n' }],
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/never create app roles/);
    // The gate travelled with the call; a side kept whole needs none.
    const call = calls.find((c) => c[0] === 'updateBranch') as unknown[] | undefined;
    expect(typeof (call?.[3] as { validateWrite?: unknown })?.validateWrite).toBe('function');
    calls = [];
    const side = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, from: 'me/conflicting', resolutions: [{ path: 'roles.yaml', choose: 'theirs' }] });
    expect(side.status).toBe(200);
    expect(calls).toContainEqual(['updateBranch', DRAFT_WS, 'user-A', { from: 'me/conflicting', resolutions: [{ path: 'roles.yaml', choose: 'theirs' }] }]);
  });

  it("update_branch asks the deployment's hooks for a resolution as for any read and any write", async () => {
    const base = await start();
    for (const [path, status] of [
      ['Locked/A.md', 403],
      ['Hooked/A.md', 403],
      ['KnowledgeBase/Open.md', 200],
    ] as const) {
      calls = [];
      const res = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, from: 'me/conflicting', resolutions: [{ path, content: 'x\n' }] });
      expect(res.status, path).toBe(status);
      expect(calls, path).toContainEqual(['agentRead', DRAFT, `knowledge-base/${path}`, undefined]);
      // The write hook is asked after the read hook let the path through:
      // it is what refuses `Locked/`, and is never reached for `Hooked/`.
      if (path !== 'Hooked/A.md') expect(calls, path).toContainEqual(['preWrite', DRAFT, `knowledge-base/${path}`]);
      else expect(calls.some((c) => c[0] === 'preWrite')).toBe(false);
      if (status !== 200) expect(calls.some((c) => c[0] === 'updateBranch')).toBe(false);
    }
  });

  it("update_branch tells the deployment's read hook of each conflicted file before showing it; a hook that fails is not an answer", async () => {
    const base = await start();
    calls = [];
    const res = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, from: 'me/conflicting' });
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(['agentRead', DRAFT, 'knowledge-base/KnowledgeBase/Open.md', undefined]);
    expect(calls).toContainEqual(['agentRead', DRAFT, 'knowledge-base/Secret/Plan.md', undefined]);
    // A failing hook propagates as a failure (500), not as a withheld file.
    const failing = await post(tool(base, 'update_branch'), writeTok(), { branch: DRAFT, from: 'me/conflicting', resolutions: [{ path: 'Failing/A.md', content: 'x' }] });
    expect(failing.status).toBe(500);
  });

  it('carries the conversation id of an external caller to the read hook, as every file tool does', async () => {
    const base = await start();
    calls = [];
    const res = await post(tool(base, 'list_file_changes'), 'bevel_key', { branch: DRAFT, path: 'KnowledgeBase/Foo.md', sessionId: 'conv-7' });
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(['agentRead', DRAFT, 'knowledge-base/KnowledgeBase/Foo.md', 'conv-7']);
    for (const [name, body] of [
      ['read_file_at', { branch: DRAFT, path: 'KnowledgeBase/Foo.md', at: 'main', sessionId: 'conv-7' }],
      ['compare_file', { branch: DRAFT, path: 'KnowledgeBase/Foo.md', from: 'main', to: DRAFT, sessionId: 'conv-7' }],
    ] as const) {
      calls = [];
      const r = await post(tool(base, name), 'bevel_key', body);
      expect(r.status, name).toBe(200);
      expect(calls, name).toContainEqual(['agentRead', DRAFT, 'knowledge-base/KnowledgeBase/Foo.md', 'conv-7']);
    }
    // `branch_status` reads no file content, so it tells the hook nothing; it still takes the id.
    const status = await post(tool(base, 'branch_status'), 'bevel_key', { branch: DRAFT, sessionId: 'conv-7' });
    expect(status.status).toBe(200);
  });

  it('lists the five on the external catalog too: a remote agent reads history and syncs its drafts', async () => {
    await start();
    const external = await registryRef!.listExternal();
    for (const name of ['list_file_changes', 'read_file_at', 'compare_file', 'branch_status', 'update_branch']) {
      expect(external.some((t) => t.name === name), name).toBe(true);
    }
  });
});
