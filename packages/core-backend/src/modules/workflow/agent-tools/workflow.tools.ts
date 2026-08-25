import type { Router, RequestHandler } from 'express';
import { DEFAULT_BRANCH, PROTECTED_BRANCHES } from '@bevel-software/platform-shared';
import type { IToolRegistry, JsonSchema } from '../../tool-registry/tool.contract.js';
import { ToolError, type ToolContext, type ToolHandler } from '../../tool-helpers/tool.contract.js';
import { toolDef, withBranchInput } from '../../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { requireInternalSource } from '../../tool-auth/tool-auth.middleware.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { assertInsideRepo } from '../../kb-fs/repo-path.js';

// A function, not a constant: the branch model is applied during boot, and a
// module-scope capture would freeze this at the empty set that exists before it.
const protectedInline = () => [...PROTECTED_BRANCHES].map((b) => `\`${b}\``).join(' / ');

// Output sub-schemas for the git-aliased workflow payloads (Branch, Change,
// ChangeRequestComment, …). Defined once and referenced by the individual tool
// defs below so each tool still declares its own `outputs`.
const branchSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    isProtected: { type: 'boolean' },
    ahead: { type: ['integer', 'null'], description: 'Commits ahead of upstream / nearest protected base; null if unresolved.' },
    behind: { type: ['integer', 'null'], description: 'Commits behind; null if unresolved.' },
    hasRemote: { type: 'boolean', description: 'True iff `origin/<name>` exists after the last fetch.' },
  },
  required: ['name', 'isProtected', 'ahead', 'behind', 'hasRemote'],
};

const commitSchema: JsonSchema = {
  type: 'object',
  properties: {
    authorName: { type: 'string' },
    authorEmail: { type: 'string' },
    sha: { type: 'string' },
    subject: { type: 'string' },
    committedAt: { type: 'string', description: 'ISO timestamp.' },
  },
  required: ['authorName', 'authorEmail', 'sha', 'subject', 'committedAt'],
};

const changeRequestFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    previousPath: { type: 'string', description: 'Set for renames/copies.' },
    status: { type: 'string', description: '`added` | `modified` | `removed` | `renamed` | `copied` | `changed` | `unchanged`.' },
    additions: { type: 'integer' },
    deletions: { type: 'integer' },
    patch: { type: 'string', description: 'Unified diff; absent for binary or oversized files.' },
    isBinary: { type: 'boolean' },
    sha: { type: 'string', description: 'Blob SHA at the change-request head.' },
    rawUrl: { type: 'string' },
  },
  required: ['path', 'status', 'additions', 'deletions', 'isBinary', 'sha', 'rawUrl'],
};

const commentSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    author: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' } }, required: ['email', 'name'] },
    body: { type: 'string' },
    path: { type: 'string', description: 'Set for file-level / inline comments.' },
    line: { type: 'integer', description: 'Set for inline comments.' },
    headSha: { type: 'string', description: 'Head the comment was anchored to.' },
    parentId: { type: 'string', description: 'Root comment id when this is a reply.' },
    createdAt: { type: 'string', description: 'ISO timestamp.' },
    updatedAt: { type: 'string', description: 'ISO timestamp; present once edited.' },
  },
  required: ['id', 'author', 'body', 'headSha', 'createdAt'],
};

const changeRequestDetailSchema: JsonSchema = {
  type: 'object',
  description: 'Full change-request detail (aliased from the underlying pull request).',
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    body: { type: 'string' },
    author: { type: 'object', properties: { login: { type: 'string' }, name: { type: 'string' } }, required: ['login'] },
    headSha: { type: 'string' },
    baseSha: { type: 'string' },
    files: { type: 'array', items: changeRequestFileSchema },
    comments: { type: 'array', items: commentSchema },
    approvals: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Per-file approval state, one entry per file in `files`.' },
  },
  required: ['number', 'title', 'body', 'headSha', 'baseSha', 'files', 'comments', 'approvals'],
  additionalProperties: true,
};

const mergeOutcomeSchema: JsonSchema = {
  type: 'object',
  description: 'Either a completed merge or a signal that conflicts must be resolved first.',
  properties: {
    kind: { type: 'string', enum: ['merged', 'conflicts-need-resolution'] },
    result: {
      type: 'object',
      description: 'Present when `kind` is `merged`.',
      properties: { prNumber: { type: 'integer' }, sha: { type: 'string', description: 'Merge commit SHA.' }, mergedAt: { type: 'string', description: 'ISO timestamp.' } },
    },
    conflictedPaths: { type: 'array', items: { type: 'string' }, description: 'Present when `kind` is `conflicts-need-resolution` — paths to resolve on the source branch.' },
  },
  required: ['kind'],
  additionalProperties: true,
};

/**
 * Workflow domain tools, registered into the central catalog and hosted on the
 * shared tools router — the ONE mechanism: build a self-describing UTCP def,
 * host the endpoint behind `toolAuth` + `toolHandler`, register the def. Each is
 * a thin facade over `IWorkflowService`; identity + workspace come from the
 * resolved `ToolContext` (so a caller can never address another user/workspace).
 * All are `both` (external agents can drive repo ops directly); the write ones
 * carry the `write` tag so read-scoped callers are refused.
 */
export function registerWorkflowTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  /** The clone folder at the workspace root; `save_file` refuses a path outside it. */
  kbDirName: string,
): void {
  const mount = (spec: {
    name: string;
    description: string;
    inputs: JsonSchema;
    outputs?: JsonSchema;
    write: boolean;
    /** Register on the internal catalog only (e.g. agent-control tools that make no sense to a remote caller). */
    internalOnly?: boolean;
    /** Skip the auto-injected `branch` input — for a tool that already declares its own `branch` (switch_branch). */
    skipBranch?: boolean;
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    const def = toolDef({
      name: spec.name,
      description: spec.description,
      path,
      inputs: spec.skipBranch ? spec.inputs : withBranchInput(spec.inputs),
      outputs: spec.outputs,
      tags: spec.write ? ['workflow', 'write'] : ['workflow'],
    });
    registry.registerInternalTool(def);
    if (!spec.internalOnly) registry.registerExternalTool(def);
    // Router mounts at `/api`, so strip that prefix for the route path.
    // Internal-only tools keep their route mounted (our agent calls it over the
    // same loopback) but gate it to internal-source callers, so an external key
    // can't invoke it by name.
    router.post(
      path.slice('/api'.length),
      toolAuth,
      ...(spec.internalOnly ? [requireInternalSource] : []),
      toolHandler(spec.handler, { write: spec.write }),
    );
  };

  // A workspace for a repo-global op (branch listing, change-request reads /
  // merges) that doesn't act on any one draft. All clones share one origin, so
  // any existing one is equivalent — reusing a clone already on disk avoids
  // cloning a branch (or failing when the default branch isn't on the remote)
  // just to run a global op. Falls back to the default branch on a cold start
  // with no workspaces yet.
  const repoGlobalWorkspaceId = async (ctx: ToolContext): Promise<string> =>
    (await ctx.workspaceService.findAnyWorkspaceId()) ?? workspaceIdForBranch(DEFAULT_BRANCH);

  mount({
    name: 'list_branches',
    description:
      'List every draft known to the repository (protected versions + unprotected drafts, ' +
      'local and on the shared remote). Returns `{ branches: [{ name, isProtected, ahead, behind, hasRemote }] }`. ' +
      'Takes no arguments — branch listing is repo-global, not scoped to any one draft.',
    // Repo-global: the branch set is the same from any clone, so don't require
    // (and risk cloning) a model-named branch — resolve any existing workspace.
    skipBranch: true,
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: { branches: { type: 'array', items: branchSchema, description: 'Every draft known to the repository, protected and unprotected.' } },
      required: ['branches'],
    },
    write: false,
    handler: async (_args, ctx: ToolContext) => ({
      branches: await ctx.workflowService.listBranches(await repoGlobalWorkspaceId(ctx)),
    }),
  });

  mount({
    name: 'commit_change',
    description:
      'Save the currently-pending file edits as a new change on the current branch. Each change ' +
      'must affect exactly one file — if multiple files are dirty, returns a structured error ' +
      'listing them; commit them one at a time. Refused on protected branches without write permission.',
    inputs: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 200, description: 'One-line commit subject (≤200 chars).' },
        description: { type: 'string', description: 'Optional multi-line body.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { change: { ...commitSchema, description: 'The committed change (commit attribution).' } },
      required: ['change'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => ({
      change: await ctx.workflowService.commitChange(workspaceIdForBranch(args.branch as string), ctx.user, {
        summary: args.summary as string,
        description: typeof args.description === 'string' ? args.description : undefined,
      }),
    }),
  });

  mount({
    name: 'save_file',
    description:
      'Schedule the file at <path> for commit + push using whatever bytes are on disk (no content ' +
      'rewrite) — for binary uploads or files left uncommitted. On lock contention returns ' +
      '`{ saved: false, reason }` rather than throwing. The commit lands asynchronously.',
    inputs: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: `Workspace-relative path, as write_file expects: starts with \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`).`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        saved: { type: 'boolean', description: 'True if the file was scheduled for commit; false on lock contention.' },
        queued: { type: 'boolean', description: 'Present and true when the commit was enqueued.' },
        reason: { type: 'string', description: 'Present when `saved` is false — why it could not be scheduled.' },
      },
      required: ['saved'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const path = args.path as string;
      const branch = args.branch as string;
      // This tool commits whatever is on disk at `path` through the lock
      // protocol, bypassing the locking filesystem's own guard. A path without
      // the clone-folder prefix names a file git can never see: refuse it
      // before a lock is taken, with the same corrected-path message.
      if (typeof path !== 'string' || path.length === 0) {
        throw new ToolError('`path` is required and must be a non-empty string.', 400);
      }
      assertInsideRepo(path, kbDirName);
      const workspaceId = workspaceIdForBranch(branch);
      const acquired = await ctx.workflowService.acquireLock(workspaceId, branch, path, ctx.user);
      if (!acquired.acquired) {
        return { saved: false, reason: `Locked by ${acquired.lock.holderName ?? 'another user'} — try again later.` };
      }
      await ctx.workflowService.releaseLock(workspaceId, branch, path, ctx.user);
      return { saved: true, queued: true };
    },
  });

  mount({
    name: 'share_current_branch',
    description:
      'Publish the current branch to the shared remote so teammates and any change request pick up ' +
      'your commits. No arguments. Refused on protected branches without write permission.',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: { shared: { type: 'boolean', description: 'Always true on success.' } },
      required: ['shared'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      await ctx.workflowService.shareCurrentBranch(workspaceIdForBranch(args.branch as string), ctx.user);
      return { shared: true };
    },
  });

  mount({
    name: 'create_branch',
    description:
      'Create a new unprotected draft named `name`, forked from the existing branch `branch`. The ' +
      `backend rejects protected names (${protectedInline()}) and filesystem-invalid names — surface ` +
      'those errors verbatim. Convention: `<email-localpart>/<kebab-slug>`. Does NOT switch the ' +
      'agent onto the new draft.',
    // `branch` here is the fork BASE — its own meaning — so skip the generic
    // workspace-`branch` injection ("the branch you are currently working on"),
    // whose wording invites filling in the draft being created instead.
    skipBranch: true,
    inputs: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Name of the draft to create (`<email-localpart>/<kebab-slug>` for user drafts). Must not exist yet.' },
        branch: { type: 'string', minLength: 1, description: 'Existing branch to fork the new draft from — usually the branch you are currently on.' },
      },
      required: ['name', 'branch'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { branch: { ...branchSchema, description: 'The newly created draft.' } },
      required: ['branch'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const name = args.name as string;
      const base = args.branch as string;
      // The git op runs in the base's workspace, whose clone has the base
      // checked out — the new draft forks from its HEAD. Resolving a workspace
      // lazily clones its branch from origin, so a `branch` naming the
      // not-yet-created draft would fail with "Remote branch not found" (500);
      // catch the one predictable case of that early with a clear 400.
      if (base === name) {
        throw new ToolError(
          `\`branch\` must be an existing branch to fork from — not '${name}', the draft being created.`,
          400,
        );
      }
      return {
        branch: await ctx.workflowService.createBranch(workspaceIdForBranch(base), name),
      };
    },
  });

  mount({
    name: 'open_change_request',
    description:
      'Open a change request from a draft branch into a target branch. Auto-merges the latest target ' +
      'into the source first, pushes, then creates the CR. On conflicts returns a ' +
      '`change-request-conflicts` error with affected paths. The author marker is injected server-side.',
    inputs: {
      type: 'object',
      properties: {
        sourceBranch: { type: 'string', minLength: 1, description: 'The draft branch carrying the changes.' },
        targetBranch: { type: 'string', minLength: 1, description: `The branch to apply to (e.g. '${DEFAULT_BRANCH}').` },
        title: { type: 'string', minLength: 1, maxLength: 256, description: 'Short imperative title (≤256 chars).' },
        description: { type: 'string', description: 'Optional markdown body shown verbatim to reviewers.' },
      },
      required: ['sourceBranch', 'targetBranch', 'title'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { changeRequest: changeRequestDetailSchema },
      required: ['changeRequest'],
    },
    write: true,
    // The workspace this acts on is the SOURCE draft's — `sourceBranch` already
    // names it, so skip the auto-injected (and here redundant) `branch` input
    // rather than asking the model for both and reading the wrong one.
    skipBranch: true,
    handler: async (args, ctx: ToolContext) => ({
      changeRequest: await ctx.workflowService.openChangeRequest(workspaceIdForBranch(args.sourceBranch as string), ctx.user, {
        sourceBranch: args.sourceBranch as string,
        targetBranch: args.targetBranch as string,
        title: args.title as string,
        description: typeof args.description === 'string' ? args.description : undefined,
      }),
    }),
  });

  mount({
    name: 'post_change_request_comment',
    description:
      'Post a review comment on a change request. Three modes: general (no path), file-level (path), ' +
      'inline (path + line). Anchors to the CR\'s current head.',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        body: { type: 'string', minLength: 1, description: 'Comment body (Markdown).' },
        path: { type: 'string', description: 'Workspace-relative path for a file-level/inline comment.' },
        line: { type: 'integer', minimum: 1, description: 'Line number for an inline comment. Requires `path`.' },
        parentId: { type: 'string', description: 'Comment id to reply to.' },
      },
      required: ['number', 'body'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { comment: { ...commentSchema, description: 'The posted review comment.' } },
      required: ['comment'],
    },
    write: true,
    // Keyed by change-request number, not a draft — the workspace is only a
    // scratch clone to run the repo op in, so resolve any existing one rather
    // than requiring a `branch`.
    skipBranch: true,
    handler: async (args, ctx: ToolContext) => {
      const number = args.number as number;
      const line = typeof args.line === 'number' ? args.line : undefined;
      const path = typeof args.path === 'string' ? args.path : undefined;
      if (line !== undefined && !path) {        throw new ToolError('`path` is required when `line` is provided (inline comments anchor to a file).', 400);
      }
      const detail = await ctx.workflowService.getChangeRequestDetail(number, {
        fresh: true,
        workspaceId: await repoGlobalWorkspaceId(ctx),
        viewerEmail: ctx.user.email,
      });
      if (!detail) {        throw new ToolError(`Change request #${number} not found.`, 404);
      }
      const comment = await ctx.workflowService.postComment(
        number,
        ctx.user,
        { body: args.body as string, path, line, parentId: typeof args.parentId === 'string' ? args.parentId : undefined },
        detail.headSha,
      );
      return { comment };
    },
  });

  mount({
    name: 'merge_change_request',
    description:
      'Merge a change request into its target branch. Returns `merged` or ' +
      '`conflicts-need-resolution`. Hard blocks (closed, no files, missing approvals) raise an error. ' +
      '`bypass: true` proceeds despite soft warnings (admin only).',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        bypass: { type: 'boolean', description: 'Proceed despite missing owner approvals on .md files (admin only).' },
      },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { outcome: mergeOutcomeSchema },
      required: ['outcome'],
    },
    write: true,
    // Keyed by change-request number, not a draft — the workspace is only a
    // scratch clone to run the merge in, so resolve any existing one rather than
    // requiring a `branch`.
    skipBranch: true,
    handler: async (args, ctx: ToolContext) => {
      const number = args.number as number;
      const workspaceId = await repoGlobalWorkspaceId(ctx);
      const detail = await ctx.workflowService.getChangeRequestDetail(number, {
        fresh: true,
        workspaceId,
        viewerEmail: ctx.user.email,
      });
      if (!detail) {        throw new ToolError(`Change request #${number} not found.`, 404);
      }
      const outcome = await ctx.workflowService.mergeChangeRequest(
        number,
        ctx.user,
        detail.headSha,
        detail.approvals,
        detail.state,
        detail.title,
        detail.base,
        workspaceId,
        { bypass: args.bypass === true },
      );
      return { outcome };
    },
  });

  mount({
    name: 'switch_branch',
    description:
      'Switch the agent to a different draft for the NEXT user turn. The current turn finishes on ' +
      'the original draft (writes from this point still land there), so finish anything important ' +
      'first. Validates the target exists (use list_branches if unsure) and pre-warms its clone; ' +
      'the frontend navigates on turn completion. After calling, summarise the switch and stop.',
    // Internal-only: this controls OUR agent's next turn — meaningless to a remote caller.
    internalOnly: true,
    // `branch` here is the TARGET to switch to — its own meaning — so skip the
    // generic workspace-`branch` injection (it would collide).
    skipBranch: true,
    inputs: {
      type: 'object',
      properties: { branch: { type: 'string', minLength: 1, description: 'Exact name of the existing draft to switch to.' } },
      required: ['branch'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        switched: { type: 'boolean', description: 'Always true on success; the switch takes effect next turn.' },
        branch: { type: 'string', description: 'The draft switched to.' },
        workspaceId: { type: 'string', description: "The target draft's workspace id." },
        note: { type: 'string', description: 'Reminder that this turn\'s remaining writes still land on the original draft.' },
      },
      required: ['switched', 'branch', 'workspaceId', 'note'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const target = args.branch as string;
      // Validate the target exists by listing from any existing clone (every
      // clone tracks all remote refs) — there is no "current" workspace here,
      // and the default branch may not even be on the remote.
      const branches = await ctx.workflowService.listBranches(await repoGlobalWorkspaceId(ctx));
      if (!branches.find((b) => b.name === target)) {
        const known = branches.map((b) => b.name).slice(0, 25).join(', ');
        throw new ToolError(`No draft named "${target}" on this workspace. Known: ${known || '(none)'}.`, 404);
      }
      await ctx.workspaceService.getOrCreateForBranch(target);
      const targetWorkspaceId = workspaceIdForBranch(target);
      // Publish keyed on the user (no threadId over the loopback); the frontend
      // follows on turn completion. No-op for callers with no chat session.
      ctx.events.emit({ kind: 'branch-switched', forUserId: ctx.user.id, branch: target, workspaceId: targetWorkspaceId });
      return {
        switched: true,
        branch: target,
        workspaceId: targetWorkspaceId,
        note: "Switch takes effect next turn. This turn's remaining writes still land on the original draft.",
      };
    },
  });
}
