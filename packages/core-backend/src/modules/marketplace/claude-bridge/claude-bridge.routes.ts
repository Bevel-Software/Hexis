import express from 'express';
import type { AuthUser } from '@bevel-software/platform-shared';
import '../../auth/auth.middleware.js'; // Express Request.userId / userEmail augmentation
import '../../tool-auth/external-api-key.interface.js'; // Express Request augmentation (req.externalApiKeyId)
import type { MarketplaceRepoService } from '../marketplace-repo.service.js';
import type { MarketplaceKeyResolver } from '../git-http.routes.js';
import { ClaudeBridgeRequestError, type ClaudeMarketplaceBridge } from './claude-bridge.service.js';

export interface ClaudeBridgeRoutesDeps {
  bridge: ClaudeMarketplaceBridge;
  keys: MarketplaceKeyResolver;
  repo: MarketplaceRepoService;
  /**
   * The owner and name claude.ai derives from the marketplace URL people
   * paste — the SAME URL Claude Code clones: `https://<host>/git/marketplace.git`
   * reads as owner `git`, repository `marketplace`. One address for every
   * Claude surface.
   */
  owner: string;
  repoName: string;
  /** The deployment's public origin, for the URLs GitHub-shaped bodies carry. */
  publicUrl: string;
}

/**
 * The GitHub-shaped surface claude.ai talks to when a person adds this
 * deployment's marketplace from their own settings — observed against a
 * facade, call for call, and nothing beyond it:
 *
 *   GET  /login/oauth/authorize        the "connect your account" redirect
 *   POST /login/oauth/access_token     code → token (our client id + secret)
 *   GET  /api/v3/repos/:owner/:repo    repository metadata
 *   GET  …/commits?per_page=1          the head commit — of THIS person's tree
 *   GET  …/zipball/:ref                that tree, zipped
 *
 * Mounted at the app root, ahead of the SPA and the `/api` JWT mounts: the
 * first two are hit by a bare browser and by Anthropic's backend, the rest
 * carry the person's token as a Bearer. The token is a connection key, so a
 * revoked link fails here the same way it fails on the git remote.
 *
 * Errors are GitHub-shaped too (`{ message }`, and the OAuth error body on
 * the token endpoint): the caller is a GitHub client and reads them as one.
 */
export function createClaudeBridgeRoutes(deps: ClaudeBridgeRoutesDeps): express.Router {
  const router = express.Router();
  const { bridge, keys, repo, owner, repoName, publicUrl } = deps;
  const fullName = `${owner}/${repoName}`;

  router.get('/login/oauth/authorize', async (req, res) => {
    try {
      res.redirect(302, await bridge.authorizeRedirect(req.query as Record<string, unknown>));
    } catch (err) {
      answerError(res, err);
    }
  });

  // GitHub's token endpoint takes JSON or a form and answers in the shape
  // `Accept` asks for; claude.ai sends JSON and asks for JSON.
  router.post(
    '/login/oauth/access_token',
    express.json({ limit: '16kb' }),
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req, res) => {
      try {
        const tokens = await bridge.exchangeCode((req.body ?? {}) as Record<string, unknown>);
        if (wantsForm(req)) {
          res.type('application/x-www-form-urlencoded').send(new URLSearchParams(tokens).toString());
          return;
        }
        res.json(tokens);
      } catch (err) {
        if (err instanceof ClaudeBridgeRequestError) {
          // GitHub answers a bad exchange with 200 + an error body; a 4xx
          // with the same body is what every OAuth client handles, and what
          // the facade answered.
          res.status(err.status).json({ error: err.code, error_description: err.message });
          return;
        }
        answerError(res, err);
      }
    },
  );

  // --- the REST API, as far as the observed contract goes ---------------------

  const api = express.Router();

  api.use(async (req, res, next) => {
    const token = bearerOf(req);
    if (!token || !keys.looksLikeExternalApiKey(token)) {
      unauthorized(res);
      return;
    }
    let resolved: { tokenId: string; user: AuthUser } | null;
    try {
      resolved = await keys.verifyAndLoadToken(token);
    } catch (err) {
      console.error('[claude-bridge] key verification failed:', err);
      res.status(500).json({ message: 'Authentication backend unavailable' });
      return;
    }
    if (!resolved) {
      unauthorized(res);
      return;
    }
    req.userId = resolved.user.id;
    req.userEmail = resolved.user.email;
    req.externalApiKeyId = resolved.tokenId;
    next();
  });

  const isOurs = (req: express.Request) => req.params.owner === owner && req.params.repo === repoName;
  const notFound = (res: express.Response) => res.status(404).json({ message: 'Not Found' });

  api.get('/repos/:owner/:repo', (req, res) => {
    if (!isOurs(req)) return void notFound(res);
    res.json(repositoryBody(fullName, owner, repoName, publicUrl));
  });

  api.get('/repos/:owner/:repo/commits', async (req, res) => {
    if (!isOurs(req)) return void notFound(res);
    try {
      const { sha } = await repo.headFor({ id: req.userId!, email: req.userEmail! });
      const commit = await repo.describeCommit(sha);
      res.json([commitBody(commit, fullName, publicUrl)]);
    } catch (err) {
      answerError(res, err);
    }
  });

  api.get('/repos/:owner/:repo/zipball/:ref', async (req, res) => {
    if (!isOurs(req)) return void notFound(res);
    try {
      const { namespace, sha: head } = await repo.headFor({ id: req.userId!, email: req.userEmail! });
      const ref = req.params.ref;
      // Only THIS person's tree, at its head or a commit behind it: the object
      // store is shared across everyone, so a sha alone must never be enough
      // to read a tree compiled for someone else.
      const sha = ref === 'HEAD' || ref === 'main' ? head : ref;
      if (!(await repo.contains(namespace, sha))) return void notFound(res);
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${owner}-${repoName}-${sha.slice(0, 7)}.zip`);
      const archive = repo.archiveZip(sha, `${owner}-${repoName}-${sha.slice(0, 7)}`);
      const stderr: Buffer[] = [];
      archive.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      const fail = (reason: string) => {
        console.error(`[claude-bridge] zipball ${sha.slice(0, 7)} failed: ${reason}`);
        // Headers are already out once the stream started; the only honest
        // answer then is a cut connection, which the client sees as a failed
        // download rather than a truncated archive it might unpack.
        if (!res.headersSent) res.status(500).json({ message: 'Archive failed' });
        else res.destroy();
      };
      archive.on('error', (err: Error) => fail(err.message));
      archive.on('close', (code) => {
        if (code !== 0) fail(`git archive exited ${code}: ${Buffer.concat(stderr).toString().trim()}`);
      });
      archive.stdout!.pipe(res);
    } catch (err) {
      answerError(res, err);
    }
  });

  api.use((_req, res) => notFound(res));
  router.use('/api/v3', api);

  return router;
}

function bearerOf(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || !/^(bearer|token)$/i.test(scheme)) return null;
  return rest.join(' ').trim() || null;
}

function unauthorized(res: express.Response): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="hexis-marketplace"');
  res.status(401).json({ message: 'Bad credentials' });
}

function wantsForm(req: express.Request): boolean {
  const accept = req.headers.accept ?? '';
  return accept.includes('application/x-www-form-urlencoded') && !accept.includes('json');
}

function answerError(res: express.Response, err: unknown): void {
  if (err instanceof ClaudeBridgeRequestError) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  console.error('[claude-bridge]', err);
  res.status(500).json({ message: 'Internal error' });
}

/** A repository as GitHub describes one — the fields a marketplace sync reads. */
function repositoryBody(fullName: string, owner: string, name: string, publicUrl: string) {
  const html = `${publicUrl.replace(/\/$/, '')}/${fullName}`;
  return {
    id: 1,
    node_id: 'R_hexis_marketplace',
    name,
    full_name: fullName,
    private: true,
    owner: { login: owner, id: 1, type: 'Organization' },
    html_url: html,
    description: 'The skills you may read, compiled as native plugins.',
    fork: false,
    url: `${publicUrl.replace(/\/$/, '')}/api/v3/repos/${fullName}`,
    clone_url: `${html}.git`,
    default_branch: 'main',
    visibility: 'private',
    archived: false,
    disabled: false,
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  };
}

function commitBody(
  commit: { sha: string; message: string; authorName: string; authorEmail: string; date: string; tree: string },
  fullName: string,
  publicUrl: string,
) {
  const base = `${publicUrl.replace(/\/$/, '')}/api/v3/repos/${fullName}`;
  const who = { name: commit.authorName, email: commit.authorEmail, date: commit.date };
  return {
    sha: commit.sha,
    node_id: `C_${commit.sha}`,
    commit: {
      author: who,
      committer: who,
      message: commit.message,
      tree: { sha: commit.tree, url: `${base}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    url: `${base}/commits/${commit.sha}`,
    html_url: `${publicUrl.replace(/\/$/, '')}/${fullName}/commit/${commit.sha}`,
    author: null,
    committer: null,
    parents: [],
  };
}
