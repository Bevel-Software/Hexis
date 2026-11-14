import { createReadStream } from 'node:fs';
import express from 'express';
import { logger } from '../../shared/logging.js';
import { DownloadTokenError, type IAgentDownloadStore } from './agent-download.store.js';

const log = logger('agent-downloads');

/** The route's own prefix, under `/api`. */
export const AGENT_DOWNLOAD_ROUTE = '/agent/downloads/:token';

/**
 * The same endpoint with the token in the `x-download-token` HEADER instead of
 * the path — the address `downloadUrl` is, without its last segment. For a
 * caller that would rather its credential not land in an access log or a
 * shell history, as the upload route's header form is.
 */
export const AGENT_DOWNLOAD_HEADER_ROUTE = '/agent/downloads';

export interface AgentDownloadRouteDeps {
  downloads: IAgentDownloadStore;
  /**
   * Every user a fetch identifies itself as, by the credentials this server
   * recognises — none when it carries none (or none that verifies). The link
   * is the whole credential, so most fetches carry nothing; this only lets the
   * route refuse a fetch that says it is SOMEONE ELSE than the user the link
   * was issued to. Optional: absent, identity is not asked.
   */
  identify?: (req: express.Request) => Promise<string[]>;
}

/** The verifiers {@link createDownloadFetcherIdentifier} asks, as the composition root has them. */
export interface DownloadFetcherVerifiers {
  /** A connection key or internal token (the tool routes' verifier). Never throws for a bad token. */
  verifyToolToken(token: string): Promise<{ ok: true; auth: { userId: string } } | { ok: false }>;
  /** An app session JWT's signature and expiry; throws when it does not verify. */
  verifySession(token: string): { userId: string };
}

/**
 * Who a download fetch says it is, by EVERY credential this server issues:
 * a connection key or internal token, or an app session — as a bearer, or
 * as the `bevel_token` cookie a browser sends on its own. Every credential
 * is asked, not the first that verifies: a bearer and a cookie may name two
 * different users, and either one being someone else must refuse the link.
 * Empty when it carries none that verifies.
 *
 * Every kind, because the question is "is this fetch somebody OTHER than
 * the user the link was issued to?", and a credential kind left unasked is a
 * fetch that answers "nobody" while carrying another user's identity. A
 * session is asked by its signature alone, not whether its account is still
 * on: a switched-off account still says who it is, and that is all the
 * route needs to refuse it.
 */
export function createDownloadFetcherIdentifier(
  verifiers: DownloadFetcherVerifiers,
  readCookie: (req: express.Request) => string | null,
): (req: express.Request) => Promise<string[]> {
  return async (req) => {
    const header = req.headers.authorization;
    const bearer =
      typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
        ? header.slice(header.indexOf(' ') + 1).trim()
        : '';
    const users = new Set<string>();
    for (const token of [bearer, readCookie(req) ?? '']) {
      if (token === '') continue;
      const tool = await verifiers.verifyToolToken(token).catch(() => ({ ok: false as const }));
      if (tool.ok) {
        users.add(tool.auth.userId);
        continue;
      }
      try {
        users.add(verifiers.verifySession(token).userId);
      } catch {
        // Not a session either: this credential names nobody.
      }
    }
    return [...users];
  };
}

/**
 * `GET /api/agent/downloads/:token` — the outgoing twin of the agent upload
 * route, authenticated by a single-use link token and nothing else.
 *
 * Everything that decides WHAT is served happened when the link was issued:
 * `request_file_download` judged every file against the caller's `read` and
 * `download` rules, ran the deployment's read hook and captured the bytes.
 * This route only hands those bytes over, once, and deletes them when the
 * response ends — sent in full, failed, or abandoned by the client. A token
 * that is unknown, already fetched, expired or another user's gets one 404
 * that says none of those apart.
 */
export function createAgentDownloadRoutes(deps: AgentDownloadRouteDeps): express.Router {
  const router = express.Router();
  const { downloads, identify } = deps;

  const handle: express.RequestHandler = async (req, res) => {
    // THE TOKEN FIRST, before anything about the request is answered.
    const token = tokenOf(req);
    let claimed;
    try {
      const fetchers = identify ? await identify(req).catch(() => []) : [];
      claimed = downloads.claim(token, fetchers);
    } catch (err) {
      if (err instanceof DownloadTokenError) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(err.status).json({ error: err.message });
        return;
      }
      log.error('download failed:', { err });
      res.status(500).json({ error: 'Download failed' });
      return;
    }
    // The bytes go when the response ENDS, however it ends: `close` fires
    // after a complete send, after a failed one, and when the client leaves.
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      void downloads.finish(token);
    };
    res.on('close', done);
    res.setHeader('Content-Type', claimed.contentType);
    res.setHeader('Content-Length', String(claimed.bytes));
    res.setHeader('Content-Disposition', attachmentDisposition(claimed.filename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const stream = createReadStream(claimed.absolutePath);
    stream.on('error', (err) => {
      // The detail stays in the log: it quotes the store's absolute path.
      log.error('could not read a stored download:', { err });
      if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
      else res.destroy();
      done();
    });
    stream.pipe(res);
  };

  // Express answers HEAD with the GET handler, which would spend the link on a
  // probe that never receives the bytes. A link is for one GET, so HEAD is
  // refused before the token is looked at.
  const noHead: express.RequestHandler = (_req, res) => {
    res.setHeader('Allow', 'GET');
    res.status(405).end();
  };
  router.head(AGENT_DOWNLOAD_ROUTE, noHead);
  router.head(AGENT_DOWNLOAD_HEADER_ROUTE, noHead);
  router.get(AGENT_DOWNLOAD_ROUTE, handle);
  router.get(AGENT_DOWNLOAD_HEADER_ROUTE, handle);
  return router;
}

/**
 * `attachment` with the name twice (RFC 6266): an ASCII `filename` for a
 * client that reads only that — anything outside printable ASCII, and the
 * quote and backslash, become `_` — and the exact name as RFC 5987
 * `filename*`, where `encodeURIComponent`'s leftovers `'()*` are encoded
 * too, as the grammar requires. Without the plain form such a client would
 * save the file under the URL's last segment: the token.
 */
export function attachmentDisposition(filename: string): string {
  const name = filename.replace(/[\r\n]/g, '') || 'download';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The token the fetch presented: the `:token` path segment, or the
 * `x-download-token` header on the bare address. The path wins when both are
 * present. No token at all is the empty string, which meets the one refusal.
 */
function tokenOf(req: express.Request): string {
  const inPath = req.params.token;
  if (typeof inPath === 'string' && inPath.trim() !== '') return inPath.trim();
  const header = req.headers['x-download-token'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  return '';
}
