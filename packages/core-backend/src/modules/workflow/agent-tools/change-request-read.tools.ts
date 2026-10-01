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
  toGhAccess,
  toGhChangeRequest,
  toGhChangeRequestDetail,
  toGhComment,
  toGhFile,
  toGhReviews,
  visibleBlockers,
} from './github-shape.js';

/**
 * The five read tools over change requests, shaped after GitHub's pull-request
 * API: `list_change_requests`, `get_change_request`,
 * `list_change_request_files`, `list_change_request_reviews` and
 * `list_change_request_comments`. The mapping lives in `github-shape.ts`; this
 * file does the IO and the access filtering.
 *
 * None of them writes anything — every handler is registered `write: false`,
 * so a read-scoped connection key may call all five, and every service call
 * below is a read.
 *
 * ## What the caller may see
 *
 * The app's own change-request routes serve the whole list and the whole
 * detail to any signed-in viewer; only the file CONTENT routes gate per path
 * (`fork-point-file` asks `canReadAtRef(origin/<base>)`, and treats an
 * unresolvable verdict as a denial). These tools apply that same content gate
 * to the whole payload, because an agent's answer is the content: a file list,
 * a reviewer's comment and a gate warning all name paths, and an agent hands
 * what it reads to whoever it is talking to.
 *
 * So, per request:
 *
 *   - every path is resolved at `origin/<base>` — the target's access tree, the
 *     one the request is asking to be judged against — in ONE batched lookup;
 *   - BOTH names of a renamed file are resolved, and a file is readable only if
 *     both are: the diff of a rename shows what was at the old path, so a file
 *     renamed out of a closed folder stays closed, however open its new home.
 *     The LIST decides this over the same `touchedNodeFiles` pairs the detail
 *     does — a list that judged the flat `touchedNodePaths` could not see a
 *     rename's old side, and advertised requests its own by-number tools
 *     answered 404 for;
 *   - files the caller may not read are left out and counted in
 *     `withheld_files`, never named (decision 2 on the ticket);
 *   - comments on a withheld file, and gate blockers naming one, go the same
 *     way, with their own counts;
 *   - `body` is the author's own description. Hexis appends a generated
 *     `## Affected owners` block to a change-request body, one line per changed
 *     path, and returning the body verbatim named every file of the request —
 *     the leak Local Testing found on the first attempt. `authorsDescription`
 *     cuts it the way the app's own `authorsReason` always has;
 *   - a request with no readable file and no claim of authorship answers 404,
 *     indistinguishable from a number that was never issued.
 *
 * It fails closed, and that has one consequence worth knowing before reading a
 * surprise: a request whose FILE SET cannot be resolved at all — an access tree
 * that does not load at `origin/<base>`, or an applied request whose source
 * branch has since been retired, so there are no two refs left to diff — proves
 * no read access to anything, and is therefore readable by its author alone.
 * "We cannot tell what this request touched" is not "you may see it", and an
 * empty path set is the same answer `scopeApplyFailures` already refuses to
 * grant anything on.
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
     * file renamed out of a folder the caller may not read is readable under
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
    /** How many files are withheld. One per file, whatever its rename names. */
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
    // BOTH names of every file: a rename is judged on its old path as well as
    // its new one, because the diff of a rename shows what was at the old one.
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
   * the fallback cannot pair a rename, which is the whole reason this field
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

  const refSchema: JsonSchema = {
    type: 'object',
    properties: { ref: { type: 'string', description: 'Branch name.' }, sha: { type: 'string' } },
    required: ['ref'],
  };

  const changeRequestSchema: JsonSchema = {
    type: 'object',
    properties: {
      number: { type: 'integer' },
      state: { type: 'string', enum: ['open', 'closed'], description: "GitHub's two states; a merged request is `closed` with `merged: true`." },
      title: { type: 'string' },
      user: userSchema,
      head: { ...refSchema, description: 'The source branch the change comes from.' },
      base: { ...refSchema, description: 'The target branch it would be applied to.' },
      created_at: { type: 'string', description: 'ISO timestamp.' },
      updated_at: { type: 'string', description: 'ISO timestamp — the close time of a closed request, else the creation time.' },
      merged: { type: 'boolean' },
      html_url: { type: 'string', description: 'Link a person can open.' },
      url_note: { type: 'string', description: 'Present only when `html_url` is relative.' },
      changed_files: { type: 'integer', description: 'How many of its files YOU may read.' },
      withheld_files: { type: 'integer', description: 'How many of its files you may not read. Never named.' },
    },
    required: ['number', 'state', 'title', 'user', 'head', 'base', 'created_at', 'updated_at', 'merged', 'html_url', 'changed_files', 'withheld_files'],
  };

  const pagingOutputs: Record<string, JsonSchema> = {
    total_count: { type: 'integer', description: 'Entries you may read, across all pages.' },
    page: { type: 'integer' },
    per_page: { type: 'integer' },
    has_next_page: { type: 'boolean', description: 'True when a further page exists.' },
  };

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
      'Read-only, and limited to what you may read: a request whose files are all closed to you ' +
      'is not listed unless you opened it, and `withheld_files` counts the ones left out of each.',
    inputs: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default `open`, as on GitHub.' },
        head: { type: 'string', description: 'Source branch — list only requests coming FROM it.' },
        base: { type: 'string', description: 'Target branch — list only requests going INTO it.' },
        author: { type: 'string', description: "The author's email, or their `user.login`." },
        ...pagingInputs,
      },
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        change_requests: { type: 'array', items: changeRequestSchema },
        ...pagingOutputs,
      },
      required: ['change_requests', 'total_count', 'page', 'per_page', 'has_next_page'],
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
      // rename under its new name alone, so a file moved out of a folder this
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
          toGhChangeRequest(cr, {
            readable: readableCount,
            // One per withheld FILE, whatever its rename names it.
            withheld: files.length - readableCount,
          }),
        );
      }
      // Paged AFTER the filter, so a page's length says nothing about what was
      // withheld — the counts do that.
      const { items, ...paging } = pageOf(visible, perPage, page);
      return { change_requests: items, ...paging };
    },
  });

  // ── get_change_request ────────────────────────────────────────────────────

  mount({
    name: 'get_change_request',
    description:
      'Read one change request by `number` (GitHub: get a pull request) — its `title`, `body` ' +
      "(what the author wrote, without the generated owners block Hexis appends), " +
      '`state`, `merged`, `mergeable`, `head`, `base` and `html_url`, plus an `access` block with ' +
      'the merge blockers and whether YOU may approve or apply it. Read-only. Answers 404 both ' +
      'for a number that does not exist and for a request you may not see.',
    inputs: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1, description: 'Change request number.' } },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        change_request: {
          ...changeRequestSchema,
          properties: {
            ...(changeRequestSchema as { properties: Record<string, JsonSchema> }).properties,
            body: { type: 'string', description: "What the AUTHOR wrote. The generated `## Affected owners` block Hexis appends — which names every changed path — is not part of it; read who must approve each file from `list_change_request_files`." },
            mergeable: { type: 'boolean', description: "Hexis's merge gate, which also waits on the per-file approvals." },
            access: {
              type: 'object',
              description: 'What Hexis knows beyond GitHub.',
              properties: {
                merge_blockers: { type: 'array', items: { type: 'string' }, description: 'Why it cannot be applied yet.' },
                withheld_merge_blockers: { type: 'integer', description: 'Blockers naming a file you may not read.' },
                may_approve: { type: 'boolean', description: 'Whether you may approve at least one of the files you are shown.' },
                may_merge: { type: 'boolean', description: 'Whether an Apply by you would be accepted right now.' },
                is_author: { type: 'boolean', description: 'Whether you opened it (your agent counts as you).' },
              },
              required: ['merge_blockers', 'withheld_merge_blockers', 'may_approve', 'may_merge', 'is_author'],
            },
          },
          required: [
            ...(changeRequestSchema as { required: string[] }).required,
            'body',
            'mergeable',
            'access',
          ],
        },
      },
      required: ['change_request'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      const { detail, readableFiles, withheldFilePaths, withheldFileCount, viewerIsAuthor } = scoped;
      return {
        change_request: toGhChangeRequestDetail(
          detail,
          { readable: readableFiles.length, withheld: withheldFileCount },
          toGhAccess(
            detail,
            visibleBlockers(detail.mergeBlockedReasons, withheldFilePaths),
            viewerIsAuthor,
            // `may_approve` over the approvals of the SHOWN files alone: an
            // approval keyed on a withheld file must not answer for it.
            detail.approvals.filter((a) => scoped.mayShow(a.path)),
          ),
        ),
      };
    },
  });

  // ── list_change_request_files ─────────────────────────────────────────────

  mount({
    name: 'list_change_request_files',
    description:
      "List a change request's changed files (GitHub: list pull request files), with GitHub's " +
      '`filename`, `status`, `additions`, `deletions` and `sha`. Adds what Hexis has: ' +
      '`required_approvers` (who must approve the file) and `approved_by` (who has, and when). ' +
      'No patch is returned unless you ask with `include: ["patches"]`. Read-only. Files you may ' +
      'not read are left out and counted in `withheld_files`, never named.',
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
              filename: { type: 'string', description: 'Repository-relative path.' },
              previous_filename: { type: 'string', description: 'Set for renames and copies.' },
              status: { type: 'string', description: '`added` | `modified` | `removed` | `renamed` | `copied` | `changed` | `unchanged`.' },
              additions: { type: 'integer' },
              deletions: { type: 'integer' },
              changes: { type: 'integer' },
              sha: { type: 'string', description: 'Blob sha at the request head.' },
              patch: { type: 'string', description: 'Unified diff — only on `include: ["patches"]`, and never for a binary.' },
              is_binary: { type: 'boolean' },
              required_approvers: {
                type: 'object',
                description: 'Hexis: who must approve this file before the request can be applied.',
                properties: {
                  roles: { type: 'array', items: { type: 'string' } },
                  users: { type: 'array', items: userSchema },
                },
                required: ['roles', 'users'],
              },
              required_approvers_resolved: { type: 'boolean', description: 'False means the approver set is UNKNOWN, not empty.' },
              approved_by: {
                type: 'array',
                description: 'Hexis: the approvals standing on this file.',
                items: {
                  type: 'object',
                  properties: {
                    user: userSchema,
                    approved_at: { type: 'string', description: 'ISO timestamp.' },
                    stale: { type: 'boolean', description: 'True when a later push invalidated it.' },
                    self_approval: { type: 'boolean', description: "True when the approver is the request's author." },
                  },
                  required: ['user', 'approved_at', 'stale', 'self_approval'],
                },
              },
              approved: { type: 'boolean', description: 'Hexis: a current approval by an eligible approver stands.' },
              in_merge_gate: { type: 'boolean', description: 'Hexis: whether the gate waits on this file at all.' },
              viewer_may_approve: { type: 'boolean', description: 'Hexis: whether YOU may approve it.' },
            },
            required: ['filename', 'status', 'additions', 'deletions', 'changes', 'sha', 'is_binary', 'required_approvers', 'required_approvers_resolved', 'approved_by', 'approved', 'in_merge_gate', 'viewer_may_approve'],
          },
        },
        withheld_files: { type: 'integer', description: 'How many of its files you may not read. Never named.' },
        ...pagingOutputs,
      },
      required: ['files', 'withheld_files', 'total_count', 'page', 'per_page', 'has_next_page'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const include = Array.isArray(args.include) ? args.include : [];
      const patches = include.includes('patches');
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches });
      const approvals = approvalsByPath(scoped.detail);
      const { items, ...paging } = pageOf(scoped.readableFiles, perPage, page);
      return {
        files: items.map((f) => toGhFile(f, approvals.get(f.path), { patches })),
        withheld_files: scoped.withheldFileCount,
        ...paging,
      };
    },
  });

  // ── list_change_request_reviews ───────────────────────────────────────────

  mount({
    name: 'list_change_request_reviews',
    description:
      "List a change request's reviews (GitHub: list reviews): who approved what, and when. " +
      'Hexis approves per FILE, so each entry names a reviewer, the files they approved and the ' +
      'time of the latest of them; `state` is `APPROVED`, or `DISMISSED` for approvals a later ' +
      'push invalidated. Nothing records who DECLINED a request, so no entry reports one — a ' +
      "reviewer's objection is a comment. Read-only: an entry keeps only the files you may read, " +
      'and one with no readable file at all is counted in `withheld_reviews` rather than named.',
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
              id: { type: 'string' },
              user: userSchema,
              state: { type: 'string', enum: ['APPROVED', 'DISMISSED'] },
              submitted_at: { type: 'string', description: 'ISO timestamp of the latest approval in this entry.' },
              files: { type: 'array', items: { type: 'string' }, description: 'Hexis: the files this reviewer approved.' },
              withheld_files: { type: 'integer', description: 'Further files of this review you may not read. Never named.' },
            },
            required: ['id', 'user', 'state', 'submitted_at', 'files', 'withheld_files'],
          },
        },
        withheld_reviews: { type: 'integer', description: 'Reviews every file of which you may not read. Neither the reviewer nor the files are named.' },
        ...pagingOutputs,
      },
      required: ['reviews', 'withheld_reviews', 'total_count', 'page', 'per_page', 'has_next_page'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      // The read predicate goes IN rather than a pre-filtered list: a review is
      // grouped over every file the reviewer approved, so that it can count the
      // withheld ones under its own id and drop itself when they are all it has.
      // `mayShow` keeps a withheld rename out of the files a review names.
      const { reviews, withheldReviews } = toGhReviews(scoped.detail.approvals, scoped.mayShow);
      const { items, ...paging } = pageOf(reviews, perPage, page);
      return { reviews: items, withheld_reviews: withheldReviews, ...paging };
    },
  });

  // ── list_change_request_comments ──────────────────────────────────────────

  mount({
    name: 'list_change_request_comments',
    description:
      "List a change request's comments (GitHub: list review comments and issue comments — Hexis " +
      'keeps both in one thread). Each carries its author, `body`, `path` and `line` when it is ' +
      'anchored to a file, `in_reply_to` when it is a reply, and its times. Read-only. A comment ' +
      'on a file you may not read is left out and counted in `withheld_comments`.',
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
              user: userSchema,
              body: { type: 'string' },
              path: { type: 'string', description: 'Repository-relative path, on a file-level or inline comment.' },
              line: { type: 'integer', description: 'Set on an inline comment.' },
              in_reply_to: { type: 'string', description: 'The comment this one replies to.' },
              commit_id: { type: 'string', description: 'The head the comment was anchored to.' },
              created_at: { type: 'string', description: 'ISO timestamp.' },
              updated_at: { type: 'string', description: 'ISO timestamp; present once edited.' },
            },
            required: ['id', 'user', 'body', 'commit_id', 'created_at'],
          },
        },
        withheld_comments: { type: 'integer', description: 'Comments on a file you may not read.' },
        ...pagingOutputs,
      },
      required: ['comments', 'withheld_comments', 'total_count', 'page', 'per_page', 'has_next_page'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = numberArg(args);
      const { perPage, page } = pagingOf(args);
      const scoped = await scopedDetail(ctx, number, { patches: false });
      // A comment with no path is about the request as a whole — visible to
      // anyone the request itself is visible to. One with a path is as readable
      // as that path is NAMEABLE here: `mayShow`, not `mayRead`, so a comment
      // anchored to the new name of a file withheld for its old one goes with
      // the file rather than announcing it.
      const visible = scoped.detail.comments.filter((c) => !c.path || scoped.mayShow(c.path));
      const { items, ...paging } = pageOf(visible, perPage, page);
      return {
        comments: items.map(toGhComment),
        withheld_comments: scoped.detail.comments.length - visible.length,
        ...paging,
      };
    },
  });
}
