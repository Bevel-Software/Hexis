import type { Router, RequestHandler } from 'express';
import type { ChangeRequestApplyFailureKind } from '@bevel-software/platform-shared';
import type { IToolRegistry, JsonSchema } from '../../tool-registry/index.js';
import { ToolError, hasHttpStatus, type ToolContext, type ToolHandler, toolDef } from '../../tool-helpers/index.js';
import type { ToolHandlerFactory } from '../../tool-helpers/index.js';
import type { KbContext } from '../../../shared/kb-context.js';
import type { IAccessControl } from '../../access/index.js';
import { changeRequestNumberArg, changeRequestScope, type ScopedDetail } from './change-request-read.tools.js';
import { APPLY_FAILURE_REASON_WITHHELD, toCrViewer, visibleBlockers } from './change-request-read-shape.js';
import { normalizeWorkspacePath } from '../../kb-fs/index.js';
import { logger } from '../../../shared/logging.js';

const log = logger('change-request-apply');

/**
 * Approving and applying a change request, for a connection made as a BOT.
 *
 * A bot is an identity of its own (`modules/bots`), granted like a person,
 * and it may approve and apply a change request where its grants allow
 * (Bots-Are-Identities, Requirement 10). These two tools are how it does: the
 * same service calls the app's Approve and Apply make, judged for the bot's
 * own row, so the gate, the per-file eligibility and the bot's one refusal
 * (a request that changes access is never applied by a bot) are the
 * service's, decided once.
 *
 * Offered to nobody else. `ConnectionScope.allowsPlatformTool` keeps them
 * out of every listing for a connection made as Myself and refuses a call by
 * name (`BOT_ONLY_TOOLS`): an agent acting as a person proposes, and the
 * person reviews and applies in the app. Nothing here asks again — the scope
 * is the one place that decides it, before the handler runs.
 */
export function registerChangeRequestApplyTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  accessControl: Pick<IAccessControl, 'canReadBatchAtRef'>,
  kb: Pick<KbContext, 'defaultWorkspaceId' | 'kbDirName'>,
): void {
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
      write: true,
      tags: ['workflow', 'write'],
    });
    registry.registerInternalTool(def);
    registry.registerExternalTool(def);
    router.post(path.slice('/api'.length), toolAuth, toolHandler(spec.handler, { write: true }));
  };

  const { repoGlobalWorkspaceId, scopedDetail } = changeRequestScope(accessControl, kb);

  /** The request as the caller may see it, read fresh, and refused unless it is open. */
  const openRequest = async (ctx: ToolContext, number: number): Promise<ScopedDetail> => {
    const scoped = await scopedDetail(ctx, number, { patches: false, fresh: true });
    if (scoped.detail.state !== 'open') {
      throw new ToolError(`Change request #${number} is ${scoped.detail.state}, not open: there is nothing to approve or apply.`, 409);
    }
    return scoped;
  };

  /** Where the request stands for the caller after an approval: the blockers they may read, and whether an apply would be accepted. */
  const standing = (scoped: ScopedDetail) => {
    const { detail } = scoped;
    const blockers = visibleBlockers(detail.mergeBlockedReasons, scoped.withheldFilePaths);
    const viewer = toCrViewer(detail, scoped.viewerIsAuthor, detail.approvals.filter((a) => scoped.mayShow(a.path)));
    return {
      mergeBlockedReasons: blockers.visible,
      withheldMergeBlockedReasons: blockers.withheld,
      mayApply: viewer.mayMerge,
    };
  };

  mount({
    name: 'approve_change_request',
    description:
      'Approve files of an open change request as the bot this connection acts as. Hexis approves per FILE, at the ' +
      "request's current head: name `paths` to approve those, or leave it out to approve every file you are shown and " +
      'may approve. A path you may not approve, or that the request does not change, refuses the whole call and ' +
      'approves nothing. Answers what you approved and where the request stands: the blockers left and whether ' +
      '`apply_change_request` would be accepted. Offered only to a connection made as a bot.',
    inputs: {
      type: 'object',
      properties: {
        number: { type: 'integer', minimum: 1, description: 'Change request number.' },
        paths: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          description: 'The changed files to approve, as the request lists them. Omit to approve every file you may.',
        },
      },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        approved: { type: 'array', items: { type: 'string' }, description: 'The files you approved at the current head.' },
        mergeBlockedReasons: { type: 'array', items: { type: 'string' }, description: 'What still blocks applying it. Blockers naming a file you may not read are left out.' },
        withheldMergeBlockedReasons: { type: 'integer', description: 'How many blockers were left out because they name a file you may not read.' },
        mayApply: { type: 'boolean', description: 'Whether `apply_change_request` by you would be accepted now.' },
      },
      required: ['number', 'approved', 'mergeBlockedReasons', 'withheldMergeBlockedReasons', 'mayApply'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = changeRequestNumberArg(args);
      const asked = pathsArg(args, kb.kbDirName);
      const scoped = await openRequest(ctx, number);
      const { detail } = scoped;
      // Only what the caller is SHOWN can be approved here: an approval keyed
      // on a withheld file would name it.
      const shown = detail.approvals.filter((a) => scoped.mayShow(a.path));
      const approvable = new Set(shown.filter((a) => a.viewerCanApprove).map((a) => a.path));
      let targets: string[];
      if (asked) {
        // Checked whole before anything is written: a refusal approves nothing.
        const listed = new Set(shown.map((a) => a.path));
        const unknown = asked.filter((p) => !listed.has(p));
        if (unknown.length > 0) {
          throw new ToolError(`Change request #${number} does not change ${unknown.map((p) => `"${p}"`).join(', ')}; nothing was approved.`, 404);
        }
        const refused = asked.filter((p) => !approvable.has(p));
        if (refused.length > 0) {
          throw new ToolError(`You may not approve ${refused.map((p) => `"${p}"`).join(', ')} in change request #${number}; nothing was approved.`, 403);
        }
        targets = [...new Set(asked)];
      } else {
        targets = [...approvable];
        if (targets.length === 0) {
          throw new ToolError(`You may approve none of the files of change request #${number}.`, 403);
        }
      }

      const workspaceId = await repoGlobalWorkspaceId(ctx);
      const approved: string[] = [];
      for (const path of targets) {
        try {
          await ctx.versionControlService.approveFile(
            number,
            path,
            ctx.user,
            detail.files,
            detail.headSha,
            detail.base,
            detail.authorId ?? null,
            workspaceId,
          );
        } catch (err) {
          // Approvals already recorded stand (each is its own write), so the
          // answer says which landed before the one that failed — never a
          // silent partial success.
          const done = approved.length > 0 ? `Approved ${approved.map((p) => `"${p}"`).join(', ')}; ` : '';
          if (hasHttpStatus(err) && err.status < 500) {
            throw new ToolError(`${done}approving "${path}" was refused: ${err.message}`, err.status);
          }
          if (done) throw new ToolError(`${done}approving "${path}" failed.`, 500);
          throw err;
        }
        approved.push(path);
      }
      const after = await scopedDetail(ctx, number, { patches: false, fresh: true });
      return { number, approved, ...standing(after) };
    },
  });

  mount({
    name: 'apply_change_request',
    description:
      'Apply (merge) an open change request into its target as the bot this connection acts as. Accepted only when ' +
      "the request's merge gate passes — every file approved by someone eligible at the current head — and the bot " +
      'may write every file it changes; refused ' +
      'whole when it changes access (`roles.yaml`, an `access.md`, a group file, or the access lines of a file): a bot ' +
      'never changes access. Answers `merged`, or `conflicts-need-resolution` with the conflicting paths (nothing is ' +
      'written: resolve them on the source branch and apply again). Offered only to a connection made as a bot.',
    inputs: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1, description: 'Change request number.' } },
      required: ['number'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        number: { type: 'integer' },
        outcome: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['merged', 'conflicts-need-resolution'] },
            conflictedPaths: { type: 'array', items: { type: 'string' }, description: 'Present when `kind` is `conflicts-need-resolution`.' },
          },
          required: ['kind'],
        },
      },
      required: ['number', 'outcome'],
    },
    handler: async (args, ctx: ToolContext) => {
      const number = changeRequestNumberArg(args);
      const scoped = await openRequest(ctx, number);
      const { detail } = scoped;
      const workspaceId = await repoGlobalWorkspaceId(ctx);
      const vc = ctx.versionControlService;
      // The same attempt bookkeeping as the app's Apply: a refusal is recorded
      // on the request for its author and other viewers, and only the newest
      // attempt may record one.
      const attempt = vc.beginApplyAttempt(number);
      const record = async (reason: string, kind: ChangeRequestApplyFailureKind) => {
        try {
          await vc.recordApplyFailure(number, { reason, kind }, ctx.user, attempt);
        } catch (err) {
          // The caller is answered either way; only the other viewers miss
          // the reason, and the answer must not become this failure instead.
          log.warn(`could not record the failed apply of change request #${number}:`, { err });
        }
      };
      // A reason the caller may not read in full is withheld from them, as
      // the app withholds it from a clicker who cannot read every file.
      const told = (reason: string) => (scoped.withheldFileCount > 0 ? APPLY_FAILURE_REASON_WITHHELD : reason);
      try {
        const outcome = await vc.mergeChangeRequest(
          number,
          ctx.user,
          detail.headSha,
          detail.approvals,
          detail.state,
          detail.title,
          detail.base,
          workspaceId,
        );
        if (outcome.kind === 'conflicts-need-resolution') {
          await record('This draft conflicts with the target and needs resolving first.', 'conflicts');
          const conflictedPaths = outcome.conflictedPaths.filter((p) => scoped.mayShow(p));
          return { number, outcome: { kind: outcome.kind, conflictedPaths } };
        }
        return { number, outcome: { kind: 'merged' } };
      } catch (err) {
        if (!hasHttpStatus(err) || err.status >= 500) throw err;
        const payload = (err as { payload?: { mergeBlockedReasons?: unknown } }).payload;
        const gate = Array.isArray(payload?.mergeBlockedReasons);
        // A refusal of the CALLER says nothing about the request itself.
        if (err.status !== 401 && err.status !== 403 && err.status !== 404) {
          await record(err.message, gate ? 'gate' : 'error');
        }
        throw new ToolError(told(err.message), err.status);
      } finally {
        vc.endApplyAttempt(number, attempt);
      }
    },
  });
}

/**
 * `paths` as the approve tool accepts it: absent, or a non-empty list of
 * changed files, each spelled as the request lists it (repository-relative)
 * once the one path normaliser has read it — so `knowledge-base/Docs/a.md`,
 * `/knowledge-base/Docs/a.md` and `Docs/a.md` name the same file, and a
 * climb out of the repository is refused rather than compared.
 */
function pathsArg(args: Record<string, unknown>, kbDirName: string): string[] | null {
  const raw = args.paths;
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new ToolError('`paths` must be a non-empty list of the changed files to approve.', 400);
  }
  const prefix = `${kbDirName}/`;
  return (raw as string[]).map((p) => {
    const wsPath = normalizeWorkspacePath(p.startsWith('/') ? p.slice(1) : p, kbDirName);
    return wsPath.startsWith(prefix) ? wsPath.slice(prefix.length) : wsPath;
  });
}
