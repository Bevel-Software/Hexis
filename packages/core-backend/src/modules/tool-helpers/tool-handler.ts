import type { Request, Response } from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('tools');
import { hasHttpStatus, ToolError, type ToolHandler } from './tool.contract.js';
import {
  assertBranchProvided,
  BranchNotFoundError,
  DefaultBranchUnsetError,
  WorkflowDomainError,
} from '../../shared/domain-errors.js';
import { branchHandlingFor, type BranchHandling } from './tool-def.js';
import { domainErrorBody } from '../../shared/http-errors.js';
import type { ResolveToolContext } from './tool-context.js';
import { argumentsRefusal } from './route-argument-check.js';
import { alwaysWritable, READ_ONLY_CODE, refuseWriteTool, type IWriteAccess } from '../write-access/write-access.js';
import '../tool-auth/tool-auth.middleware.js'; // Express Request.toolAuth augmentation

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

export interface ToolHandlerOptions {
  /** Mutating tool — refuse read-scoped callers up front (defense in depth). */
  write?: boolean;
  /**
   * How this route treats `branch`, when it must differ from what its
   * `toolDef` recorded. Only `execute_command` sets it (`own`): it falls back
   * to an internal caller's focused branch rather than being refused.
   */
  branch?: BranchHandling;
}

/**
 * What the tool handler needs to know about branches, asked at call time so a
 * default branch renamed in the settings is the next call's default.
 */
export interface ToolBranchPort {
  /** The deployment's default branch; `''` until one is configured. */
  defaultBranch(): string;
  /**
   * True only when `branch` certainly does not exist. Creates no workspace
   * and clones nothing. A name it cannot judge — malformed, or a remote it
   * could not ask — is `false`: opening the branch then answers for it.
   */
  isMissing(branch: string): Promise<boolean>;
}

/**
 * Refuse a branch that certainly does not exist. A fault while finding out —
 * a storage error reading the workspaces root, say — is logged here in full
 * and answered as a 500 that names the branch and nothing else: its message
 * would carry the deployment's paths to the caller.
 */
async function assertBranchExists(branch: string, branches: ToolBranchPort | undefined): Promise<void> {
  let missing: boolean | undefined;
  try {
    missing = await branches?.isMissing(branch);
  } catch (err) {
    log.error('branch existence check failed:', { branch, err });
    throw new ToolError(`Could not check whether branch ${branch} exists.`, 500);
  }
  if (missing) throw new BranchNotFoundError(branch);
}

/**
 * The branch a call runs on, from the tool's handling and the call's
 * arguments — or the refusal. `defaulted` says the caller named none.
 */
async function resolveBranch(
  handling: BranchHandling,
  args: Record<string, unknown>,
  branches: ToolBranchPort | undefined,
): Promise<{ branch: string; defaulted: boolean } | null> {
  if (handling === 'none') return null;
  const given = args.branch;
  if (handling === 'own') {
    // The tool reads its optional branch itself, absence and all; only a
    // name it was given is ours to check, and only one that names something —
    // what the tool makes of a value that does not is the tool's to answer.
    if (namesSomething(given)) await assertBranchExists(given, branches);
    return null;
  }
  // ABSENT, and only absent, is defaulted. An empty or non-string value is a
  // caller that meant to name a branch and got it wrong: refused by name
  // under both declarations rather than quietly read as the default.
  if (handling === 'defaults-to-default-branch' && given === undefined) {
    const fallback = branches?.defaultBranch() ?? '';
    if (fallback.length === 0) throw new DefaultBranchUnsetError();
    return { branch: fallback, defaulted: true };
  }
  assertBranchProvided(given);
  await assertBranchExists(given, branches);
  return { branch: given, defaulted: false };
}

function namesSomething(v: unknown): v is string {
  try {
    assertBranchProvided(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * A plain JSON object answer — the only kind a `branch` field can be added to.
 * A `Date`, a class instance or an array serializes as something else, and
 * spreading it into `{ branch }` would lose that answer.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const prototype: unknown = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Wrap a pure tool handler into an Express handler. Resolves the `ToolContext`
 * from `req.toolAuth` (set by `toolAuth`), enforces write-scope, CHECKS THE
 * ARGUMENTS against what the tool declared, runs the handler, and serializes the
 * result — JSON for a value, SSE for an async-iterable (streaming).
 * `ToolError`/`hasHttpStatus` map to HTTP status. The handler receives
 * `req.body` as the flat args (UTCP's `body_field` already delivered the inner
 * body as the request body).
 *
 * The argument check is HERE, in the route, because the route is where every
 * caller of a route-hosted tool arrives: an agent over MCP, a `call_tool_chain`
 * chain, the in-process agent over loopback, and a script calling
 * `POST /api/agent/tools/<name>` with a connection key. Checked one layer up,
 * in the MCP dispatch, the last of those was left answering a 500 for a missing
 * argument — or running: `grep` without a `pattern` matched every file. Every
 * tool mounted through this factory gets it, a deployment's included, without
 * saying so (see `route-argument-check.ts`).
 */
export function createToolHandlerFactory(
  resolve: ResolveToolContext,
  writeAccess: IWriteAccess = alwaysWritable,
  /** Absent: no default branch to fall back on, and no existence check before the tool runs. */
  branches?: ToolBranchPort,
) {
  return function toolHandler(handler: ToolHandler, opts: ToolHandlerOptions = {}) {
    let warnedHeldToRequired = false;
    return async (req: Request, res: Response): Promise<void> => {
      const auth = req.toolAuth;
      if (!auth) {
        res.status(401).json({ error: 'Unauthenticated' });
        return;
      }
      if (opts.write && auth.scope === 'read') {
        res.status(403).json({ error: 'This tool requires write access.' });
        return;
      }
      // Before anything is awaited: a client that goes away during the
      // write-access check below must still abort the call.
      //
      // Asked of the RESPONSE. The request closes as soon as its body has
      // been read, with the client still there and waiting, so its `close`
      // says nothing about the client; the response closes when it has been
      // sent or the connection is gone, and `writableEnded` tells the two
      // apart.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      // The tool layer's half of the read-only gate: the HTTP gate lets every
      // tool call through, since only here is a write tool told from a read.
      if (opts.write) {
        const refusal = await refuseWriteTool(writeAccess);
        if (refusal !== null) {
          res.status(403).json({ error: refusal, code: READ_ONLY_CODE });
          return;
        }
        // The client left while the verdict was awaited: nobody to answer.
        if (abort.signal.aborted) return;
      }
      const body: unknown = req.body;
      if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const args = (body ?? {}) as Record<string, unknown>;
      // Before the context is resolved and before the handler runs: nothing is
      // read, written or sent on a call that does not match its tool. The more
      // specific refusals each tool makes for itself (a missing `branch`,
      // above all) are left to the handler and keep their own wording — this
      // reports what the SCHEMA alone can settle.
      // The WHOLE path: a module mounts its routes on a router, which sees only
      // the part below its mount point.
      const mismatch = argumentsRefusal(req.originalUrl, args, req.query);
      if (mismatch) {
        res.status(mismatch.status).json({ ...mismatch.details, error: mismatch.message });
        return;
      }
      // `sessionId` rides the tool body like `branch` does: the external MCP
      // proxy injects it (ask-tool continuity convention) and the in-process
      // agent passes its thread id. Surfaced on the context so the
      // agent-access gate can name the run without each handler re-reading args.
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.length > 0
        ? args.sessionId
        : undefined;
      try {
        // The branch is resolved HERE, once, before the tool runs: refused,
        // defaulted or checked to exist, by what the tool declared — so no
        // tool, the platform's or a deployment's, carries a guard of its own,
        // and none can be handed a branch that is missing, empty or not a
        // string. Its declaration comes from the `toolDef` built for this
        // route; a route no `toolDef` described is read like an optional
        // `branch` the tool handles itself.
        //
        // A writing route never defaults, whatever was recorded for it:
        // `toolDef` refuses the declaration at startup for a tool it knows
        // writes, and one only mounted as writing is held to `required` here,
        // so its write cannot land on the default branch unasked. Its
        // published schema still calls `branch` optional — the tool's
        // declaration is wrong, not the call — so the mismatch is logged,
        // once per route, for the tool's author to fix by declaring both
        // `write: true` and `branch: 'required'` (`write` alone with the
        // defaulting declaration makes `toolDef` throw at startup).
        const declared =
          opts.branch ?? branchHandlingFor(req.baseUrl + (req.route?.path ?? req.path)) ?? 'own';
        const heldToRequired = declared === 'defaults-to-default-branch' && opts.write === true;
        const handling: BranchHandling = heldToRequired ? 'required' : declared;
        if (heldToRequired && !warnedHeldToRequired) {
          warnedHeldToRequired = true;
          log.warn(
            `Tool route ${req.baseUrl + (req.route?.path ?? req.path)} is mounted as writing but declared ` +
              `branch: 'defaults-to-default-branch'; it is held to 'required'. ` +
              `Declare both \`write: true\` and \`branch: 'required'\` to its toolDef.`,
          );
        }
        const resolved = await resolveBranch(handling, args, branches);
        // The tool can read no other branch than the resolved one: `args`
        // carries it under the same name, and a tool that takes no branch
        // gets none at all.
        const toolArgs = resolved
          ? { ...args, branch: resolved.branch }
          : handling === 'none'
            ? withoutBranch(args)
            : args;
        const ctx = await resolve(auth, abort.signal, sessionId);
        if (resolved) ctx.branch = resolved.branch;
        let out = await handler(toolArgs, ctx);
        // A defaulted call's answer says which branch it ran on, so a caller
        // that forgot its branch can see it was answered about another.
        if (resolved?.defaulted && isPlainObject(out) && out.branch === undefined) {
          out = { ...out, branch: resolved.branch };
        }
        if (isAsyncIterable(out)) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          for await (const chunk of out) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.end();
        } else {
          res.json(out);
        }
      } catch (err) {
        // A handler can throw after streaming has begun (headers committed); in
        // that case we can only end the stream, not rewrite the status.
        if (res.headersSent) {
          if (hasHttpStatus(err)) log.error('handler failed post-stream:', { detail: err.message });
          else log.error('handler failed post-stream:', { err });
          res.end();
          return;
        }
        if (hasHttpStatus(err)) {
          // Structured details ride beside `error`, never over it. A domain
          // refusal brings its own payload exactly as it does on the HTTP
          // routes — most subclasses carry a `kind` and whatever that kind
          // brings with it, others carry their own keys (`AccessConfigError`
          // carries an `accessConfigErrors` list; see each subclass for its
          // payload) — so a tool caller
          // switching on `branch-not-found` vs `remote-branch-gone` does not
          // have to read the prose to tell them apart.
          if (err instanceof WorkflowDomainError) {
            res.status(err.status).json(domainErrorBody(err));
            return;
          }
          const details = err instanceof ToolError ? err.details : undefined;
          res.status(err.status).json({ ...details, error: err.message });
          return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error('handler failed:', { detail: msg });
        res.status(500).json({ error: msg });
      }
    };
  };
}

function withoutBranch(args: Record<string, unknown>): Record<string, unknown> {
  if (!('branch' in args)) return args;
  const rest = { ...args };
  delete rest.branch;
  return rest;
}

export type ToolHandlerFactory = ReturnType<typeof createToolHandlerFactory>;
