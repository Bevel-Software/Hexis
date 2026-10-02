import type { Router, RequestHandler } from 'express';
import type {
  ChangeRequest,
  ChangeRequestDetail,
  ChangedPathPair,
  FileApproval,
} from '@bevel-software/platform-shared';
import type { IToolRegistry, JsonSchema } from '../../tool-registry/tool.contract.js';
import { ToolError, type ToolContext, type ToolHandler } from '../../tool-helpers/tool.contract.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { KbContext } from '../../../shared/kb-context.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import {
  PER_PAGE_DEFAULT,
  PER_PAGE_MAX,
  fileIsReadable,
  isAuthor,
  matchesAuthor,
  pathsOf,
  maySeeChangeRequest,
  pageOf,
  pagingOf,
  statesFor,
  toCrComment,
  toCrDetail,
  toCrFile,
  toCrReviews,
  toCrSummary,
  toCrViewer,
  visibleBlockers,
  visibleComments,
} from './change-request-read-shape.js';

/**
 * The five read tools over change requests, named and shaped after GitHub's
 * pull-request API: `list_change_requests`, `get_change_request`,
 * `list_change_request_files`, `list_change_request_reviews` and
 * `list_change_request_comments`. The mapping lives in
 * `change-request-read-shape.ts`; this file does the IO and the access
 * filtering.
 *
 * They ANSWER in Hexis's own vocabulary, not GitHub's field names (Razvan's
 * decision on the review of PR #347, 2026-10-02): every field shared with
 * `open_change_request`'s summary takes that summary's name, and the rest follow
 * its style, so an agent opens a change request and reads it back in one
 * vocabulary. Their INPUTS keep GitHub's filter names, which the ticket pins.
 * The shape module's header says what that changed, field by field.
 *
 * None of them writes anything — every handler is registered `write: false`,
 * so a read-scoped connection key may call all five, and every service call
 * below is a read.
 *
 * ## What the caller may see
 *
 * The app's own change-request routes serve the whole list and the whole
 * detail to any signed-in viewer; only the file CONTENT routes gate per path
 * (`canReadAtRef` at `origin/<base>`, with an unresolvable verdict as a
 * denial). These tools apply that same content gate to the whole payload,
 * because an agent's answer is the content: a file list, a reviewer's comment
 * and a gate warning all name paths, and an agent hands what it reads to
 * whoever it is talking to.
 *
 * So, per request:
 *
 *   - every path is resolved at `origin/<base>` — the target's access tree, the
 *     one the request is asking to be judged against — in ONE batched lookup;
 *   - BOTH names of a moved file are resolved, and a file is readable only if
 *     both are: the diff of a move shows what was at the old path, so a file
 *     moved out of a closed folder stays closed, however open its new home.
 *     The LIST decides this over the same `touchedNodeFiles` pairs the detail
 *     does — a list that judged the flat `touchedNodePaths` could not see a
 *     move's old side, and advertised requests its own by-number tools
 *     answered 404 for;
 *   - files the caller may not read are left out and counted in
 *     `withheldFiles`, never named (decision 2 on the ticket);
 *   - comments on a withheld file, and gate blockers naming one, go the same
 *     way, with their own counts; a REPLY goes when the comment it replies to
 *     does, up the whole chain;
 *   - `body` is the author's own description, with the generated
 *     `## Affected owners` block cut off the end — see `authorsDescription`;
 *   - a request with no readable file and no claim of authorship answers 404,
 *     indistinguishable from a number that was never issued.
 *
 * ## Reading a request that is no longer open
 *
 * A MERGED request is read from the merge commit its row records: its branch is
 * retired, but the commit holds exactly the change that landed, so its file list
 * is recovered from there and filtered by access like an open request's (the
 * 2026-10-02 decision). Nothing in that path touches the network — the commit is
 * in the clone or it is not.
 *
 * A DECLINED request has no merge commit and no branch left to diff, so its file
 * set cannot be resolved at all; it fails closed, and is therefore readable by
 * its author alone. "We cannot tell what this request touched" is not "you may
 * see it", and an empty path set is the same answer `scopeApplyFailures` already
 * refuses to grant anything on. The same holds for any request whose file set
 * does not resolve — an access tree that will not load at `origin/<base>`, or a
 * clone that does not have the merge commit yet.
 */
export function registerChangeRequestReadTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  accessControl: Pick<IAccessControl, 'canReadBatchAtRef'>,
  kb: Pick<KbContext, 'defaultWorkspaceId'>,
): void {
  /**
   * Mount one read tool. Every one of them is keyed by a change-request number
   * (or by nothing at all), never by a draft, so none declares the injected
   * `branch` input — the clone a verdict is resolved in is a scratch clone of
   * the one shared origin, not anybody's working branch.
   */
  const mount = (spec: {
    name: string;
    description: string;
    inputs: JsonSchema;
    outputs: JsonSchema;
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    const def = toolDef({
      name: spec.name,
      description: spec.description,
      path,
      inputs: spec.inputs,
      outputs: spec.outputs,
      tags: ['workflow'],
    });
    registry.registerInternalTool(def);
    registry.registerExternalTool(def);
    router.post(path.slice('/api'.length), toolAuth, toolHandler(spec.handler, { write: false }));
  };

  /**
   * A clone to resolve access verdicts in. All clones track the same origin and
   * every verdict here is read at `origin/<base>`, so any existing one answers
   * identically — reusing one avoids cloning a branch just to read a ref.
   */
  const repoGlobalWorkspaceId = async (ctx: ToolContext): Promise<string> =>
    (await ctx.workspaceService.findAnyWorkspaceId()) ?? kb.defaultWorkspaceId();

  /** A change-request number as the tools accept it. */
  const numberArg = (args: Record<string, unknown>): number => {
    const n = args.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new ToolError('`number` is required and must be a positive integer.', 400);
    }
    return n;
  };

  /**
   * Read verdicts for `paths` at `origin/<base>`, as a membership set of what
   * the caller MAY read. A null answer (the ref or its `roles.yaml` does not
   * resolve) withholds everything, which is the same reading the app's
   * fork-point route gives it.
   */
  const readablePaths = async (
    ctx: ToolContext,
    workspaceId: string,
    base: string,
    paths: string[],
  ): Promise<Set<string>> => {
    if (paths.length === 0) return new Set();
    const verdicts = await accessControl.canReadBatchAtRef(
      workspaceId,
      `origin/${base}`,
      ctx.user.email,
      [...new Set(paths)],
    );
    if (!verdicts) return new Set();
    return new Set([...verdicts].filter(([, allowed]) => allowed).map(([p]) => p));
  };

  /**
   * The detail of request `number` with the access filter applied, or a 404 —
   * the one place the four by-number tools get their data, so they cannot
   * drift on who may see what.
   */
  interface ScopedDetail {
    detail: ChangeRequestDetail;
    /**
     * Whether the caller may read one path of this request — the raw per-path
     * verdict, as the access tree gives it at `origin/<base>`.
     */
    mayRead: (path: string) => boolean;
    /**
     * Whether this request may NAME `path` to the caller — `mayRead`, minus
     * every name a withheld file goes by. The ONE verdict the tools below ask
     * about a path, so none of them can decide it a second way.
     *
     * The two differ on exactly one shape, and it is the shape that leaks: a
     * file moved out of a folder the caller may not read is readable under
     * its NEW name, yet `fileIsReadable` withholds it whole (its diff shows the
     * old path's content). Anything keyed on that new path — an approval, a
     * comment anchored to it — would otherwise say the request touches a file
     * the file tool refuses to list, under a name it refuses to print.
     */
    mayShow: (path: string) => boolean;
    /** The request's files the caller may read, in the request's own order. */
    readableFiles: ChangeRequestDetail['files'];
    /**
     * Every name the withheld files go by — for filtering the gate blockers and
     * for deciding `mayShow`. NEVER answered: use `withheldFileCount` to report
     * them.
     */
    withheldFilePaths: string[];
    /** How many files are withheld. One per file, whatever its move names. */
    withheldFileCount: number;
    viewerIsAuthor: boolean;
  }

  const scopedDetail = async (
    ctx: ToolContext,
    number: number,
    opts: { patches: boolean },
  ): Promise<ScopedDetail> => {
    const workspaceId = await repoGlobalWorkspaceId(ctx);
    const detail = await ctx.workflowService.getChangeRequestDetail(number, {
      workspaceId,
      viewerEmail: ctx.user.email,
      patches: opts.patches,
    });
    if (!detail) throw notFound(number);
    const viewerIsAuthor = isAuthor(detail, ctx.user.email);
    // Comment paths join the batch: a comment may name a file the request no
    // longer changes, and without a verdict of its own it would be withheld
    // from a caller who can read it perfectly well.
    const commentPaths = detail.comments.map((c) => c.path).filter((p): p is string => !!p);
    // BOTH names of every file: a move is judged on its old path as well as
    // its new one, because the diff of a move shows what was at the old one.
    const readable = await readablePaths(ctx, workspaceId, detail.base, [
      ...detail.files.flatMap(pathsOf),
      ...commentPaths,
    ]);
    const mayRead = (path: string) => readable.has(path);
    const readableFiles = detail.files.filter((f) => fileIsReadable(f, mayRead));
    if (!maySeeChangeRequest({ readableFiles: readableFiles.length, isAuthor: viewerIsAuthor })) {
      throw notFound(number);
    }
    // Every name a withheld file goes by, so a gate warning quoting either
    // spelling is caught by the blocker filter — and so `mayShow` catches
    // whichever spelling an approval or a comment happens to use.
    const withheldFilePaths = detail.files
      .filter((f) => !fileIsReadable(f, mayRead))
      .flatMap(pathsOf);
    const withheldNames = new Set(withheldFilePaths);
    return {
      detail,
      mayRead,
      mayShow: (path: string) => mayRead(path) && !withheldNames.has(path),
      readableFiles,
      withheldFilePaths,
      withheldFileCount: detail.files.length - readableFiles.length,
      viewerIsAuthor,
    };
  };

  /**
   * The same answer for a number that was never issued and for one the caller
   * may not see — requirement 7. Says nothing a probe could tell apart.
   */
  const notFound = (number: number): ToolError =>
    new ToolError(`Change request #${number} not found.`, 404);

  /**
   * The changed files of a SUMMARY, as the pairs a read gate decides over.
   *
   * Absent `touchedNodeFiles` means no summary builder filled it, and that is
   * answered with no files rather than by falling back to `touchedNodePaths`:
   * the fallback cannot pair a move, which is the whole reason this field
   * exists, and a silent one would restore the list-versus-detail disagreement
   * the next time a summary reached here from somewhere new. No files means
   * nothing proven, which means author-only — the same fail-closed reading an
   * empty path set already gets.
   */
  const filesOf = (cr: ChangeRequest): ChangedPathPair[] => cr.touchedNodeFiles ?? [];

  /** `approvals` is one entry per file, same order; index it by path. */
  const approvalsByPath = (detail: ChangeRequestDetail): Map<string, FileApproval> =>
    new Map(detail.approvals.map((a) => [a.path, a]));

  // ── Shared output sub-schemas ─────────────────────────────────────────────

  const userSchema: JsonSchema = {
    type: 'object',
    properties: {
      login: { type: 'string', description: 'Hash-derived login (`user-<12 hex>`); no raw address.' },
      name: { type: 'string' },
      email: { type: 'string', description: 'Set for comment authors and approvers only.' },
    },
    required: ['login'],
  };

  const changeRequestSchema: JsonSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Link a person can open. First field: hand this to the user.' },
      urlNote: { type: 'string', description: 'Present only when `url` is relative.' },
      number: { type: 'integer' },
      title: { type: 'string' },
      state: { type: 'string', enum: ['open', 'merged', 'closed'], description: "Hexis's own state: `merged` is applied, `closed` declined." },
      author: userSchema,
      sourceBranch: { type: 'string', description: 'The branch the change comes from.' },
      targetBranch: { type: 'string', description: 'The branch it would be applied to.' },
      createdAt: { type: 'string', description: 'ISO timestamp.' },
      updatedAt: { type: 'string', description: 'ISO timestamp — the close time of a closed request, else the creation time.' },
      changedFiles: { type: 'integer', description: 'How many of its files YOU may read.' },
      withheldFiles: { type: 'integer', description: 'How many of its files you may not read. Never named.' },
    },
    required: ['url', 'number', 'title', 'state', 'author', 'sourceBranch', 'targetBranch', 'createdAt', 'updatedAt', 'changedFiles', 'withheldFiles'],
  };

  const pagingOutputs: Record<string, JsonSchema> = {
    totalCount: { type: 'integer', description: 'Entries you may read, across all pages.' },
    page: { type: 'integer' },
    perPage: { type: 'integer' },
    hasNextPage: { type: 'boolean', description: 'True when a further page exists.' },
  };

  const pagingRequired = ['totalCount', 'page', 'perPage', 'hasNextPage'];

  const pagingInputs: Record<string, JsonSchema> = {
    per_page: { type: 'integer', minimum: 1, maximum: PER_PAGE_MAX, description: `Entries per page (default ${PER_PAGE_DEFAULT}, at most ${PER_PAGE_MAX}).` },
    page: { type: 'integer', minimum: 1, description: 'Page number, from 1.' },
  };

  // ── list_change_requests ──────────────────────────────────────────────────

  mount({
    name: 'list_change_requests',
    description:
      'List change requests (GitHub: list pull requests), newest first. Filter by `state` ' +
      '(`open`, the default, `closed` — which covers applied and declined alike — or `all`), ' +
      '`head` (source branch), `base` (target branch) and `author` (an email or a `login`). ' +
      "Each answers in Hexis's own words: `url`, `number`, `title`, `state` (`open`, `merged` or " +
      '`closed`), `sourceBranch`, `targetBranch`. Read-only, and limited to what you may read: a ' +
      'request whose files are all closed to you is not listed unless you opened it, and ' +
      '`withheldFiles` counts the ones left out of each.',
    inputs: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default `open`. `closed` covers applied and declined alike; the answer says which.' },
        head: { type: 'string', description: 'Source branch — list only requests coming FROM it.' },
        base: { type: 'string', description: 'Target branch — list only requests going INTO it.' },
        author: { type: 'string', description: "The author's email, or their `author.login`." },
        ...pagingInputs,
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        changeRequests: { type: 'array', items: changeRequestSchema },
        ...pagingOutputs,
      },
      required: ['changeRequests', ...pagingRequired],
    },
    handler: async (args, ctx: ToolContext) => {
      const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open';
      const head = typeof args.head === 'string' ? args.head : undefined;
      const base = typeof args.base === 'string' ? args.base : undefined;
      const author = typeof args.author === 'string' ? args.author : undefined;
      const { perPage, page } = pagingOf(args);

      const all = await ctx.workflowService.listChangeRequestsByState(statesFor(state));
      const matching = all.filter(
        (cr) =>
          (head === undefined || cr.branch === head) &&
          (base === undefined || cr.base === base) &&
          (author === undefined || matchesAuthor(cr, author)),
      );

      // One access lookup per distinct target branch, not per request: the
      // access tree is read at `origin/<base>`, and a list is usually a dozen
      // requests into the same two or three targets.
      //
      // Over `touchedNodeFiles`, NOT `touchedNodePaths`. The flat list reports a
      // move under its new name alone, so a file moved out of a folder this
      // caller cannot open looked readable here while the detail — which pairs
      // the two names — refused it: the list advertised a change request that
      // all four by-number tools answered 404 for, and counted its withheld
      // file as zero. One notion of a readable file, shared with the detail
      // through the same `fileIsReadable`, is what stops the two disagreeing.
      const workspaceId = await repoGlobalWorkspaceId(ctx);
      const byBase = new Map<string, string[]>();
      for (const cr of matching) {
        const bucket = byBase.get(cr.base) ?? [];
        bucket.push(...filesOf(cr).flatMap(pathsOf));
        byBase.set(cr.base, bucket);
      }
      const readableByBase = new Map<string, Set<string>>();
      await Promise.all(
        [...byBase].map(async ([baseRef, paths]) => {
          readableByBase.set(baseRef, await readablePaths(ctx, workspaceId, baseRef, paths));
        }),
      );

      const visible = [];
      for (const cr of matching) {
        const readable = readableByBase.get(cr.base) ?? new Set<string>();
        const mayRead = (path: string) => readable.has(path);
        const files = filesOf(cr);
        const readableCount = files.filter((f) => fileIsReadable(f, mayRead)).length;
        const mine = isAuthor(cr, ctx.user.email);
        if (!maySeeChangeRequest({ readableFiles: readableCount, isAuthor: mine })) continue;
        visible.push(
          toCrSummary(cr, {
            readable: readableCount,
            // One per withheld FILE, whatever its move names it.
            withheld: files.length - readableCount,
          }),
        );
      }
      // Paged AFTER the filter, so a page's length says nothing about what was
      // withheld — the counts do that.
      const { items, ...paging } = pageOf(visible, perPage, page);
      return { changeRequests: items, ...paging };
    },
  });

  // ── get_change_request ────────────────────────────────────────────────────

  mount({
    name: 'get_change_request',
    description:
      'Read one change request by `number` (GitHub: get a pull request) — its `url`, `title`, ' +
      '`body` (what the author wrote, without the generated owners block Hexis appends), ' +
      '`state`, `sourceBranch`, `targetBranch`, whether it is `mergeable`, the ' +
      '`mergeBlockedReasons` holding it up, and a `viewer` block saying whether YOU may approve ' +
      'or apply it. The same field names `open_change_request` answers in. Read-only. Answers ' +
      '404 both for a number that does not exist and for a request you may not see.',
    inputs: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1, description: 'Change request number.' } },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        ...(changeRequestSchema as { properties: Record<string, JsonSchema> }).properties,
        body: { type: 'string', description: "What the AUTHOR wrote. The generated `## Affected owners` block Hexis appends — which names every changed path — is cut off the end; read who must approve each file from `list_change_request_files`." },
        headSha: { type: 'string', description: 'The source commit this answer describes. Absent when no commit could be resolved.' },
        baseSha: { type: 'string', description: 'The target commit it is read against. Absent when no commit could be resolved.' },
        mergeable: { type: 'boolean', description: "Hexis's merge gate, which also waits on the per-file approvals. May be false while `mergeBlockedReasons` is empty, if a blocker names a file you may not read." },
        mergeBlockedReasons: { type: 'array', items: { type: 'string' }, description: 'Why it cannot be applied yet, in the gate\'s own words. Blockers naming a file you may not read are left out.' },
        withheldMergeBlockedReasons: { type: 'integer', description: 'How many blockers were left out because they name a file you may not read.' },
        viewer: {
          type: 'object',
          description: 'What YOU, specifically, may do with this request.',
          properties: {
            mayApprove: { type: 'boolean', description: 'Whether you may approve at least one of the files you are shown.' },
            mayMerge: { type: 'boolean', description: 'Whether an Apply by you would be accepted right now.' },
            isAuthor: { type: 'boolean', description: 'Whether you opened it (your agent counts as you).' },
          },
          required: ['mayApprove', 'mayMerge', 'isAuthor'],
        },
      },
      required: [
        ...(changeRequestSchema as { required: string[] }).required,
        'body',
        'mergeable',
        'mergeBlockedReasons',
        'withheldMergeBlockedReasons',
        'viewer',
      ],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      const { detail, readableFiles, withheldFilePaths, withheldFileCount, viewerIsAuthor } = scoped;
      // Unwrapped, as `open_change_request` answers since #349: `url` is the
      // first field of the answer itself, so a truncation cannot take it.
      return toCrDetail(
        detail,
        { readable: readableFiles.length, withheld: withheldFileCount },
        visibleBlockers(detail.mergeBlockedReasons, withheldFilePaths),
        toCrViewer(
          detail,
          viewerIsAuthor,
          // `mayApprove` over the approvals of the SHOWN files alone: an
          // approval keyed on a withheld file must not answer for it.
          detail.approvals.filter((a) => scoped.mayShow(a.path)),
        ),
      );
    },
  });

  // ── list_change_request_files ─────────────────────────────────────────────

  mount({
    name: 'list_change_request_files',
    description:
      "List a change request's changed files (GitHub: list pull request files). Each answers " +
      '`path`, `change` (`added`, `changed`, `deleted` or `moved`, a moved one with its ' +
      '`previousPath`), `additions`, `deletions` and `sha` — the same words ' +
      '`open_change_request` uses — plus who must approve it (`requiredApprovers`) and who has ' +
      '(`approvedBy`). No patch is returned unless you ask with `include: ["patches"]`. ' +
      'Read-only. Files you may not read are left out and counted in `withheldFiles`, never named.',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['patches'] },
          description: 'Pass `["patches"]` to get each file\'s unified diff. Omit it and no patch is returned.',
        },
        ...pagingInputs,
      },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repository-relative path.' },
              previousPath: { type: 'string', description: 'Where a `moved` file came from.' },
              change: { type: 'string', enum: ['added', 'changed', 'deleted', 'moved'], description: 'What happened to it.' },
              additions: { type: 'integer' },
              deletions: { type: 'integer' },
              sha: { type: 'string', description: 'Blob sha at the request head.' },
              patch: { type: 'string', description: 'Unified diff — only on `include: ["patches"]`, and never for a binary.' },
              isBinary: { type: 'boolean' },
              requiredApprovers: {
                type: 'object',
                description: 'Who must approve this file before the request can be applied.',
                properties: {
                  roles: { type: 'array', items: { type: 'string' } },
                  users: { type: 'array', items: userSchema },
                },
                required: ['roles', 'users'],
              },
              approversUnknown: { type: 'boolean', description: 'Present when the approver set could not be resolved — then an empty `requiredApprovers` means UNKNOWN, not nobody.' },
              approvedBy: {
                type: 'array',
                description: 'The approvals standing on this file.',
                items: {
                  type: 'object',
                  properties: {
                    user: userSchema,
                    approvedAt: { type: 'string', description: 'ISO timestamp.' },
                    stale: { type: 'boolean', description: 'True when a later push invalidated it.' },
                    selfApproval: { type: 'boolean', description: "True when the approver is the request's author." },
                  },
                  required: ['user', 'approvedAt', 'stale', 'selfApproval'],
                },
              },
              approved: { type: 'boolean', description: 'A current approval by an eligible approver stands.' },
              inMergeGate: { type: 'boolean', description: 'Whether the gate waits on this file at all.' },
              viewerMayApprove: { type: 'boolean', description: 'Whether YOU may approve it.' },
            },
            required: ['path', 'change', 'additions', 'deletions', 'sha', 'isBinary', 'requiredApprovers', 'approvedBy', 'approved', 'inMergeGate', 'viewerMayApprove'],
          },
        },
        withheldFiles: { type: 'integer', description: 'How many of its files you may not read. Never named.' },
        ...pagingOutputs,
      },
      required: ['files', 'withheldFiles', ...pagingRequired],
    },
    handler: async (args, ctx: ToolContext) => {
      const include = Array.isArray(args.include) ? args.include : [];
      const patches = include.includes('patches');
      const number = numberArg(args);
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches });
      const approvals = approvalsByPath(scoped.detail);
      const { items, ...paging } = pageOf(scoped.readableFiles, perPage, page);
      return {
        files: items.map((f) => toCrFile(f, approvals.get(f.path), { patches })),
        withheldFiles: scoped.withheldFileCount,
        ...paging,
      };
    },
  });

  // ── list_change_request_reviews ───────────────────────────────────────────

  mount({
    name: 'list_change_request_reviews',
    description:
      "List a change request's reviews (GitHub: list reviews): who approved what, and when. " +
      'Hexis approves per FILE, so each entry names a `reviewer`, the `files` they approved and ' +
      'the time of the latest of them; `stale` is true for approvals a later push invalidated. ' +
      'Nothing records who DECLINED a request, so no entry reports one — a reviewer\'s objection ' +
      'is a comment. Read-only: an entry keeps only the files you may read, and one with no ' +
      'readable file at all is counted in `withheldReviews` rather than named.',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        ...pagingInputs,
      },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        reviews: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable within the request: the reviewer, and whether their approvals still stand.' },
              reviewer: userSchema,
              stale: { type: 'boolean', description: 'True when a later push invalidated the approvals gathered here.' },
              submittedAt: { type: 'string', description: 'ISO timestamp of the latest approval in this entry.' },
              files: { type: 'array', items: { type: 'string' }, description: 'The files this reviewer approved.' },
              withheldFiles: { type: 'integer', description: 'Further files of this review you may not read. Never named.' },
            },
            required: ['id', 'reviewer', 'stale', 'submittedAt', 'files', 'withheldFiles'],
          },
        },
        withheldReviews: { type: 'integer', description: 'Reviews every file of which you may not read. Neither the reviewer nor the files are named.' },
        ...pagingOutputs,
      },
      required: ['reviews', 'withheldReviews', ...pagingRequired],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      // The read predicate goes IN rather than a pre-filtered list: a review is
      // grouped over every file the reviewer approved, so that it can count the
      // withheld ones under its own id and drop itself when they are all it has.
      // `mayShow` keeps a withheld move out of the files a review names.
      const { reviews, withheldReviews } = toCrReviews(scoped.detail.approvals, scoped.mayShow);
      const { items, ...paging } = pageOf(reviews, perPage, page);
      return { reviews: items, withheldReviews, ...paging };
    },
  });

  // ── list_change_request_comments ──────────────────────────────────────────

  mount({
    name: 'list_change_request_comments',
    description:
      "List a change request's comments (GitHub: list review comments and issue comments — Hexis " +
      'keeps both in one thread). Each carries its `author`, `body`, `path` and `line` when it is ' +
      'anchored to a file, `parentId` when it is a reply (the same id you pass to ' +
      '`post_change_request_comment` to reply yourself), and its times. Read-only. A comment on a ' +
      'file you may not read is left out and counted in `withheldComments`, and so is a reply to ' +
      'a comment that was left out.',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        ...pagingInputs,
      },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        comments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Pass as `parentId` to `post_change_request_comment` to reply.' },
              author: userSchema,
              body: { type: 'string' },
              path: { type: 'string', description: 'Repository-relative path, on a file-level or inline comment.' },
              line: { type: 'integer', description: 'Set on an inline comment.' },
              parentId: { type: 'string', description: 'The comment this one replies to.' },
              headSha: { type: 'string', description: 'The commit the comment was anchored to.' },
              createdAt: { type: 'string', description: 'ISO timestamp.' },
              updatedAt: { type: 'string', description: 'ISO timestamp; present once edited.' },
            },
            required: ['id', 'author', 'body', 'headSha', 'createdAt'],
          },
        },
        withheldComments: { type: 'integer', description: 'Comments on a file you may not read, and replies to those.' },
        ...pagingOutputs,
      },
      required: ['comments', 'withheldComments', ...pagingRequired],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      // A comment with no path is about the request as a whole; one with a path
      // is as readable as that path is NAMEABLE here. A reply inherits its
      // parent's verdict up the chain — see `visibleComments`.
      const { visible, withheld } = visibleComments(scoped.detail.comments, scoped.mayShow);
      const { items, ...paging } = pageOf(visible, perPage, page);
      return {
        comments: items.map(toCrComment),
        withheldComments: withheld,
        ...paging,
      };
    },
  });
}

