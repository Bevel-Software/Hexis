import express from 'express';
import { spawn } from 'node:child_process';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { MarketplaceRepoService } from './marketplace-repo.service.js';
import '../tool-auth/external-api-key.interface.js'; // Express Request augmentation (req.externalApiKeyId)

/** How a bearer string resolves to a user — the connection-key service's shape. */
export interface MarketplaceKeyResolver {
  looksLikeExternalApiKey(token: string): boolean;
  verifyAndLoadToken(plaintext: string): Promise<{ tokenId: string; user: AuthUser } | null>;
}

/**
 * The per-user marketplace as a git remote:
 *
 *   git clone https://key:<connection-key>@<host>/git/marketplace.git
 *
 * Anything that speaks git's smart HTTP protocol — Claude Code, Codex, `npx
 * skills`, plain git — clones a repository whose `main` is the caller's
 * compiled tree. The route authenticates, brings the caller's namespace up to
 * date (`MarketplaceRepoService.ensureCompiled`), and hands the request to
 * `git http-backend` with `GIT_NAMESPACE` set, so git itself serves the
 * protocol and only that namespace's refs exist as far as the client can tell.
 *
 * AUTH: HTTP Basic with the connection key as the password (the username is
 * anything — git sends whatever the URL carried), or the key as a Bearer
 * token. The same keys the MCP endpoint takes, the same service resolving
 * them, and the same metering stamp (`req.externalApiKeyId`), so a key's
 * `lastUsedAt` moves when an agent refreshes its plugins. A 401 challenges
 * with Basic so a client without credentials prompts for them.
 *
 * READ-ONLY: the receive-pack service is refused here by name, and the bare
 * repository pins `http.receivepack=false` for good measure — a push would
 * otherwise be enabled by http-backend the moment REMOTE_USER is set.
 */
export function createMarketplaceGitRoutes(deps: {
  repo: MarketplaceRepoService;
  keys: MarketplaceKeyResolver;
  /** The URL path the router is mounted at, e.g. `/git`. Used for PATH_INFO. */
  mountPath: string;
}): express.Router {
  const { repo, keys, mountPath } = deps;
  const router = express.Router();
  const repoRoute = `/${repo.repoName}`;

  const challenge = (res: express.Response, message: string) => {
    res.setHeader('WWW-Authenticate', 'Basic realm="hexis-marketplace"');
    res.status(401).type('text/plain').send(message);
  };

  /** The connection key out of Basic (`user:key`, `key:` or `:key`) or Bearer. */
  const keyOf = (header: string | undefined): string | null => {
    if (!header) return null;
    const space = header.indexOf(' ');
    if (space < 0) return null;
    const scheme = header.slice(0, space).toLowerCase();
    const value = header.slice(space + 1).trim();
    if (scheme === 'bearer') return value || null;
    if (scheme !== 'basic') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(value, 'base64').toString('utf-8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const pass = colon < 0 ? '' : decoded.slice(colon + 1);
    // Either half may carry the key: `https://key:<k>@` puts it in the
    // password, `https://<k>@` in the username.
    if (pass && keys.looksLikeExternalApiKey(pass)) return pass;
    if (user && keys.looksLikeExternalApiKey(user)) return user;
    return pass || user || null;
  };

  router.all(`${repoRoute}{/*rest}`, async (req, res) => {
    const service = String(req.query.service ?? '');
    const rest = `/${([] as string[]).concat((req.params as { rest?: string | string[] }).rest ?? []).join('/')}`;
    // Refuse writes before touching anything — by service name on info/refs,
    // and by endpoint on the POST.
    if (service === 'git-receive-pack' || rest === '/git-receive-pack') {
      res.status(403).type('text/plain').send('This repository is read-only.');
      return;
    }

    const key = keyOf(req.headers.authorization);
    if (!key || !keys.looksLikeExternalApiKey(key)) {
      challenge(res, 'A connection key is required: https://key:<connection-key>@<host>/git/marketplace.git');
      return;
    }
    let resolved: { tokenId: string; user: AuthUser } | null;
    try {
      resolved = await keys.verifyAndLoadToken(key);
    } catch (err) {
      console.error('[marketplace] connection-key verification failed:', err);
      res.status(500).type('text/plain').send('Authentication backend unavailable');
      return;
    }
    if (!resolved) {
      challenge(res, 'Invalid or revoked connection key');
      return;
    }
    req.userId = resolved.user.id;
    req.userEmail = resolved.user.email;
    req.externalApiKeyId = resolved.tokenId;

    let ensured: { namespace: string };
    try {
      ensured = await repo.ensureCompiled({ id: resolved.user.id, email: resolved.user.email });
    } catch (err) {
      console.error('[marketplace] compile failed:', err);
      res.status(500).type('text/plain').send('Could not prepare your marketplace');
      return;
    }

    // CGI, as git documents it. PATH_INFO is the path below GIT_PROJECT_ROOT
    // — `/marketplace.git/info/refs` — regardless of where we are mounted.
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: repo.projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_NAMESPACE: ensured.namespace,
      PATH_INFO: `${repoRoute}${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: query,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: resolved.user.email,
      REMOTE_ADDR: req.ip ?? '',
      SERVER_PROTOCOL: 'HTTP/1.1',
      HTTP_HOST: req.headers.host ?? '',
      SCRIPT_NAME: mountPath,
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
    if (req.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = String(req.headers['git-protocol']);

    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk: Buffer) => console.warn(`[marketplace] http-backend: ${chunk.toString('utf-8').trim()}`));
    child.on('error', (err) => {
      console.error('[marketplace] could not run git http-backend:', err);
      if (!res.headersSent) res.status(500).type('text/plain').send('git is unavailable');
    });
    req.pipe(child.stdin);
    req.on('aborted', () => child.kill());

    // Parse the CGI header block (`Status:`, `Content-Type:`, …) off stdout,
    // then stream the body straight through.
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        // Backpressure: a slow client must not make Node buffer a whole pack.
        if (!res.write(chunk)) {
          child.stdout.pause();
          res.once('drain', () => child.stdout.resume());
        }
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const cut = headerBuf.indexOf('\r\n\r\n') >= 0 ? headerBuf.indexOf('\r\n\r\n') : headerBuf.indexOf('\n\n');
      if (cut < 0) return;
      const sepLen = headerBuf.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
      const head = headerBuf.subarray(0, cut).toString('utf-8');
      let status = 200;
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else res.setHeader(name, value);
      }
      res.status(status);
      headersDone = true;
      const body = headerBuf.subarray(cut + sepLen);
      if (body.length > 0) res.write(body);
    });
    child.stdout.on('end', () => {
      if (!headersDone) {
        if (!res.headersSent) res.status(502).type('text/plain').send('git http-backend produced no response');
        return;
      }
      res.end();
    });
  });

  return router;
}
