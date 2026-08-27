import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import {
  InvalidSecretError,
  SecretNotFoundError,
  SecretOAuthError,
  scopesCovered,
  missingScopes,
  type ISecretsVaultService,
} from './secrets-vault.contract.js';
import type { IToolManualService, ToolManualSummary, ToolVariable } from '../tool-manuals/tool-manuals.contract.js';
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId / req.userEmail)

export interface SecretsVaultRoutesDeps {
  secretsVault: ISecretsVaultService;
  /** Source of `.tool` manuals + their declared variable scopes (default-branch catalog). */
  toolManualService: IToolManualService;
  /** Gates who may set a tool's ADMIN (shared) secrets — writers of the `.tool` file. */
  accessControl: IAccessControl;
  /** HMAC secret for signing the OAuth `state` (reuse the connector state secret). */
  stateSecret: string;
  /** Public base URL of THIS backend — builds the OAuth redirect URI. */
  publicBackendUrl: string;
  /** Public base URL of the SPA — where the OAuth callback lands the browser. */
  publicFrontendUrl: string;
}

function redirectUriFor(publicBackendUrl: string): string {
  return `${publicBackendUrl}/api/secrets/oauth/callback`;
}

/**
 * Is this a SAME-ORIGIN path we're willing to bounce the browser back to after a
 * sign-in? The callback builds `${publicFrontendUrl}${dest}#…`, so anything that
 * survives this check gets concatenated onto our own origin — which makes every
 * rule here an open-redirect rule, not a formatting preference:
 *  - must start with a single `/` — `//evil.com` is a protocol-relative URL and
 *    `https://evil.com` an absolute one; both would leave our origin entirely.
 *  - no `\` — WHATWG folds a backslash to a slash for http(s), so `/\evil.com`
 *    is `//evil.com` by another spelling.
 *  - no `#` — the callback appends its own fragment; a caller-supplied one would
 *    swallow the `#authorized=…`/`#error=…` the landing page reads.
 *  - no CR/LF — never let a caller-controlled string reach a `Location` header
 *    with a line break in it (response splitting).
 *  - ≤512 chars — a signed `state` rides in the provider's authorize URL, and
 *    some providers cap its length; this keeps the round-trip inside every
 *    budget without needing to know each provider's limit.
 * Exported for the route tests: this predicate IS the security boundary, so it
 * is pinned by a unit table rather than only exercised end-to-end.
 */
export function isSafeReturnPath(returnTo: unknown): returnTo is string {
  return (
    typeof returnTo === 'string' &&
    returnTo.length <= 512 &&
    returnTo.startsWith('/') &&
    !returnTo.startsWith('//') &&
    !returnTo.includes('\\') &&
    !returnTo.includes('#') &&
    !/[\r\n]/.test(returnTo)
  );
}

/**
 * Authenticated Secrets Vault CRUD + OAuth start. Every route is scoped to
 * `req.userId` — secrets are private per user. Mounted behind the JWT middleware.
 */
export function createSecretsVaultRoutes(deps: SecretsVaultRoutesDeps): express.Router {
  const { secretsVault, toolManualService, accessControl } = deps;
  const router = express.Router();
  // A FUNCTION, not a constant. Routers are constructed at boot, and on a
  // deployment configured through the setup screen the branch model does not
  // exist yet at that moment — `DEFAULT_BRANCH` is still ''. The live binding
  // updates when setup applies the model, but only reads INSIDE a function
  // body see it; a construction-time capture would keep handing an empty
  // workspace id to the access resolver until the next restart ("Invalid
  // workspace ID" on every /secrets/tools call).
  const defaultWs = () => workspaceIdForBranch(DEFAULT_BRANCH);

  // The vault key = the exact key UTCP looks the var up under (doubles underscores
  // in the manual namespace), so storage and resolution agree for snake_case ids.
  const varKey = (manualName: string, varName: string) => utcpNamespacedKey(manualName, varName);

  /** Find an accessible (readable) manual by slug + its DECLARED variable, or null. */
  async function findManualVar(
    email: string,
    slug: string,
    varName: string,
  ): Promise<{ manual: ToolManualSummary; variable: ToolVariable } | null> {
    const manual = (await toolManualService.listAccessible(email)).find((m) => m.slug === slug);
    if (!manual) return null;
    const variable = (manual.variables ?? []).find((v) => v.name === varName);
    return variable ? { manual, variable } : null;
  }

  router.get('/secrets', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      res.json({ secrets: await secretsVault.list(userId) });
    } catch (err) {
      console.error('[secrets] list failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.post('/secrets/static', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const body = req.body ?? {};
      const secret = await secretsVault.putStatic({
        userId,
        key: body.key,
        value: body.value,
        label: body.label,
      });
      res.status(201).json({ secret });
    } catch (err) {
      mapError(err, res, 'create static');
    }
  });

  router.post('/secrets/oauth', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const body = req.body ?? {};
      const secret = await secretsVault.createOAuth({
        userId,
        key: body.key,
        label: body.label,
        provider: body.provider,
      });
      res.status(201).json({ secret });
    } catch (err) {
      mapError(err, res, 'create oauth');
    }
  });

  router.delete('/secrets/:id', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      await secretsVault.remove(userId, req.params.id);
      res.status(204).end();
    } catch (err) {
      mapError(err, res, 'delete');
    }
  });

  // Return the provider consent URL as JSON (not a 302): the SPA fetches this
  // with its bearer token, then navigates the browser to the URL.
  router.get('/secrets/:id/oauth/start', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const secret = await secretsVault.getById(userId, req.params.id);
      if (!secret) return void res.status(404).json({ error: 'Secret not found' });
      if (secret.kind !== 'oauth') return void res.status(400).json({ error: 'Secret has no OAuth flow' });
      const state = signState(deps.stateSecret, {
        u: userId,
        i: req.params.id,
        n: randomBytes(8).toString('hex'),
      });
      const url = await secretsVault.beginOAuth(
        userId,
        req.params.id,
        redirectUriFor(deps.publicBackendUrl),
        state,
      );
      res.json({ url });
    } catch (err) {
      mapError(err, res, 'oauth start');
    }
  });

  // ---- per-tool secrets (two-tier: admin/shared + per-user) ------------------

  // The caller's accessible `.tool` manuals, each with its declared variables,
  // per-variable config status, and whether the caller may set ADMIN secrets.
  // `?path=` narrows to a single tool (used by the `.tool` editor sidebar).
  router.get('/secrets/tools', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const pathFilter = typeof req.query.path === 'string' ? req.query.path : null;
      let manuals = await toolManualService.listAccessible(email);
      if (pathFilter) manuals = manuals.filter((m) => m.path === pathFilter);

      const allKeys = manuals.flatMap((m) => (m.variables ?? []).map((v) => varKey(m.name, v.name)));
      const status = await secretsVault.statusFor(userId, allKeys);
      const statusByKey = new Map(status.map((s) => [s.key, s]));

      const tools = await Promise.all(
        manuals.map(async (m) => ({
          slug: m.slug,
          name: m.name,
          path: m.path,
          type: m.type,
          setup: m.setup ?? null,
          canWrite: await accessControl.canWrite(defaultWs(), email, m.path),
          variables: (m.variables ?? []).map((v) => {
            const key = varKey(m.name, v.name);
            const st = statusByKey.get(key);
            const isOAuth = v.oauth != null;
            const authorized = isOAuth ? (st?.userAuthorized ?? false) : undefined;
            // For an OAuth var: which declared permissions the token doesn't cover,
            // so the panel can say WHAT it works for and what it doesn't. Only
            // meaningful once authorized (an unauthorized var has no token at all).
            const missing = isOAuth && authorized ? missingScopes(v.oauth?.scopes, st?.grantedScopes) : [];
            return {
              name: v.name,
              scope: v.scope,
              label: v.label ?? null,
              key,
              adminConfigured: st?.adminConfigured ?? false,
              userConfigured: st?.userConfigured ?? false,
              oauth: isOAuth,
              authorized,
              needsReauth: isOAuth && authorized === true && missing.length > 0,
              missingScopes: missing,
            };
          }),
        })),
      );
      res.json({ tools });
    } catch (err) {
      console.error('[secrets] list tools failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // The aggregated "connect your tools" view for a single user: every accessible
  // tool with ONLY its per-user (`user`-scoped) variables and whether the caller
  // has set each, plus the caller's OAuth secrets and their authorized state. This
  // is the surface an external-agent user lands on from the needs-authorization
  // link — it shows exactly what THEY must provide, never the admin/shared items.
  router.get('/connect/pending', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const manuals = await toolManualService.listAccessible(email);
      const allKeys = manuals.flatMap((m) =>
        (m.variables ?? []).filter((v) => v.scope === 'user').map((v) => varKey(m.name, v.name)),
      );
      const status = await secretsVault.statusFor(userId, allKeys);
      const statusByKey = new Map(status.map((s) => [s.key, s]));

      const tools = manuals
        .map((m) => ({
          slug: m.slug,
          name: m.name,
          path: m.path,
          type: m.type,
          // Plain (non-OAuth) per-user vars render as key inputs under "Keys".
          variables: (m.variables ?? [])
            .filter((v) => v.scope === 'user' && !v.oauth)
            .map((v) => {
              const key = varKey(m.name, v.name);
              return {
                name: v.name,
                label: v.label ?? null,
                key,
                configured: statusByKey.get(key)?.userConfigured ?? false,
              };
            }),
        }))
        // Only surface tools that actually have per-user items to configure.
        .filter((t) => t.variables.length > 0);

      // OAuth-backed per-user vars render as Authorize buttons under "Sign-ins".
      // Keyed by slug+var (the caller's row may not exist yet), with authorized
      // state from the oauth-aware status.
      const toolOAuth = manuals.flatMap((m) =>
        (m.variables ?? [])
          .filter((v) => v.scope === 'user' && v.oauth)
          .map((v) => {
            const st = statusByKey.get(varKey(m.name, v.name));
            const authorized = st?.userAuthorized ?? false;
            // Signed in, but the token's granted scopes no longer cover what the
            // tool declares → surface as needing re-authorization, not as connected.
            const needsReauth =
              authorized && !scopesCovered(v.oauth?.scopes, st?.grantedScopes);
            return {
              slug: m.slug,
              varName: v.name,
              toolName: m.name,
              key: varKey(m.name, v.name),
              label: v.label ?? null,
              authorized,
              needsReauth,
            };
          }),
      );

      // Standalone sign-ins = oauth secrets the user registered directly on the
      // Secrets page. A TOOL sign-in provisions a per-user row in the same
      // table (keyed `<manual>_<VAR>`), so exclude every tool-var key here or
      // an authorized tool sign-in would render twice — once as a toolOAuth
      // row and again as a "standalone" one.
      const toolOAuthKeys = new Set(toolOAuth.map((o) => o.key));
      const secrets = await secretsVault.list(userId);
      const oauth = secrets
        .filter((s) => s.kind === 'oauth' && !toolOAuthKeys.has(s.key))
        .map((s) => ({ id: s.id, key: s.key, label: s.label, authorized: s.authorized ?? false }));

      res.json({ tools, oauth, toolOAuth });
    } catch (err) {
      console.error('[secrets] connect/pending failed:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Set/replace a tool's ADMIN (shared) secret — requires WRITE on the `.tool` file.
  router.put('/secrets/tools/:slug/vars/:var/admin', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      if (found.variable.scope !== 'admin') {
        return void res.status(422).json({ error: 'This variable is set by each user, not the tool owner.' });
      }
      if (!(await accessControl.canWrite(defaultWs(), email, found.manual.path))) {
        return void res.status(403).json({ error: 'You need write access to this tool to set its shared secrets.' });
      }
      const body = req.body ?? {};
      const secret = await secretsVault.putSharedStatic({
        key: varKey(found.manual.name, found.variable.name),
        value: body.value,
        label: body.label,
      });
      res.status(201).json({ secret });
    } catch (err) {
      mapError(err, res, 'set admin var');
    }
  });

  // Set/replace the CALLER's per-user secret for a user-scope variable.
  router.put('/secrets/tools/:slug/vars/:var/user', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      if (found.variable.scope !== 'user') {
        return void res.status(422).json({ error: 'This variable is set by the tool owner, not per user.' });
      }
      const body = req.body ?? {};
      const secret = await secretsVault.putStatic({
        userId,
        key: varKey(found.manual.name, found.variable.name),
        value: body.value,
        label: body.label,
      });
      res.status(201).json({ secret });
    } catch (err) {
      mapError(err, res, 'set user var');
    }
  });

  // Set the confidential client secret for a tool's OAuth-backed variable — the
  // ONLY place the secret is provided. Requires WRITE on the `.tool`. The provider
  // config comes from the variable's own `oauth` declaration (stored WITH the
  // secret so a later `.tool` edit can't redirect it).
  router.put('/secrets/tools/:slug/vars/:var/oauth/admin', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      if (!found.variable.oauth) {
        return void res.status(422).json({ error: 'This variable is not an OAuth sign-in.' });
      }
      if (!(await accessControl.canWrite(defaultWs(), email, found.manual.path))) {
        return void res.status(403).json({ error: 'You need write access to this tool to set its client secret.' });
      }
      const { authorizationUrl, tokenUrl } = found.variable.oauth;
      // A declaration that names only its client id is completed from the
      // server's OAuth metadata at scan time. When that didn't happen, pinning
      // the secret to a provider with no endpoints would leave every sign-in
      // failing later with a far less specific error than the catalog's own.
      if (!authorizationUrl || !tokenUrl) {
        const why = found.manual.setup?.reason;
        return void res.status(422).json({
          error: why
            ? `The sign-in endpoints for this server aren't known yet: ${why}.`
            : "The sign-in endpoints for this server aren't known yet — declare `authorizationUrl` and `tokenUrl` on the sign-in variable.",
        });
      }
      const clientSecret = (req.body ?? {}).clientSecret;
      await secretsVault.putSharedOAuthClientSecret({
        key: varKey(found.manual.name, found.variable.name),
        clientSecret,
        provider: {
          authorizationUrl,
          tokenUrl,
          clientId: found.variable.oauth.clientId,
          scopes: found.variable.oauth.scopes,
          // Static authorize params (e.g. Google's `access_type=offline`) so the
          // provider returns a refresh token — stored with the secret so a later
          // `.tool` edit can't redirect the flow.
          authParams: found.variable.oauth.authParams,
          // PKCE unless the declaration opted out; the resource indicator when
          // the server (or the declaration) names one. Both pinned here for the
          // same reason as the rest: the flow runs from the stored row.
          pkce: found.variable.oauth.pkce !== false,
          resource: found.variable.oauth.resource,
        },
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      mapError(err, res, 'set oauth client secret');
    }
  });

  // Start sign-in for a tool's OAuth-backed variable. Provisions the caller's row
  // from the owner-set secret and returns the provider consent URL; the callback
  // bounces back to wherever the flow started (via `r` in the signed state) — an
  // optional `{ returnTo }` body when the caller asks for a specific page, else
  // /connect, which is where every caller came from before `returnTo` existed.
  router.post('/secrets/tools/:slug/vars/:var/oauth/start', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      if (!found.variable.oauth) {
        return void res.status(422).json({ error: 'This variable is not an OAuth sign-in.' });
      }
      const key = varKey(found.manual.name, found.variable.name);
      // Provision the caller's oauth row (from the owner-set secret) FIRST — its id
      // is what the un-authed callback keys on. Pass an empty state placeholder; we
      // sign the real state below with the returned id and swap it into the URL, so
      // the callback resolves it byte-for-byte like the standalone flow.
      const { id, url } = await secretsVault.beginToolOAuthByKey({
        userId,
        key,
        redirectUri: redirectUriFor(deps.publicBackendUrl),
        state: '',
        // Request the permissions the tool file declares RIGHT NOW (not the frozen
        // copy on the owner-set row), so adding a scope to the `.tool` takes effect
        // on the next sign-in. The secret/clientId/addresses stay owner-pinned.
        scopes: found.variable.oauth.scopes,
      });
      // The return path is signed INTO the state (HMAC-SHA256) rather than kept
      // in a query param or a cookie: the callback arrives un-authenticated from
      // the provider, so the state is the only thing it can trust. An absent or
      // unsafe `returnTo` falls back to the legacy `'connect'` marker, which
      // keeps a body-less start byte-identical to what it produced before.
      const returnTo: unknown = (req.body ?? {}).returnTo;
      const state = signState(deps.stateSecret, {
        u: userId,
        i: id,
        n: randomBytes(8).toString('hex'),
        r: isSafeReturnPath(returnTo) ? returnTo : 'connect',
      });
      const consentUrl = new URL(url);
      consentUrl.searchParams.set('state', state);
      res.json({ url: consentUrl.toString() });
    } catch (err) {
      mapError(err, res, 'tool oauth start');
    }
  });

  router.delete('/secrets/tools/:slug/vars/:var/admin', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      if (!(await accessControl.canWrite(defaultWs(), email, found.manual.path))) {
        return void res.status(403).json({ error: 'You need write access to this tool to remove its shared secrets.' });
      }
      await secretsVault.removeShared(varKey(found.manual.name, found.variable.name));
      res.status(204).end();
    } catch (err) {
      mapError(err, res, 'delete admin var');
    }
  });

  router.delete('/secrets/tools/:slug/vars/:var/user', async (req, res) => {
    const userId = req.userId;
    const email = req.userEmail;
    if (!userId || !email) return void res.status(401).json({ error: 'Not authenticated' });
    try {
      const found = await findManualVar(email, req.params.slug, req.params.var);
      if (!found) return void res.status(404).json({ error: 'Tool or variable not found' });
      await secretsVault.removeUserByKey(userId, varKey(found.manual.name, found.variable.name));
      res.status(204).end();
    } catch (err) {
      mapError(err, res, 'delete user var');
    }
  });

  return router;
}

/**
 * The un-authenticated OAuth callback. Mounted BEFORE the JWT middleware: the
 * provider redirects the browser here with no Authorization header, so the
 * caller's identity rides in the signed `state`.
 */
export function createSecretsVaultPublicRoutes(deps: SecretsVaultRoutesDeps): express.Router {
  const { secretsVault } = deps;
  const router = express.Router();

  router.get('/secrets/oauth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const stateRaw = typeof req.query.state === 'string' ? req.query.state : '';
    // The landing page depends on where the flow started (the `r` field in the
    // signed state): an explicit same-origin path returns there, the legacy
    // `'connect'` marker to /connect, the standalone Secrets page to /secrets.
    // Pre-verification errors can't know `r`, so they fall back to /secrets.
    const back = (frag: string, dest = '/secrets') =>
      res.redirect(`${deps.publicFrontendUrl}${dest}#${frag}`);
    if (!code || !stateRaw) return void back(`error=${encodeURIComponent('Invalid OAuth callback.')}`);

    const state = verifyState(deps.stateSecret, stateRaw);
    if (!state) return void back(`error=${encodeURIComponent('OAuth state mismatch.')}`);
    // Re-validated HERE even though `r` was validated on the way in and is
    // HMAC-signed: this is the line that concatenates a stored string onto our
    // public origin and hands it to the browser as a `Location`. Defense in
    // depth — the check costs nothing, and it means an open redirect would need
    // BOTH the signing key and a validation bug, not either one.
    const dest = isSafeReturnPath(state.r) ? state.r : state.r === 'connect' ? '/connect' : '/secrets';

    try {
      await secretsVault.completeOAuth(state.u, state.i, code, redirectUriFor(deps.publicBackendUrl));
      back(`authorized=${encodeURIComponent(state.i)}`, dest);
    } catch (err) {
      console.error('[secrets] oauth callback failed:', err instanceof Error ? err.message : String(err));
      back(`error=${encodeURIComponent('Authorization failed. Check the provider configuration and try again.')}`, dest);
    }
  });

  return router;
}

function mapError(err: unknown, res: express.Response, op: string): void {
  if (err instanceof InvalidSecretError) return void res.status(422).json({ error: err.message });
  if (err instanceof SecretNotFoundError) return void res.status(404).json({ error: err.message });
  if (err instanceof SecretOAuthError) return void res.status(409).json({ error: err.message });
  console.error(`[secrets] ${op} failed:`, err);
  res.status(500).json({ error: 'Internal error' });
}

// ---- signed-state helpers (CSRF + identity for the un-authed callback) -------

interface OAuthState {
  u: string; // user id
  i: string; // secret id
  n: string; // nonce
  iat: number; // issued-at (epoch ms)
  /**
   * Return path hint: a same-origin path (`isSafeReturnPath`) → land there; the
   * legacy marker `'connect'` → /connect; anything else (incl. absent) →
   * /secrets. Signed, so the callback can trust it — but re-validated anyway.
   */
  r?: string;
}

const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
const OAUTH_STATE_SKEW_MS = 60_000;

function signState(secret: string, state: Omit<OAuthState, 'iat'>): string {
  const full: OAuthState = { ...state, iat: Date.now() };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(secret: string, token: string): OAuthState | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as OAuthState;
    if (typeof parsed.iat !== 'number' || !parsed.u || !parsed.i) return null;
    const age = Date.now() - parsed.iat;
    if (age > OAUTH_STATE_MAX_AGE_MS || age < -OAUTH_STATE_SKEW_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}
