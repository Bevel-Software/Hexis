import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import { logger } from '../../shared/logging.js';
import type { DeploymentSettingsService } from '../settings/deployment-settings.service.js';
import { GitHubAppClient, GitHubAppError } from './github-app.client.js';
import { repositoriesAsSetting, type GitHubAppConnection } from './github-app.connection.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

const log = logger('github-app');

const STATE_COOKIE = 'hexis_github_state';
const STATE_MAX_AGE_S = 15 * 60;
/** A GitHub organisation's name, as it appears in an address. */
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** GitHub refuses an app name longer than this. */
const MAX_APP_NAME = 34;

export interface GitHubAppRoutesDeps {
  settings: Pick<DeploymentSettingsService, 'resolve' | 'record'>;
  connection: GitHubAppConnection;
  adminAccess: IAdminAccessService;
  /** Where GitHub sends the browser back to: this deployment's own address. */
  publicBackendUrl: string;
  publicFrontendUrl: string;
  /** Whether the deployment is set up: decides which page a round trip ends on. */
  isComplete(): boolean;
  client?: GitHubAppClient;
}

/** The address GitHub is told to send the browser back to once the app is installed. */
export function githubAppCallbackUrl(publicBackendUrl: string): string {
  return `${publicBackendUrl}/api/setup/github-app/callback`;
}

/**
 * The manifest a deployment's own GitHub App is created from. It asks for
 * what the deployment does and nothing else: read and write the contents of
 * the repositories it is installed on. No webhook, no events, not public:
 * the app is this deployment's, installed by its owner on the one
 * repository the knowledge base lives in.
 */
export function githubAppManifest(publicBackendUrl: string, publicFrontendUrl: string): Record<string, unknown> {
  const host = new URL(publicFrontendUrl).host;
  return {
    name: `Hexis ${host}`.slice(0, MAX_APP_NAME),
    url: publicFrontendUrl,
    description: `Lets the Hexis deployment at ${host} read and write the repository its knowledge base lives in.`,
    redirect_url: `${publicBackendUrl}/api/setup/github-app/registered`,
    callback_urls: [githubAppCallbackUrl(publicBackendUrl)],
    // GitHub then sends the person back signed in, which is what lets the
    // deployment check that the installation they name is one they hold.
    request_oauth_on_install: true,
    public: false,
    default_permissions: { contents: 'write', metadata: 'read' },
    default_events: [],
  };
}

function readCookie(req: express.Request, name: string): string | null {
  for (const segment of (req.headers.cookie ?? '').split(';')) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    try {
      return decodeURIComponent(trimmed.slice(name.length + 1)) || null;
    } catch {
      return null;
    }
  }
  return null;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Connecting a repository on GitHub through a GitHub App, from the setup
 * screen. Mounted behind the deployment's sign-in; every route is an
 * admin's.
 *
 *   GET  /setup/github-app               where the connection stands
 *   POST /setup/github-app/manifest      start registering this deployment's own app
 *   GET  /setup/github-app/registered    GitHub sends the browser back: the app exists
 *   POST /setup/github-app/install       where on GitHub the app is installed
 *   GET  /setup/github-app/callback      GitHub sends the browser back: the app is installed
 *   GET  /setup/github-app/repositories  what the deployment may be pointed at
 *
 * A ROUND TRIP IS STARTED BY A POST AND ENDED BY A GET. The two routes
 * GitHub sends the browser to are ordinary navigations, authenticated by
 * the session cookie; each checks a state this browser was given when the
 * round trip started, and spends it. Nothing that starts one is a link, so
 * a link somebody was sent starts nothing.
 *
 * WHAT THE DEPLOYMENT MAY REACH is never taken from the address the browser
 * came back on. GitHub puts an installation's number there and anyone can
 * write another: with one app serving many deployments, that number is the
 * only thing between a deployment and another organisation's repositories.
 * GitHub sends the person back signed in, and the deployment asks GitHub
 * two things about THAT PERSON: which installations they reach, and which
 * repositories of the one they named they can push to with their own
 * account. The first alone is not enough, since read access to one
 * repository puts an installation on that list. Only the second is what
 * the deployment may be pointed at.
 */
export function createGitHubAppRoutes(deps: GitHubAppRoutesDeps): express.Router {
  const router = express.Router();
  const client = deps.client ?? new GitHubAppClient();
  const { settings, connection } = deps;
  const secure = deps.publicBackendUrl.startsWith('https');

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!(await deps.adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Admins only' });
      return;
    }
    next();
  };

  /** A state for one round trip, kept in this browser until it comes back. */
  const beginRoundTrip = (res: express.Response): string => {
    const tag = settings.resolve('githubAppStateTag');
    const state = `${tag ? `${tag}.` : ''}${randomBytes(24).toString('base64url')}`;
    res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure, maxAge: STATE_MAX_AGE_S * 1000, path: '/' });
    return state;
  };
  /** Whether the browser that came back is the one that was sent. */
  const cameBack = (req: express.Request): boolean => {
    const kept = readCookie(req, STATE_COOKIE);
    const given = typeof req.query.state === 'string' ? req.query.state : '';
    return Boolean(kept && given && same(kept, given));
  };
  /** Back to the setup screen, saying how the round trip ended. */
  const finish = (res: express.Response, outcome: string): void => {
    const page = deps.isComplete() ? '/deployment' : '/';
    res.redirect(`${deps.publicFrontendUrl}${page}?github=${encodeURIComponent(outcome)}`);
  };
  const installUrl = (slug: string, state: string): string =>
    `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
  const outcomeOf = (err: unknown): string =>
    err instanceof GitHubAppError && err.kind === 'unreachable' ? 'unreachable' : 'refused';

  router.get('/setup/github-app', requireAdmin, (_req, res) => {
    const credentials = connection.credentials();
    res.json({
      // Who supplied the app. Null: this deployment has none yet, and can register its own.
      registeredBy: connection.registeredBy(),
      app: credentials ? { slug: credentials.slug, url: `https://github.com/apps/${credentials.slug}` } : null,
      installation: connection.installationId()
        ? { id: connection.installationId(), account: settings.resolve('githubInstallationAccount') }
        : null,
      repository: settings.resolve('githubRepository') || null,
    });
  });

  router.post('/setup/github-app/manifest', requireAdmin, (req, res) => {
    if (connection.credentials()) {
      res.status(409).json({ error: 'This deployment already has a GitHub App.' });
      return;
    }
    const organization = (req.body as { organization?: unknown } | undefined)?.organization;
    const org = typeof organization === 'string' ? organization.trim() : '';
    if (org && !ORGANIZATION_PATTERN.test(org)) {
      res.status(400).json({ error: 'Enter the organisation’s name as it appears in its GitHub address.' });
      return;
    }
    const state = beginRoundTrip(res);
    const base = org ? `https://github.com/organizations/${org}/settings/apps/new` : 'https://github.com/settings/apps/new';
    // The browser posts the manifest to GitHub itself: a form, not a request of ours.
    res.json({
      action: `${base}?state=${encodeURIComponent(state)}`,
      manifest: githubAppManifest(deps.publicBackendUrl, deps.publicFrontendUrl),
    });
  });

  router.get('/setup/github-app/registered', requireAdmin, async (req, res) => {
    // Spent on return, however the return ends.
    const returned = cameBack(req);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!returned) {
      finish(res, 'state');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || connection.credentials()) {
      finish(res, code ? 'already-registered' : 'refused');
      return;
    }
    try {
      const app = await client.convertManifest(code);
      await settings.record(
        {
          githubAppId: app.appId,
          githubAppSlug: app.slug,
          githubAppPrivateKey: app.privateKey,
          githubAppClientId: app.clientId,
          githubAppClientSecret: app.clientSecret,
        },
        req.userId ?? null,
      );
      log.info(`GitHub App "${app.slug}" registered for this deployment`, { slug: app.slug, owner: app.owner });
      // Straight on to installing it: the same round trip, the same state.
      res.redirect(installUrl(app.slug, beginRoundTrip(res)));
    } catch (err) {
      log.error('the GitHub App could not be registered:', { detail: err instanceof Error ? err.message : String(err) });
      finish(res, outcomeOf(err));
    }
  });

  /**
   * A POST that answers with the address, and the page sends the browser
   * there. As a link it was a round trip anyone could start in an admin's
   * browser by getting them to follow it: the state would be set, and
   * whatever they then installed would come back with a state that matched.
   */
  router.post('/setup/github-app/install', requireAdmin, (_req, res) => {
    const credentials = connection.credentials();
    if (!credentials) {
      res.status(409).json({ error: 'This deployment has no GitHub App yet. Create it first.' });
      return;
    }
    res.json({ url: installUrl(credentials.slug, beginRoundTrip(res)) });
  });

  router.get('/setup/github-app/callback', requireAdmin, async (req, res) => {
    const returned = cameBack(req);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!returned) {
      finish(res, 'state');
      return;
    }
    const credentials = connection.credentials();
    if (!credentials) {
      finish(res, 'not-registered');
      return;
    }
    // Someone without the right to install asked their organisation's owner
    // to: nothing is installed yet, and there is nothing to record.
    if (req.query.setup_action === 'request') {
      finish(res, 'requested');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const named = typeof req.query.installation_id === 'string' ? req.query.installation_id : '';
    if (!code || !/^\d+$/.test(named)) {
      finish(res, 'refused');
      return;
    }
    try {
      const userToken = await client.exchangeUserCode(credentials, code);
      const held = (await client.installationsOf(userToken)).find((installation) => installation.id === named);
      if (!held) {
        log.warn('an installation was named that the person who came back cannot reach', { installation: named });
        finish(res, 'not-yours');
        return;
      }
      // Reaching the installation is not holding it: read access to one
      // repository it covers is enough for GitHub to list it. What the
      // deployment may be pointed at is what THIS PERSON can push to.
      const theirs = await client.repositoriesOf(userToken, held.id);
      const writable = theirs.repositories.filter((repository) => repository.writable).map((r) => r.fullName);
      if (writable.length === 0) {
        log.warn('the person who came back can push to nothing the installation covers', { installation: held.id });
        finish(res, 'nothing-to-write');
        return;
      }
      await settings.record(
        {
          githubInstallationId: held.id,
          githubRepositoriesPermitted: repositoriesAsSetting(writable),
          ...(held.account ? { githubInstallationAccount: held.account } : {}),
        },
        req.userId ?? null,
      );
      // A token in hand was another installation's.
      connection.forget();
      log.info(`GitHub App installed on "${held.account}"`, { installation: held.id, account: held.account });
      finish(res, 'connected');
    } catch (err) {
      log.error('the installation could not be confirmed:', { detail: err instanceof Error ? err.message : String(err) });
      finish(res, outcomeOf(err));
    }
  });

  router.get('/setup/github-app/repositories', requireAdmin, async (_req, res) => {
    if (!connection.credentials() || !connection.installationId()) {
      res.status(409).json({ error: 'Connect GitHub first.' });
      return;
    }
    try {
      res.json(await connection.repositories());
    } catch (err) {
      log.error('the repositories could not be listed:', { detail: err instanceof Error ? err.message : String(err) });
      const unreachable = err instanceof GitHubAppError && err.kind === 'unreachable';
      res.status(502).json({
        error: unreachable
          ? 'GitHub could not be reached. Try again shortly.'
          : 'GitHub would not list the repositories. The app may have been uninstalled: connect it again.',
      });
    }
  });

  return router;
}
