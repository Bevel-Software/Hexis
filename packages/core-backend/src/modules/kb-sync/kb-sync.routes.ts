import express from 'express';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { assertValidBranchName } from '../kb-fs/branch-name.js';
import type { IKbSyncService, SyncResult } from './kb-sync.interface.js';
import { parseSyncPayload, type SyncPayloadSource } from './sync-payload.js';
import { verifySyncCredential } from './sync-auth.js';

/**
 * Remote sync — a git host or a pipeline tells Hexis the repository changed.
 *
 *   POST /api/sync/<branch>   sync that one branch — the branch whose change
 *                             made the call. What a GitHub Action or a
 *                             pipeline step uses: the branch name goes in the
 *                             URL, the body is ignored for branch selection.
 *   POST /api/sync            the branches named by the body — an Azure
 *                             DevOps service hook or a GitHub/GitLab webhook
 *                             payload (they cannot template the URL), an
 *                             explicit `{ "branches": [...] }`, or nothing,
 *                             which syncs every clone Hexis holds.
 *
 * Mounted BEFORE every JWT-protected `/api` mount: the caller is a machine
 * holding the deployment's sync secret, not a browser session, and Express 5
 * would otherwise 401 it in the first protected mount. The route parses its
 * own body as raw bytes (the global JSON parser skips this path) because the
 * GitHub-style credential is an HMAC over exactly the bytes that arrived.
 *
 * Status codes are chosen for the two kinds of caller. A pipeline's
 * `curl --fail` must fail exactly when Hexis is not in sync; a webhook host
 * retries 5xx and gives up on 4xx:
 *
 *   200  every branch updated, already current, or not cloned here
 *   409  a branch has a CONFLICT: Hexis-side commits clash with the host.
 *        Automatic recovery is queued, but the branch is not in sync at the
 *        time of the answer; the body's `error` names the files. A retry
 *        answers 200 once recovery (or a person) has cleared it.
 *   503  a branch could not be pulled (origin unreachable, credential
 *        refused) — retriable. Also: no sync secret configured.
 *   401  missing or wrong credential
 *   400  a branch name git would refuse, or a body that is not JSON
 */
export interface KbSyncRouteDeps {
  kbSync: IKbSyncService;
  /** The configured secret, read per request so a setup-screen save applies at once. */
  syncSecret: () => string;
  authService: { verifyToken(token: string): { userId: string; email: string } };
  adminAccess: IAdminAccessService;
}

/** Cap on a webhook body. ADO's PR payloads run to a few hundred KB. */
const BODY_LIMIT = '2mb';

/**
 * Whether a request path belongs to this router and must reach it with its
 * body UNPARSED. The server's global JSON parser consults this: once that
 * parser has read the stream, `express.raw` below sees nothing and the
 * signature credential has no bytes to verify. Both routes share the check,
 * so the branch form (`/api/sync/<branch>`) is covered as well as the bare
 * one — an exact-path exemption used to protect only the latter.
 */
export function isSyncRawBodyPath(path: string): boolean {
  return path === '/api/sync' || path.startsWith('/api/sync/');
}

export function httpStatusFor(result: SyncResult): 200 | 409 | 503 {
  if (result.results.some((r) => r.outcome === 'conflict')) return 409;
  if (result.results.some((r) => r.outcome === 'error')) return 503;
  return 200;
}

type Selection = { source: SyncPayloadSource | 'path'; branches: string[] | 'all' };

export function createKbSyncRoutes(deps: KbSyncRouteDeps): express.Router {
  const router = express.Router();

  const rawBody = express.raw({ type: () => true, limit: BODY_LIMIT });

  /**
   * Everything both routes share: the credential check, then the sync and
   * its answer. `select` turns the request into the branches to sync, or
   * sends its own 400 and returns null.
   */
  async function handle(
    req: express.Request,
    res: express.Response,
    select: () => Selection | null,
  ): Promise<void> {
    const raw: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;

    const auth = await verifySyncCredential(
      {
        secret: deps.syncSecret(),
        authorization: header(req, 'authorization'),
        gitlabToken: header(req, 'x-gitlab-token'),
        hubSignature: header(req, 'x-hub-signature-256'),
        rawBody: raw,
      },
      {
        verifyJwt: (token) => {
          try {
            return { email: deps.authService.verifyToken(token).email };
          } catch {
            return null;
          }
        },
        isAdmin: (email) => deps.adminAccess.isAdmin(email),
      },
    );
    if (!auth.ok) {
      if (auth.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="hexis-sync"');
      res.status(auth.status).json({ error: auth.message });
      return;
    }

    const selection = select();
    if (!selection) return;

    const who = auth.credential.kind === 'admin-session' ? auth.credential.email : auth.credential.kind;
    const asked =
      selection.branches === 'all' ? 'all cloned branches' : selection.branches.join(', ') || '(none)';
    try {
      const result = await deps.kbSync.sync({ branches: selection.branches, by: who });
      const summary = result.results.map((r) => `${r.branch}=${r.outcome}`).join(' ');
      console.log(`[sync] by ${who} via ${selection.source} for ${asked}: ${result.status} ${summary}`);
      res.status(httpStatusFor(result)).json(result);
    } catch (err) {
      console.error('[sync] unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  // The branch in the URL. A wildcard rather than `:branch` so a branch with
  // slashes (`ali/new-skill`) works spelled either way — as segments or
  // percent-encoded as one.
  router.post('/sync/*branch', rawBody, (req, res) =>
    handle(req, res, () => {
      const param = req.params.branch as unknown;
      const branch = (Array.isArray(param) ? param.join('/') : String(param ?? '')).trim();
      try {
        assertValidBranchName(branch);
      } catch {
        res.status(400).json({ error: `Not a valid branch name: ${branch}` });
        return null;
      }
      return { source: 'path', branches: [branch] };
    }),
  );

  router.post('/sync', rawBody, (req, res) =>
    handle(req, res, () => {
      const raw: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
      let body: unknown = undefined;
      if (raw && raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          res.status(400).json({ error: 'The request body is not valid JSON.' });
          return null;
        }
      }
      const parsed = parseSyncPayload(body);
      if (parsed.invalid.length > 0) {
        res.status(400).json({
          error: `Not a valid branch name: ${parsed.invalid.join(', ')}`,
          invalid: parsed.invalid,
        });
        return null;
      }
      return { source: parsed.source, branches: parsed.branches };
    }),
  );

  return router;
}

function header(req: express.Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}
