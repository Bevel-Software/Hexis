import type { Request, Response } from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('tools');
import { hasHttpStatus, ToolError, type ToolHandler } from './tool.contract.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';
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
export function createToolHandlerFactory(resolve: ResolveToolContext, writeAccess: IWriteAccess = alwaysWritable) {
  return function toolHandler(handler: ToolHandler, opts: ToolHandlerOptions = {}) {
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
        const ctx = await resolve(auth, abort.signal, sessionId);
        const out = await handler(args, ctx);
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

export type ToolHandlerFactory = ReturnType<typeof createToolHandlerFactory>;
