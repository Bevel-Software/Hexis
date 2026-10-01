import express from 'express';
import { validateFilename } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { AgentUploadStore, UploadTokenError } from './agent-upload.store.js';

const log = logger('agent-uploads');

/** The route's own prefix, under `/api`. One spelling, shared with the raw-body test below. */
export const AGENT_UPLOAD_ROUTE = '/agent/uploads/:token';

/**
 * Whether `path` is the agent upload route, and so must reach its handler with
 * the body still a STREAM.
 *
 * The app installs a global `express.json()`. It only claims a JSON
 * content-type, but `curl --data-binary @file.zip -H 'content-type:
 * application/json'` is a request an agent can and will make — and once the
 * parser has drained the stream there are no bytes left to store, so the
 * upload would answer "0 bytes received" for a file that was sent in full.
 * Exempting the path is the same move `/api/sync` makes for its HMAC body, and
 * for the same reason: whoever needs the exact bytes has to see them first.
 *
 * Case-insensitive, because Express routing is: `/api/Agent/uploads/x` reaches
 * this router, and a check that said no would let the parser eat that body.
 */
export function isAgentUploadRawBodyPath(path: string): boolean {
  return path.toLowerCase().startsWith('/api/agent/uploads/');
}

export interface AgentUploadRouteDeps {
  uploads: AgentUploadStore;
}

/**
 * `POST /api/agent/uploads/:token` — the one endpoint on this server
 * authenticated by a single-use token and nothing else.
 *
 * It exists because MCP tool arguments are JSON, so every byte an agent sends
 * through a tool passes through the model first. A 37 KB page gets truncated
 * mid-response; a file of regex backslashes fails to parse as a JSON string; a
 * PNG cannot be sent at all. Here the agent asks for a token, sends the file
 * with any HTTP client it has, and then names the token in
 * `apply_file_upload`. The bytes never enter a prompt.
 *
 * What the route itself may do is deliberately almost nothing: it stores bytes
 * against a token, in a directory beside the workspaces root, and answers what
 * it received. It resolves no workspace, writes nothing into one, and commits
 * nothing — every access, platform-file and branch rule is applied later, by
 * the apply tool, against the branch the caller then names. A token that is
 * unknown, spent, expired or someone else's gets one 404 that says which of
 * those it was: none of them.
 */
export function createAgentUploadRoutes(deps: AgentUploadRouteDeps): express.Router {
  const router = express.Router();
  const { uploads } = deps;

  router.post(AGENT_UPLOAD_ROUTE, async (req, res) => {
    const token = req.params.token;
    const filename = fileNameOf(req);
    if (filename === null) {
      res.status(400).json({
        error:
          'Name the file you are sending: add `?filename=<name>` to the upload URL (or send it as the ' +
          '`x-upload-filename` header). A single file lands under that name, and a name ending in `.zip` is ' +
          'read as an archive.',
      });
      return;
    }
    const invalid = validateFilename(filename);
    if (invalid !== null || filename.includes('/')) {
      res.status(400).json({
        error: `"${filename}" is not a usable file name: ${invalid ?? 'a name cannot contain "/"'}. Send one plain file name.`,
      });
      return;
    }
    // The declared length first, so a caller sending something far too large
    // is told the limit before it spends the bandwidth. The real total is
    // checked again below — `content-length` is the sender's claim, not a fact.
    const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > uploads.maxBytes) {
      res.status(413).json({ error: overLimit(declared, uploads.maxBytes) });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
        total += buf.length;
        if (total > uploads.maxBytes) {
          res.status(413).json({ error: overLimit(total, uploads.maxBytes) });
          return;
        }
        chunks.push(buf);
      }
      if (total === 0) {
        res.status(400).json({
          error:
            'That upload carried no bytes. Send the file as the request body — e.g. ' +
            '`curl -X POST --data-binary @<file> "<uploadUrl>?filename=<name>"`.',
        });
        return;
      }
      res.json(await uploads.attach(token, filename, Buffer.concat(chunks)));
    } catch (err) {
      if (err instanceof UploadTokenError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error('upload failed:', { err });
      res.status(500).json({ error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  return router;
}

/** The refusal an over-limit upload gets, naming the limit that applied. */
function overLimit(bytes: number, maxBytes: number): string {
  return (
    `That upload is ${bytes} bytes, over this deployment's ${maxBytes} byte upload limit. ` +
    'Send a smaller file, or split it across several uploads.'
  );
}

/**
 * The name the sender gave the file: the `filename` query parameter, the
 * `x-upload-filename` header, or a `content-disposition`'s own `filename=`.
 * Three spellings because three kinds of client are expected to use this —
 * `curl` with a query string, a scripted `fetch` with a header, and a client
 * that sends the disposition it would send to any upload endpoint.
 */
function fileNameOf(req: express.Request): string | null {
  const query = req.query.filename;
  if (typeof query === 'string' && query.trim() !== '') return query.trim();
  const header = req.headers['x-upload-filename'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  const disposition = req.headers['content-disposition'];
  if (typeof disposition === 'string') {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1]).trim();
        if (decoded !== '') return decoded;
      } catch {
        const raw = match[1].trim();
        if (raw !== '') return raw;
      }
    }
  }
  return null;
}
