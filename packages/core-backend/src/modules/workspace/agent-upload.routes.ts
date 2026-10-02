import express from 'express';
import { validateFilename } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { AgentUploadStore, UploadTokenError } from './agent-upload.store.js';

const log = logger('agent-uploads');

/** The route's own prefix, under `/api`. One spelling, shared with the raw-body test below. */
export const AGENT_UPLOAD_ROUTE = '/agent/uploads/:token';

/**
 * The same endpoint with the token in the `x-upload-token` HEADER instead of
 * the path — the address `uploadUrl` is, without its last segment.
 *
 * Two spellings because a token in a URL is a credential in a place that keeps
 * copies: an access log, a proxy log, a shell history, a `ps` listing of the
 * `curl` that sent it. The path form is what `request_file_upload` answers,
 * because one address an agent can paste into any client is the thing that
 * makes this route usable at all; the header form is for a caller that would
 * rather its credential not be written down on the way. Both reach the same
 * handler and are judged identically — same token, same single use.
 */
export const AGENT_UPLOAD_HEADER_ROUTE = '/agent/uploads';

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
  // Trailing slashes trimmed first, so the header form's bare address matches
  // in every spelling Express routes to it (`/api/agent/uploads` and
  // `/api/agent/uploads/` are one route): missing one of them would hand that
  // request to the JSON parser, and the bytes it drains are gone.
  const lower = path.toLowerCase().replace(/\/+$/, '');
  return lower === '/api/agent/uploads' || lower.startsWith('/api/agent/uploads/');
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

  const handle: express.RequestHandler = async (req, res) => {
    const token = tokenOf(req);
    try {
      // THE TOKEN FIRST, before anything about the request is read, parsed,
      // judged or quoted back. This route is authenticated by the token and
      // nothing else, which cuts two ways. Without the check up here, anyone
      // could make the process buffer the deployment's whole upload limit per
      // request against tokens they invented, as many at a time as they liked;
      // and a caller holding no token could learn which of its OTHER guesses
      // were well formed — "that is not a usable file name" is an answer only
      // somebody entitled to send a file should get. One refusal, nothing else.
      // `attach` below asks again, under the same record, because that is where
      // the token is actually spent.
      uploads.assertOpen(token);
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
      // Then the declared length, so a caller sending something far too large
      // is told the limit before it spends the bandwidth. The real total is
      // checked again below — `content-length` is the sender's claim, not a fact.
      const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
      if (Number.isFinite(declared) && declared > uploads.maxBytes) {
        res.status(413).json({ error: overLimit(declared, uploads.maxBytes) });
        return;
      }
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
      // The detail stays in the log. An unexpected failure here is a
      // filesystem error, and its message quotes the absolute path of the
      // store's root — a place the caller is told nothing else about.
      log.error('upload failed:', { err });
      res.status(500).json({ error: 'Upload failed' });
    }
  };

  // Both spellings of the one endpoint: the token in the path, or in the
  // `x-upload-token` header on the bare address.
  router.post(AGENT_UPLOAD_ROUTE, handle);
  router.post(AGENT_UPLOAD_HEADER_ROUTE, handle);

  return router;
}

/**
 * The token the sender presented: the `:token` path segment, or the
 * `x-upload-token` header when the bytes went to the bare address.
 *
 * The path wins when both are present — it is the address the sender actually
 * POSTed to, and a header left over from an earlier upload must not quietly
 * redirect these bytes onto a different token.
 *
 * No token at all answers the empty string rather than its own refusal, so it
 * goes through `assertOpen` like any other unusable token and gets the same
 * single 404. A caller holding nothing is told nothing it did not already
 * know — not even whether this endpoint wanted a header.
 */
function tokenOf(req: express.Request): string {
  const inPath = req.params.token;
  if (typeof inPath === 'string' && inPath.trim() !== '') return inPath.trim();
  const header = req.headers['x-upload-token'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  return '';
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
  if (typeof disposition === 'string') return dispositionFilename(disposition);
  return null;
}

/**
 * The `filename` a `content-disposition` names, or null when it names none.
 *
 * A QUOTED value is read to its closing quote, not to the first semicolon: a
 * semicolon separates the header's parameters only OUTSIDE the quotes, and
 * `filename="report;final.md"` is one perfectly ordinary name that a
 * semicolon-first reading landed as `report`. An unquoted value ends at the
 * next parameter, as it must.
 *
 * Percent-decoded only in the extended `filename*=UTF-8''…` form, which is the
 * only one where the encoding is part of the grammar. A plain `filename=` value
 * is the name itself, so `50%20off.md` stays `50%20off.md` rather than losing
 * its `%20` to a decode nobody asked for.
 *
 * The parameter name is matched at a boundary — the start of the header or a
 * `;` — because `filename` is a suffix of other perfectly legal parameter
 * names: without it, `inline; xfilename=wrong.md` read `wrong.md` as the name
 * the sender gave, from a parameter that says nothing of the kind.
 */
export function dispositionFilename(disposition: string): string | null {
  const match = /(?:^|;)\s*filename(\*?)\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition);
  if (!match) return null;
  const extended = match[1] === '*';
  const raw = (match[2] ?? match[3] ?? '').trim();
  if (!extended) return raw === '' ? null : raw;
  // `UTF-8''name`, or any other charset and language the sender declares.
  const encoded = raw.replace(/^[^']*'[^']*'/, '');
  try {
    const decoded = decodeURIComponent(encoded).trim();
    if (decoded !== '') return decoded;
  } catch {
    const kept = encoded.trim();
    if (kept !== '') return kept;
  }
  return null;
}
