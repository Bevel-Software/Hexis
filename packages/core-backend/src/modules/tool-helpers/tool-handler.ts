import type { Request, Response } from 'express';
import { hasHttpStatus, type ToolHandler } from './tool.contract.js';
import type { ResolveToolContext } from './tool-context.js';
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
 * from `req.toolAuth` (set by `toolAuth`), enforces write-scope, runs the
 * handler, and serializes the result — JSON for a value, SSE for an
 * async-iterable (streaming). `ToolError`/`hasHttpStatus` map to HTTP status.
 * The handler receives `req.body` as the flat args (UTCP's `body_field` already
 * delivered the inner body as the request body).
 */
export function createToolHandlerFactory(resolve: ResolveToolContext) {
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
      const abort = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      const body: unknown = req.body;
      if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
        res.status(400).json({ error: 'Request body must be a JSON object.' });
        return;
      }
      const args = (body ?? {}) as Record<string, unknown>;
      // `sessionId` rides the tool body like `branch` does: the external MCP
      // proxy injects it (ask-tool continuity convention) and the in-process
      // agent passes its thread id. Surfaced on the context so the ontology
      // gate can scope to one run without each handler re-reading args.
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
          if (hasHttpStatus(err)) console.error('[tools] handler failed post-stream:', err.message);
          else console.error('[tools] handler failed post-stream:', err instanceof Error ? err.message : err);
          res.end();
          return;
        }
        if (hasHttpStatus(err)) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error('[tools] handler failed:', msg);
        res.status(500).json({ error: msg });
      }
    };
  };
}

export type ToolHandlerFactory = ReturnType<typeof createToolHandlerFactory>;
