import express from 'express';
import type { BevelOAuthProvider } from './bevel-oauth-provider.js';
import { verifyAuthRequest, type McpAuthRequestState } from './oauth-state.js';
import '../../auth/auth.middleware.js'; // Express Request augmentation (req.userId / req.userEmail)

export interface OAuthConsentRoutesDeps {
  provider: BevelOAuthProvider;
  /** Same HMAC secret the provider signs the authorize state with. */
  stateSecret: string;
  /**
   * The Claude marketplace bridge, when the deployment has one: a state it
   * signed (`gh`) is a person connecting their claude.ai account, and the
   * code that flow needs is the bridge's, not the SDK's.
   */
  bridge?: {
    isBridgeRequest(st: McpAuthRequestState): boolean;
    clientName: string;
    completeConsent(userId: string, st: McpAuthRequestState): Promise<{ redirectTo: string }>;
  };
}

/**
 * The authenticated tail of the MCP OAuth flow. `/authorize` (SDK-owned)
 * validated the client's request, packed it into a signed state, and sent the
 * browser to the SPA's `/connect?oauth=<state>` page; these routes are what
 * that page calls. Mounted behind the regular JWT middleware — a browser
 * landing from the redirect chain authenticates via the HttpOnly bevel_token
 * cookie fallback, so THIS is where a Bevel user attaches to the flow.
 */
/** A Claude-link state reaching a deployment whose routes were built without the bridge. */
const NO_BRIDGE = 'Connecting a Claude account is not enabled on this deployment.';

export function createOAuthConsentRoutes(deps: OAuthConsentRoutesDeps): express.Router {
  const router = express.Router();

  // Describe the pending authorization so /connect can say who's asking.
  router.get('/mcp/oauth/request', async (req, res) => {
    if (!req.userId) return void res.status(401).json({ error: 'Not authenticated' });
    const raw = typeof req.query.state === 'string' ? req.query.state : '';
    const st = raw ? verifyAuthRequest(deps.stateSecret, raw) : null;
    if (!st) return void res.status(400).json({ error: 'Invalid or expired authorization request. Restart the connection from your agent.' });
    if (st.gh) {
      if (!deps.bridge) return void res.status(400).json({ error: NO_BRIDGE });
      res.json({ clientName: deps.bridge.clientName, scope: null, resource: null });
      return;
    }
    const client = await deps.provider.clientsStore.getClient(st.c);
    res.json({
      clientName: client?.client_name ?? null,
      scope: st.sc ?? null,
      resource: st.rs ?? null,
    });
  });

  // Finish: the user is done configuring tools on /connect — issue the
  // one-time code bound to them and hand the SPA the client redirect.
  router.post('/mcp/oauth/complete', async (req, res) => {
    const userId = req.userId;
    if (!userId) return void res.status(401).json({ error: 'Not authenticated' });
    const raw = typeof (req.body ?? {}).state === 'string' ? req.body.state : '';
    const st = raw ? verifyAuthRequest(deps.stateSecret, raw) : null;
    if (!st) return void res.status(400).json({ error: 'Invalid or expired authorization request. Restart the connection from your agent.' });
    if (st.gh && !deps.bridge) return void res.status(400).json({ error: NO_BRIDGE });
    try {
      const { redirectTo } = st.gh && deps.bridge
        ? await deps.bridge.completeConsent(userId, st)
        : await deps.provider.issueAuthCode(userId, st);
      res.json({ redirectTo });
    } catch (err) {
      // Message only — the raw error object can carry sensitive context
      // (redirect URIs with tokens, DB details) that must not hit stdout.
      console.error(
        `[mcp-oauth] complete failed for client=${st.c}:`,
        err instanceof Error ? err.message : String(err),
      );
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
