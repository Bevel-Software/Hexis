import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, JsonSchema } from '../../tool-registry/tool.contract.js';
import { ToolError, hasHttpStatus, type ToolContext, type ToolHandler } from '../../tool-helpers/index.js';
import { isCommitSha } from '../../../shared/git.contract.js';
import { toolDef } from '../../tool-helpers/index.js';
import type { ToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { requireInternalSource } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { assertAgentWriteAllowed, notifyAgentRead, SESSION_ID_INPUT, type AgentAccessGate } from '../../workspace/index.js';
import { readablePathsAt, readableAtCommits, assertReadableAtCommits } from '../read-on-branch.js';
import type { KbContext } from '../../../shared/kb-context.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { assertInsideRepo, normalizePathArgs } from '../../kb-fs/repo-path.js';
import { RETIRED_TOOL_MESSAGES } from '@bevel-software/platform-mcp-core';
import {
  CHANGE_REQUEST_INCLUDES,
  CHANGE_REQUEST_PATH_LIMIT,
  parseInclude,
  summarizeChangeRequest,
} from './change-request-summary.js';

/** `knowledge-base/KnowledgeBase/x.md` → `KnowledgeBase/x.md`; anything else unchanged. */
function stripKbDir(path: string, kbDirName: string): string {
  return path.startsWith(`${kbDirName}/`) ? path.slice(kbDirName.length + 1) : path;
}

// Read at call time, not captured: the branch model is applied during boot,
// and a value taken at registration would be the empty set that exists before it.
const protectedInline = (kb: Pick<KbContext, 'protectedBranches'>) =>
  [...kb.protectedBranches].map((b) => `\`${b}\``).join(' / ');

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

const changeRequestSummaryFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    change: { type: 'string', description: '`added` | `changed` | `deleted` | `moved`.' },
    previousPath: { type: 'string', description: 'Where a `moved` file came from.' },
    patch: {
      type: 'string',
      description: 'Unified diff. Only with `include: ["patches"]`, and absent for a binary or oversized file.',
    },
  },
  required: ['path', 'change'],
};

const changeRequestApproversSchema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' }, description: 'Roles that confer approval here; `everyone` means any signed-in approver.' },
    users: { type: 'array', items: { type: 'string' }, description: 'Approvers named directly, by display name.' },
    approved: { type: 'boolean', description: 'True once an eligible approver has approved at the current head.' },
    inMergeGate: { type: 'boolean', description: 'False when the merge gate does not bind this path — then nobody has to approve it.' },
    approversUnknown: { type: 'boolean', description: 'Present when the access tree could not be resolved: empty `roles`/`users` means unknown, not nobody.' },
  },
  required: ['path', 'roles', 'users', 'approved', 'inMergeGate'],
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

const changeRequestUrlSchema: JsonSchema = {
  type: 'string',
  description:
    'Link a person can open: absolute (`https://<public address>/change-requests/<number>`) when the deployment ' +
    'has a public address configured, else the relative in-app path (with `urlNote`).',
};
const changeRequestUrlNoteSchema: JsonSchema = { type: 'string', description: 'Present only when `url` is relative — how to get absolute links.' };

/** The link to a change request, for a tool whose payload is not the change request itself. */
const changeRequestLinkSchema: JsonSchema = {
  type: 'object',
  properties: { number: { type: 'integer' }, url: changeRequestUrlSchema, urlNote: changeRequestUrlNoteSchema },
  required: ['number', 'url'],
};

/** `{ number, url, urlNote? }` of a change request summary or detail. */
function linkOf(cr: { number: number; url: string; urlNote?: string }): { number: number; url: string; urlNote?: string } {
  return { number: cr.number, url: cr.url, ...(cr.urlNote ? { urlNote: cr.urlNote } : {}) };
}

/**
 * What `open_change_request` answers: a summary, `url` first, with no patch and
 * no file content. The app's dialog reads the full detail from its own route;
 * handing that to an agent cost ~445,000 characters for 27 files of 15 KB and
 * overflowed every tool-result limit. Built by `summarizeChangeRequest`.
 *
 * Property order is the answer's field order, and `url` leads it: the link is
 * the one field the agent must hand the user, so it must survive any truncation.
 */
const changeRequestSummarySchema: JsonSchema = {
  type: 'object',
  properties: {
    url: changeRequestUrlSchema,
    urlNote: changeRequestUrlNoteSchema,
    number: { type: 'integer' },
    title: { type: 'string' },
    state: { type: 'string', description: '`open` | `merged` | `closed`.' },
    sourceBranch: { type: 'string', description: 'The draft branch carrying the changes.' },
    targetBranch: { type: 'string', description: 'The branch the changes apply to.' },
    approvals: {
      type: 'array',
      items: changeRequestApproversSchema,
      description: 'Who must approve, one entry per listed file. A file nobody can approve (`inMergeGate: false`) blocks nothing.',
    },
    mergeBlockedReasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'What blocks the merge — every missing approval, whether its file is listed or cut. Empty when nothing blocks.',
    },
    files: {
      type: 'array',
      items: changeRequestSummaryFileSchema,
      description: `The changed paths with their kind of change, cut to ${CHANGE_REQUEST_PATH_LIMIT}; \`include: ["all-paths"]\` lists them all.`,
    },
    totalFiles: { type: 'integer', description: 'How many files the request changes in total, cut or not.' },
    notified: {
      type: 'array',
      items: { type: 'string' },
      description:
        'On the answer to an open only: the channels that reached the approvers ("email", say), as the deployment\'s listeners said; empty when nobody was told and the request waits to be found in the app.',
    },
  },
  required: ['url', 'number', 'title', 'state', 'sourceBranch', 'targetBranch', 'approvals', 'mergeBlockedReasons', 'files', 'totalFiles'],
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
  /** The clone folder at the workspace root (`save_file` refuses a path outside it) and the branch model. */
  kb: Pick<KbContext, 'kbDirName' | 'defaultBranch' | 'defaultWorkspaceId' | 'protectedBranches'>,
  /**
   * Whether the caller may see change request `number` — `get_change_request`'s
   * own gate (`changeRequestScope(...).maySee`). `delete_branch` neither names
   * nor links a request it answers no for.
   */
  maySeeChangeRequest: (ctx: ToolContext, number: number) => Promise<boolean>,
  /**
   * The per-file read gate the history tools apply: a file's past is the
   * file, so a history read takes the read the file itself takes — on the
   * workspace for its own branch's history (`canRead`), at the commit
   * another branch's content was served from (`canReadAtRef`, through
   * `readableAtCommits`, the compare route's own rule), and in batches for
   * the path lists `branch_status` shows.
   */
  accessControl: Pick<IAccessControl, 'canRead' | 'canReadAtRef' | 'canReadBatch' | 'canReadBatchAtRef'>,
  /**
   * The deployment's blocking read hook, told of every file content a history
   * tool serves, as `read_file` tells it — a hook that refuses the read
   * refuses the history too.
   */
  agentAccessGate: AgentAccessGate,
): void {
  const { kbDirName } = kb;
  const mount = (spec: {
    name: string;
    description: string;
    inputs: JsonSchema;
    outputs?: JsonSchema;
    write: boolean;
    /** Register on the internal catalog only (e.g. agent-control tools that make no sense to a remote caller). */
    internalOnly?: boolean;
    /**
     * Skip the auto-injected `branch` input — for a tool that declares its own
     * `branch` with its own meaning (`create_branch`'s fork base,
     * `switch_branch`'s target draft) or none at all (`merge_branch`,
     * `open_change_request`, the repo-global reads). It says NOTHING about
     * whether the tool requires a branch: that is read off the declared schema
     * below, because reading it off this flag is what let `create_branch` opt
     * out of the check while still demanding the input.
     */
    skipBranch?: boolean;
    /** Arguments this tool's handler refuses by name itself (see `ToolDefSpec`). */
    refusesItself?: string[];
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    // Every workflow tool that takes a branch REQUIRES it — the injected input
    // and a hand-declared one (the fork base, the draft to switch to) alike.
    // A hand-declared one is required by its own schema, which `toolDef`
    // reads as `required` too; the tool handler refuses a call without it.
    const def = toolDef({
      name: spec.name,
      description: spec.description,
      path,
      inputs: spec.inputs,
      branch: spec.skipBranch ? undefined : 'required',
      write: spec.write,
      outputs: spec.outputs,
      refusesItself: spec.refusesItself,
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
      // Every path input becomes a repository path here, once, through the one
      // normaliser: the root-anchored `/<kbDirName>/…` form names the same
      // workspace path, and a path with no prefix is placed under
      // `<kbDirName>/` rather than refused.
      toolHandler(
        // These tools hand `branch` STRAIGHT to `workspaceIdForBranch` —
        // they address a workspace by id rather than going through
        // `getFilesystem` — so the branch-less call the tool handler refuses
        // before this runs would otherwise commit to, or fork from, a
        // workspace literally named "undefined".
        (args, ctx) => spec.handler(normalizePathArgs(args, kbDirName), ctx),
        { write: spec.write },
      ),
    );
  };

  // A workspace for a repo-global op (branch listing, change-request reads)
  // that doesn't act on any one draft. All clones share one origin, so any
  // existing one is equivalent — reusing a clone already on disk avoids
  // cloning a branch (or failing when the default branch isn't on the remote)
  // just to run a global op. Falls back to the default branch on a cold start
  // with no workspaces yet.
  const repoGlobalWorkspaceId = async (ctx: ToolContext): Promise<string> =>
    (await ctx.workspaceService.findAnyWorkspaceId()) ?? kb.defaultWorkspaceId();

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
          description: `Workspace-relative path, as write_file expects: under \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash — a path without that prefix is placed under \`${kbDirName}/\`, so it names the same file.`,
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
      // protocol, bypassing the locking filesystem's own guard. The normaliser
      // above has already placed the path inside the clone; this is the check
      // that what came out is really in there, before a lock is taken.
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
      `backend rejects protected names (${protectedInline(kb)}) and filesystem-invalid names — surface ` +
      'those errors verbatim. Convention: `<email-localpart>/<kebab-slug>`. Does NOT switch the ' +
      'agent onto the new draft.',
    // `branch` here is the fork BASE — its own meaning — so skip the generic
    // workspace-`branch` injection ("the branch you are currently working on"),
    // whose wording invites filling in the draft being created instead.
    skipBranch: true,
    // The handler refuses a missing `name` with a message that says what the
    // name is for (`name-required`); the generic check leaves it to that.
    refusesItself: ['name'],
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
      // `name` is declared required too, and the same-name refusal below quotes
      // it. With nothing enforcing it, a call that named neither input compared
      // undefined to undefined, matched, and answered "not 'undefined', the
      // draft being created" — an absent value presented as a draft name, the
      // very sentence this ticket exists to stop. Refused by name instead,
      // without echoing what was not sent.
      if (typeof name !== 'string' || name.length === 0) {
        throw new ToolError('`name` is required: pass the name of the draft to create.', 400, {
          kind: 'name-required',
        });
      }
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
      '`change-request-conflicts` error with affected paths. The author marker is injected server-side. ' +
      'Answers a SUMMARY, not the request\'s content: `url` first (hand it to the user), then `number`, ' +
      '`title`, `state`, `sourceBranch`, `targetBranch`, `approvals` (who must approve each file), ' +
      '`mergeBlockedReasons` (what blocks the merge), and `files` — the changed paths with their kind of ' +
      `change (\`added\` / \`changed\` / \`deleted\` / \`moved\`), cut to ${CHANGE_REQUEST_PATH_LIMIT} of \`totalFiles\`. ` +
      'No patches and no file content: ask for the diffs with `include: ["patches"]` and for every path ' +
      'with `include: ["all-paths"]`. ' +
      'An agent proposes; a person reviews and merges the request in the app — hand the user its `url`.',
    inputs: {
      type: 'object',
      properties: {
        sourceBranch: { type: 'string', minLength: 1, description: 'The draft branch carrying the changes.' },
        targetBranch: { type: 'string', minLength: 1, description: `The branch to apply to (e.g. '${kb.defaultBranch}').` },
        title: { type: 'string', minLength: 1, maxLength: 256, description: 'Short imperative title (≤256 chars).' },
        description: { type: 'string', description: 'Optional markdown body shown verbatim to reviewers.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: [...CHANGE_REQUEST_INCLUDES] },
          description:
            'Add to the default answer, which carries neither: `patches` gives each listed file its unified diff, ' +
            `\`all-paths\` lists every changed path instead of the first ${CHANGE_REQUEST_PATH_LIMIT}. Both may be given. ` +
            'Patches of a large request run to hundreds of thousands of characters — ask for them only when you will read them.',
        },
      },
      required: ['sourceBranch', 'targetBranch', 'title'],
      additionalProperties: false,
    },
    outputs: changeRequestSummarySchema,
    write: true,
    // The workspace this acts on is the SOURCE draft's — `sourceBranch` already
    // names it, so skip the auto-injected (and here redundant) `branch` input
    // rather than asking the model for both and reading the wrong one.
    skipBranch: true,
    // The service still returns the full detail — the app's routes serve the
    // same call and must keep getting it. The shaping happens here, in the
    // answer, so nothing below the tool changes.
    handler: async (args, ctx: ToolContext) =>
      summarizeChangeRequest(
        await ctx.workflowService.openChangeRequest(workspaceIdForBranch(args.sourceBranch as string), ctx.user, {
          sourceBranch: args.sourceBranch as string,
          targetBranch: args.targetBranch as string,
          title: args.title as string,
          description: typeof args.description === 'string' ? args.description : undefined,
        }),
        parseInclude(args.include),
      ),
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
        path: { type: 'string', description: `Repository-relative path of the changed file for a file-level/inline comment (e.g. \`KnowledgeBase/Foo.md\`); the workspace form \`${kbDirName}/KnowledgeBase/Foo.md\`, with or without a leading slash, names the same file.` },
        line: { type: 'integer', minimum: 1, description: 'Line number for an inline comment. Requires `path`.' },
        parentId: { type: 'string', description: 'Comment id to reply to.' },
      },
      required: ['number', 'body'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        comment: { ...commentSchema, description: 'The posted review comment.' },
        changeRequest: { ...changeRequestLinkSchema, description: 'The change request commented on.' },
      },
      required: ['comment', 'changeRequest'],
    },
    write: true,
    // Keyed by change-request number, not a draft — the workspace is only a
    // scratch clone to run the repo op in, so resolve any existing one rather
    // than requiring a `branch`.
    skipBranch: true,
    handler: async (args, ctx: ToolContext) => {
      const number = args.number as number;
      const line = typeof args.line === 'number' ? args.line : undefined;
      // A change request's files are repository-relative; the workspace form
      // Copy path gives (`/<kbDirName>/…`, its slash already dropped by the
      // mount) carries the clone folder, which no changed file would match.
      const path = typeof args.path === 'string' ? stripKbDir(args.path, kbDirName) : undefined;
      if (line !== undefined && !path) {        throw new ToolError('`path` is required when `line` is provided (inline comments anchor to a file).', 400);
      }
      const detail = await ctx.workflowService.getChangeRequestDetail(number, {
        fresh: true,
        workspaceId: await repoGlobalWorkspaceId(ctx),
        viewerEmail: ctx.user.email,
      });
      if (!detail) {        throw new ToolError(`Change request #${number} not found.`, 404);
      }
      // A comment anchors to a commit, and a DECLINED request has none to anchor
      // to: nothing durable records what it proposed, so its detail carries no
      // head (see `changeSourceFor`). Say that, rather than letting the service's
      // `head sha is required` surface as a 400 about an argument the caller
      // never passed. An APPLIED request still takes comments — its head is the
      // source tip its merge commit recorded.
      if (!detail.headSha) {        throw new ToolError(`Change request #${number} is ${detail.state} and has no commit to anchor a comment to.`, 409);
      }
      const comment = await ctx.workflowService.postComment(
        number,
        ctx.user,
        { body: args.body as string, path, line, parentId: typeof args.parentId === 'string' ? args.parentId : undefined },
        detail.headSha,
      );
      return { comment, changeRequest: linkOf(detail) };
    },
  });

  mount({
    name: 'merge_branch',
    description:
      'Merge branch `source` into branch `target` as you, and publish `target`. An agent proposes and syncs; ' +
      'a person merges: this tool never lands a change request. It refuses while a change request from `source` ' +
      'into `target` is open (naming it): ask the user to review it in the app. It refuses ' +
      'when `target` is a protected branch unless you could commit every changed file directly to it. ' +
      'SYNC: merging the target into your draft (`source` = the change request\'s target, `target` = your draft) ' +
      'is always allowed, even with the draft\'s request open. ' +
      'Writes are committed asynchronously; the merge first waits up to 20s for those on `source`. ' +
      'Returns `merged` with the merge commit; `nothing-to-merge` with `target`\'s tip when it already holds ' +
      'all of `source`; `pending-commits` (nothing merged) when writes are still committing — retry shortly — ' +
      'or one failed (`needsAttention`: tell the user); or `conflicts-need-resolution` with the conflicting ' +
      'paths (nothing is written; resolve them on `source` and merge again).',
    // Names both branches itself; the merge runs in `target`'s workspace.
    skipBranch: true,
    inputs: {
      type: 'object',
      properties: {
        source: { type: 'string', minLength: 1, description: 'The branch whose commits are merged in.' },
        target: { type: 'string', minLength: 1, description: 'The branch that receives the merge.' },
      },
      required: ['source', 'target'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        outcome: {
          type: 'object',
          description:
            'A completed merge, a merge with nothing to do, writes on `source` not committed yet ' +
            '(writes are committed asynchronously and the merge waits up to 20 seconds for them), ' +
            'or a signal that conflicts must be resolved first.',
          properties: {
            kind: { type: 'string', enum: ['merged', 'nothing-to-merge', 'pending-commits', 'conflicts-need-resolution'] },
            sha: {
              type: 'string',
              description:
                'Present when `kind` is `merged` (the merge commit, now the tip of `target`) or `nothing-to-merge` ' +
                '(the unchanged tip of `target`, which already held everything on `source`).',
            },
            conflictedPaths: { type: 'array', items: { type: 'string' }, description: 'Present when `kind` is `conflicts-need-resolution`.' },
            branch: { type: 'string', description: 'Present when `kind` is `pending-commits` — the branch whose writes are not committed yet.' },
            pending: { type: 'integer', description: 'Present when `kind` is `pending-commits` — how many commits on that branch are still queued, plus those that failed when `needsAttention` is present.' },
            needsAttention: {
              type: 'string',
              description:
                'Present when `kind` is `pending-commits` and a queued commit failed: the worker\'s message. ' +
                'Waiting will not help; tell the user.',
            },
            message: { type: 'string', description: 'Present when `kind` is `pending-commits` — what to do next.' },
          },
          required: ['kind'],
        },
      },
      required: ['outcome'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const source = args.source;
      const target = args.target;
      if (typeof source !== 'string' || source.length === 0 || typeof target !== 'string' || target.length === 0) {
        throw new ToolError('`source` and `target` are required branch names.', 400);
      }
      return { outcome: await ctx.workflowService.mergeBranch(ctx.user, source, target) };
    },
  });

  mount({
    name: 'delete_branch',
    description:
      'Delete branch `name` from the shared repository and the server. Allowed for the ' +
      'branch\'s author (`<email-localpart>/…`, or your own `suggestions/…` bundle) or an Admin. Refuses a ' +
      'protected branch, a name that is not a branch, a branch with saves still landing or a file held ' +
      '(retry once they land). An open change request from or into it that proposes nothing is closed and the ' +
      'delete goes ahead; one that still proposes something refuses it, naming and linking it: its author ' +
      'withdraws it or an Admin declines it, in the app (one you cannot see is not named, nor in a preview). ' +
      'Refuses a branch holding commits that are not on the ' +
      'default branch, saying how many; `discardUnmerged: true` deletes it anyway and reports them as ' +
      '`discardedCommits`. Refuses if the shared repository is unreachable. Preview with ' +
      '`dryRun: true`: it changes nothing and answers `exists`, `canDelete`, `refusals`, `unmergedCommits`, ' +
      '`openChangeRequests` and `lastCommit`. A preview grants nothing; checks rerun on delete. ' +
      'Answers the deleted branch\'s `lastCommit`.',
    // Names its branch itself; the deletion runs in the default branch's workspace.
    skipBranch: true,
    refusesItself: ['name'],
    inputs: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'The branch to delete.' },
        dryRun: { type: 'boolean', description: 'Report what deleting would do, and change nothing.' },
        discardUnmerged: {
          type: 'boolean',
          description: 'Delete even though the branch holds commits that are not on the default branch. They are lost.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['preview', 'deleted'] },
        branch: { type: 'string' },
        lastCommit: { type: ['string', 'null'], description: 'The branch\'s tip — what a restore starts from. Null in a preview of a branch that does not exist.' },
        discardedCommits: { type: 'integer', description: 'When `kind` is `deleted`: commits not on the default branch that went with it.' },
        exists: { type: 'boolean', description: 'When `kind` is `preview`.' },
        canDelete: { type: 'boolean', description: 'When `kind` is `preview`: whether a delete asked for now would go through.' },
        refusals: { type: 'array', items: { type: 'string' }, description: 'When `kind` is `preview`: why it would not.' },
        unmergedCommits: { type: 'integer', description: 'When `kind` is `preview`: commits not on the default branch.' },
        openChangeRequests: {
          type: 'array',
          description: 'When `kind` is `preview`: open change requests from (`source`) or into (`target`) the branch that you can see.',
          items: {
            type: 'object',
            properties: {
              number: { type: 'integer' },
              end: { type: 'string', enum: ['source', 'target'] },
              url: { type: 'string', description: 'Link to the request in the app.' },
              proposesNothing: { type: 'boolean', description: 'True when the delete would close it rather than be refused by it.' },
            },
            required: ['number', 'end', 'url', 'proposesNothing'],
          },
        },
      },
      required: ['kind', 'branch', 'lastCommit'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const name = args.name;
      if (typeof name !== 'string' || name.length === 0) {
        throw new ToolError('`name` is required: pass the name of the branch to delete.', 400, {
          kind: 'name-required',
        });
      }
      return ctx.workflowService.deleteBranchChecked(ctx.user, name, {
        dryRun: args.dryRun === true,
        discardUnmerged: args.discardUnmerged === true,
        maySee: (number) => maySeeChangeRequest(ctx, number),
      });
    },
  });

  // `merge_change_request` is retired: a change request is merged by a person
  // in the app. It is in no catalog, but a caller holding an old manual still
  // posts to its path — answer with who merges now, not a bare 404.
  router.post('/agent/tools/merge_change_request', toolAuth, (_req, res) => {
    res.status(410).json({ error: RETIRED_TOOL_MESSAGES.merge_change_request });
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

  // ── History and syncing ────────────────────────────────────────────────────
  //
  // What the app's History tab, compare view and "update from target" do,
  // as tools: the agent never runs git itself. Each reads through the
  // workflow service's gated methods and takes the per-file read the file
  // itself takes.

  /** The branch's workspace, made when it is not on disk yet, and its id. */
  const workspaceOf = async (ctx: ToolContext, branch: string): Promise<string> => {
    await ctx.workspaceService.getOrCreateForBranch(branch);
    return workspaceIdForBranch(branch);
  };

  /**
   * The per-file read gate on the workspace's own branch, and the
   * deployment's read hook told of the read (as `read_file` tells it);
   * answers the repository-relative path.
   */
  const requireRead = async (ctx: ToolContext, branch: string, workspaceId: string, path: string): Promise<string> => {
    const rel = stripKbDir(path, kbDirName);
    await notifyAgentRead(agentAccessGate, ctx, branch, path);
    if (!(await accessControl.canRead(workspaceId, ctx.user.email, rel))) {
      throw new ToolError(`You don't have permission to read "${rel}".`, 403, { kind: 'read-denied', path: rel });
    }
    return rel;
  };

  /**
   * The per-file read gate for content served from ANOTHER branch — the
   * compare route's rule: at every commit the branch resolves to (the one
   * the service serves it from, and its other tip when the local head and
   * the published tip differ), all of which must grant, asked by the
   * service inside its reservation before anything is said about the path
   * there.
   */
  const requireReadAtCommits = (ctx: ToolContext, workspaceId: string, rel: string, commits: readonly string[], branch: string): Promise<void> =>
    assertReadableAtCommits(accessControl, workspaceId, ctx.user.email, rel, commits, branch);

  /** Which of `paths` the caller may read at `origin/<base>` — the change-request reads' rule, `readablePathsAt`. */
  const readableAt = (ctx: ToolContext, workspaceId: string, base: string, paths: string[]): Promise<Set<string>> =>
    readablePathsAt(accessControl, workspaceId, ctx.user.email, base, paths);


  mount({
    name: 'list_file_changes',
    description:
      'The history of one file on `branch`: its commits, newest first — who made each, when, and its ' +
      'subject — as the app\'s History tab shows them. `limit` caps the list (default 20, at most 100). ' +
      'Read a version with `read_file_at` and its diff with `compare_file`. Takes the read the file itself ' +
      'takes; a folder has no history of its own (ask per file).',
    inputs: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'The file, workspace-relative (as `read_file` takes it).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many commits at most (default 20).' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, repository-relative.' },
        changes: { type: 'array', items: commitSchema, description: 'Newest first.' },
      },
      required: ['path', 'changes'],
    },
    write: false,
    handler: async (args, ctx: ToolContext) => {
      const branch = args.branch as string;
      const path = args.path;
      if (typeof path !== 'string' || path.length === 0) throw new ToolError('`path` is required.', 400);
      const workspaceId = await workspaceOf(ctx, branch);
      const rel = await requireRead(ctx, branch, workspaceId, path);
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const changes = await ctx.workflowService.listChangesForFile(workspaceId, path, limit);
      return { path: rel, changes };
    },
  });

  mount({
    name: 'read_file_at',
    description:
      'One file as it was at a point in history: `at` is a commit (from `list_file_changes`, on `branch`\'s ' +
      'own history) or the name of another branch (its published tip). Answers `content` (null when the ' +
      'file was not there) and `sha`, the commit it was read at; for a commit, also `before`, the file ' +
      'just before that commit. To put an earlier version back, write it with `write_file`. Takes the read ' +
      'the file takes at that point.',
    inputs: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'The file, workspace-relative.' },
        at: { type: 'string', minLength: 1, description: 'A commit sha, or a branch name.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['path', 'at'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, repository-relative.' },
        at: { type: 'string', description: 'What was asked for.' },
        kind: { type: 'string', enum: ['commit', 'branch'] },
        sha: { type: 'string', description: 'The commit the content was read at.' },
        content: { type: ['string', 'null'], description: 'The file at that commit; null when it was not there.' },
        before: { type: ['string', 'null'], description: 'For a commit: the file just before it; null when it was not there (or the commit is the first).' },
      },
      required: ['path', 'at', 'kind', 'sha', 'content'],
    },
    write: false,
    handler: async (args, ctx: ToolContext) => {
      const branch = args.branch as string;
      const path = args.path;
      const at = args.at;
      if (typeof path !== 'string' || path.length === 0) throw new ToolError('`path` is required.', 400);
      if (typeof at !== 'string' || at.length === 0) throw new ToolError('`at` is required: a commit sha or a branch name.', 400);
      const workspaceId = await workspaceOf(ctx, branch);
      // The hook and the workspace gate first, whichever point in history is
      // read: the file is this workspace's file.
      const rel = await requireRead(ctx, branch, workspaceId, path);
      if (isCommitSha(at)) {
        const { baseline, current } = await ctx.workflowService.fileAtChange(workspaceId, path, at);
        return { path: rel, at, kind: 'commit', sha: at, content: current, before: baseline };
      }
      // Read at the branch's published tip, authorized at that very commit
      // inside the read — before anything is said about the path there,
      // the folder refusal included: the ref is a name a fetch may move
      // between a verdict and a read; the commit is not.
      const read = await ctx.workflowService.fileAtBranch(workspaceId, path, at, (commits) => requireReadAtCommits(ctx, workspaceId, rel, commits, at));
      return { path: rel, at, kind: 'branch', sha: read.sha, content: read.content };
    },
  });

  mount({
    name: 'compare_file',
    description:
      'The unified diff of one file: between two branches (`from`, `to`; either may be `branch` itself), ' +
      'or of one commit on `branch` (`at`: what that commit changed in the file). Empty when identical. ' +
      'Takes the read the file takes on each side.',
    inputs: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'The file, workspace-relative.' },
        from: { type: 'string', minLength: 1, description: 'A branch: the diff\'s left side.' },
        to: { type: 'string', minLength: 1, description: 'A branch: the diff\'s right side.' },
        at: { type: 'string', minLength: 1, description: 'A commit sha on `branch`: the diff that commit made in the file.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, repository-relative.' },
        diff: { type: 'string', description: 'A unified diff; empty when the two sides are identical.' },
      },
      required: ['path', 'diff'],
    },
    write: false,
    handler: async (args, ctx: ToolContext) => {
      const branch = args.branch as string;
      const path = args.path;
      if (typeof path !== 'string' || path.length === 0) throw new ToolError('`path` is required.', 400);
      const workspaceId = await workspaceOf(ctx, branch);
      // As the compare route: the workspace's own gate on the path (the
      // checked-out side can be served from the working tree), then each
      // compared side at the commit it was served from.
      const rel = await requireRead(ctx, branch, workspaceId, path);
      if (typeof args.at === 'string' && args.at.length > 0) {
        if (!isCommitSha(args.at)) throw new ToolError('`at` must be a full commit sha.', 400);
        return { path: rel, diff: await ctx.workflowService.showFileAtChange(workspaceId, path, args.at) };
      }
      const from = args.from;
      const to = args.to;
      if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || to.length === 0) {
        throw new ToolError('Give `from` and `to` (two branches), or `at` (one commit).', 400);
      }
      const compared = await ctx.workflowService.compareFile(workspaceId, path, from, to, async (sides) => {
        await requireReadAtCommits(ctx, workspaceId, rel, sides.from, from);
        await requireReadAtCommits(ctx, workspaceId, rel, sides.to, to);
      });
      return { path: rel, diff: compared.diff };
    },
  });

  mount({
    name: 'branch_status',
    description:
      'Where `branch` stands, before proposing or syncing a draft. Answers whether it is on the shared ' +
      'repository, how far ahead of and behind its upstream it is, whether the shared branch has commits this ' +
      'workspace lacks (`behindRemote`: `update_branch` brings them in), the files written but not committed ' +
      'yet, the protected branch it was forked from (`forkBase`), and `changedPaths`: what it changes against ' +
      '`base` (default: the fork base) — the files a change request into it would carry.',
    inputs: {
      type: 'object',
      properties: {
        base: { type: 'string', minLength: 1, description: 'The branch to compare against (default: the fork base).' },
        sessionId: SESSION_ID_INPUT,
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        branch: { type: 'string' },
        isProtected: { type: 'boolean' },
        hasRemote: { type: 'boolean', description: 'True when the shared repository has the branch.' },
        ahead: { type: ['integer', 'null'], description: 'Commits ahead of the upstream (or the fork base); null when unresolved.' },
        behind: { type: ['integer', 'null'], description: 'Commits behind; null when unresolved.' },
        behindRemote: { type: 'boolean', description: 'The shared branch has commits this workspace has not merged yet.' },
        uncommittedPaths: { type: 'array', items: { type: 'string' }, description: 'Written but not committed yet (saves still landing).' },
        forkBase: { type: ['string', 'null'], description: 'The protected branch this one was forked from; null when none can be reached.' },
        base: { type: ['string', 'null'], description: 'What `changedPaths` is against.' },
        changedPaths: { type: 'array', items: { type: 'string' }, description: 'Repository-relative; rename-aware; only the paths you may read. Empty when `base` is null.' },
        withheldPaths: { type: 'integer', description: 'How many changed or uncommitted paths were left out because you may not read them.' },
      },
      required: ['branch', 'isProtected', 'hasRemote', 'ahead', 'behind', 'behindRemote', 'uncommittedPaths', 'forkBase', 'base', 'changedPaths', 'withheldPaths'],
    },
    write: false,
    handler: async (args, ctx: ToolContext) => {
      const branch = args.branch as string;
      const workspaceId = await workspaceOf(ctx, branch);
      // Each read below takes the workspace's reservation on its own: this
      // is a REPORT of independent facts, not a range measured across steps,
      // and a save or sync landing between two of them is tolerated — the
      // next call reports it. (The one answer that must be exact, what a
      // merge is of, is taken under one reservation by `update_branch`.)
      const [status, branches, pending, forkBase] = await Promise.all([
        ctx.workflowService.branchStatus(workspaceId),
        ctx.workflowService.listBranches(workspaceId),
        ctx.workflowService.listPendingChangePaths(workspaceId),
        ctx.workflowService.resolveForkBase(workspaceId, branch),
      ]);
      const info = branches.find((b) => b.name === branch);
      const base = typeof args.base === 'string' && args.base.length > 0 ? args.base : forkBase;
      // A path's name is information too: the changed paths are shown as the
      // change-request reads show them (readable at `origin/<base>`), the
      // uncommitted ones as the workspace's own listing would.
      const changedAll =
        base && base !== branch ? await ctx.workflowService.changedPathsBetweenBranches(workspaceId, base, branch) : [];
      const readableChanged = base ? await readableAt(ctx, workspaceId, base, changedAll) : new Set<string>();
      const changedPaths = changedAll.filter((p) => readableChanged.has(p));
      const pendingRel = pending.map((p) => stripKbDir(p, kbDirName));
      const pendingVerdicts = pendingRel.length > 0 ? await accessControl.canReadBatch(workspaceId, ctx.user.email, pendingRel) : new Map<string, boolean>();
      const uncommittedPaths = pendingRel.filter((p) => pendingVerdicts.get(p) === true);
      return {
        branch,
        isProtected: info?.isProtected ?? kb.protectedBranches.has(branch),
        hasRemote: info?.hasRemote ?? status.hasUpstream,
        ahead: info?.ahead ?? null,
        behind: info?.behind ?? null,
        behindRemote: status.unmergedFromUpstream,
        uncommittedPaths,
        forkBase,
        base: base && base !== branch ? base : null,
        changedPaths,
        withheldPaths: changedAll.length - changedPaths.length + (pendingRel.length - uncommittedPaths.length),
      };
    },
  });

  mount({
    name: 'update_branch',
    description:
      'Bring another branch into `branch` as a merge commit by you, and publish it: `from` (a draft\'s ' +
      'target, to refresh the draft), or left out, the branch\'s own shared state when it moved while this ' +
      'workspace held commits (`branch_status` says `behindRemote`). Never a protected branch. CONFLICTS: ' +
      'the first call answers `conflicts` naming every conflicted path with the file at the merge base, on ' +
      'each side (`ours` = `branch`, `theirs` = `from`) and the working copy with git\'s markers, and leaves ' +
      'the branch as it was. Decide each file (keep both sides\' information unless one is clearly stale; ' +
      '`list_file_changes` shows intent), then call again with `resolutions`, one per conflicted path: ' +
      '`content` (the resolved text) or `choose` (`ours`, `theirs`, `delete`). Only conflicted paths are ' +
      'written here; other edits go through the file tools. Answers `merged`, `nothing-to-merge`, ' +
      '`conflicts` again (something changed meanwhile), or `pending-commits` (writes still landing: retry).',
    inputs: {
      type: 'object',
      properties: {
        from: { type: 'string', minLength: 1, description: 'The branch to bring in (default: this branch\'s own shared state).' },
        sessionId: SESSION_ID_INPUT,
        resolutions: {
          type: 'array',
          description: 'One per conflicted path, from a previous `conflicts` answer.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1, description: 'The conflicted path, as the answer named it.' },
              content: { type: 'string', description: 'The resolved text of the file.' },
              choose: { type: 'string', enum: ['ours', 'theirs', 'delete'], description: 'Keep one side whole, or drop the file.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['merged', 'nothing-to-merge', 'conflicts', 'pending-commits'] },
        from: { type: 'string', description: 'The branch brought in.' },
        sha: { type: 'string', description: '`merged`: the merge commit, now the tip of `branch`, published; `nothing-to-merge`: the unchanged tip.' },
        resolvedPaths: { type: 'array', items: { type: 'string' }, description: '`merged`: the conflicts the resolutions settled.' },
        mergeBase: { type: ['string', 'null'], description: '`conflicts`: the common ancestor; null when the histories are unrelated.' },
        ours: { type: 'string', description: '`conflicts`: the tip of `branch`.' },
        theirs: { type: 'string', description: '`conflicts`: the tip of `from`.' },
        files: {
          type: 'array',
          description:
            '`conflicts`: every conflicted path you may read, with the file at the base, on each side, and the marked-up ' +
            'working copy. A side is null when that side has no file — or when `truncated` names it (too large or not ' +
            'text): then read `ours` with `read_file`, `theirs` with `read_file_at` at `from`, `base` with `read_file_at` ' +
            'at `mergeBase`.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              base: { type: ['string', 'null'] },
              ours: { type: ['string', 'null'] },
              theirs: { type: ['string', 'null'] },
              merged: { type: ['string', 'null'] },
              truncated: { type: 'array', items: { type: 'string', enum: ['base', 'ours', 'theirs', 'merged'] } },
            },
            required: ['path', 'base', 'ours', 'theirs', 'merged'],
          },
        },
        unresolved: { type: 'array', items: { type: 'string' }, description: '`conflicts`: the paths you may read that no resolution covered.' },
        withheldConflicts: {
          type: 'integer',
          description:
            '`conflicts`: how many conflicted files were left out because you may not read them on one of the two branches. ' +
            'They are not yours to settle: ask a person who can read them to update the draft in the app.',
        },
        branch: { type: 'string', description: '`pending-commits`: the branch whose writes are not committed yet.' },
        pending: { type: 'integer', description: '`pending-commits`: how many.' },
        needsAttention: { type: 'string', description: '`pending-commits`: a queued commit failed; the worker\'s message. Tell the user.' },
        message: { type: 'string', description: '`pending-commits`: what to do next.' },
      },
      required: ['kind'],
    },
    write: true,
    handler: async (args, ctx: ToolContext) => {
      const branch = args.branch as string;
      const from = args.from;
      if (from !== undefined && (typeof from !== 'string' || from.length === 0)) {
        throw new ToolError('`from` must be a branch name.', 400);
      }
      let resolutions: { path: string; content?: string; choose?: 'ours' | 'theirs' | 'delete' }[] | undefined;
      if (args.resolutions !== undefined) {
        if (!Array.isArray(args.resolutions)) throw new ToolError('`resolutions` must be a list.', 400);
        resolutions = args.resolutions.map((r: unknown, i: number) => {
          const entry = r as Record<string, unknown>;
          if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
            throw new ToolError(`resolutions[${i}]: \`path\` is required.`, 400);
          }
          const out: { path: string; content?: string; choose?: 'ours' | 'theirs' | 'delete' } = { path: entry.path };
          if (entry.content !== undefined) {
            if (typeof entry.content !== 'string') throw new ToolError(`resolutions[${i}]: \`content\` must be text.`, 400);
            out.content = entry.content;
          }
          if (entry.choose !== undefined) {
            if (entry.choose !== 'ours' && entry.choose !== 'theirs' && entry.choose !== 'delete') {
              throw new ToolError(`resolutions[${i}]: \`choose\` is \`ours\`, \`theirs\` or \`delete\`.`, 400);
            }
            out.choose = entry.choose;
          }
          return out;
        });
      }
      const workspaceId = await workspaceOf(ctx, branch);
      /**
       * Whether the caller may read `rel` on both sides of this merge — at
       * the two COMMITS the answer says the merge was of, which is what its
       * bytes are from, never at a branch ref that may have moved since the
       * reservation was released — with the deployment's read hook told of
       * the read, as every history read tells it: a hook that refuses makes
       * the file one the caller may not read; a hook that fails is not an
       * answer and propagates.
       */
      const mayReadBothSides = async (rel: string, at: { ours: string; theirs: string }): Promise<boolean> => {
        try {
          await notifyAgentRead(agentAccessGate, ctx, branch, `${kbDirName}/${rel}`);
        } catch (err) {
          // A hook's own refusal carries a status; anything else is a failure of the hook, not an answer.
          if (hasHttpStatus(err)) return false;
          throw err;
        }
        return readableAtCommits(accessControl, workspaceId, ctx.user.email, rel, [at.ours, at.theirs]);
      };
      // A resolution reads a file on both branches and writes it on the
      // draft, so the deployment's hooks are asked as they are for any read
      // and any write. The access model's own verdicts — may the caller read
      // the file on both branches, may they change it on the draft — are the
      // service's, asked inside the merge against the source commit as
      // fetched (`updateBranch`), so a rule that changed with the source
      // cannot be outrun by a check made before it was fetched.
      for (const r of resolutions ?? []) {
        const wsPath = `${kbDirName}/${stripKbDir(r.path, kbDirName)}`;
        try {
          await notifyAgentRead(agentAccessGate, ctx, branch, wsPath);
        } catch (err) {
          if (hasHttpStatus(err)) {
            throw new ToolError(`You may not read "${stripKbDir(r.path, kbDirName)}" here, so it is not yours to settle.`, 403, {
              kind: 'read-denied',
              path: stripKbDir(r.path, kbDirName),
            });
          }
          throw err;
        }
        await assertAgentWriteAllowed(agentAccessGate, ctx, branch, wsPath);
      }
      // A resolution's content lands on the draft by the merge, not by the
      // file tools' filesystem: it takes the same pre-disk gate that
      // filesystem runs (`roles.yaml` must parse, no new role, no unknown
      // group), handed to the service to ask before the merge.
      const outcome =
        resolutions !== undefined
          ? await ctx.workflowService.updateBranch(workspaceId, ctx.user, {
              ...(from !== undefined ? { from } : {}),
              resolutions,
              validateWrite: await ctx.getWriteValidator(branch),
            })
          : await ctx.workflowService.updateBranch(workspaceId, ctx.user, from !== undefined ? { from } : {});
      if (outcome.kind !== 'conflicts') return outcome;
      // A conflict answer carries the file on both branches, and a path's
      // name is information too: a file the caller may not read on both is
      // left out of `files` and `unresolved` alike and only counted.
      const files = [];
      for (const f of outcome.files) if (await mayReadBothSides(f.path, outcome)) files.push(f);
      const shown = new Set(files.map((f) => f.path));
      return {
        ...outcome,
        files,
        unresolved: outcome.unresolved.filter((p) => shown.has(p)),
        withheldConflicts: outcome.files.length - files.length,
      };
    },
  });
}
