import { createReadStream } from 'node:fs';
import express from 'express';
import { logger } from '../../shared/logging.js';
import { AgentDownloadStore, DownloadTokenError } from './agent-download.store.js';

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
  downloads: AgentDownloadStore;
  /**
   * The user a fetch identifies itself as, when it carries a credential this
   * server recognises — or null when it carries none (or one that does not
   * verify). The link is the whole credential, so most fetches carry nothing;
   * this only lets the route refuse a fetch that says it is SOMEONE ELSE than
   * the user the link was issued to. Optional: absent, identity is not asked.
   */
  identify?: (req: express.Request) => Promise<string | null>;
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
      const fetcher = identify ? await identify(req).catch(() => null) : null;
      claimed = downloads.claim(token, fetcher);
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
    // RFC 5987 UTF-8 filename; CR/LF stripped to block header injection.
    const name = claimed.filename.replace(/[\r\n]/g, '') || 'download';
    res.setHeader('Content-Type', claimed.contentType);
    res.setHeader('Content-Length', String(claimed.bytes));
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
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
