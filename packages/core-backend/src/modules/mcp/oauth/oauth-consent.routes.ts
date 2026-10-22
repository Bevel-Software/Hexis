import express from 'express';
import { logger } from '../../../shared/logging.js';

const log = logger('mcp-oauth');
import type { BevelOAuthProvider } from './bevel-oauth-provider.js';
import { verifyAuthRequest, type McpAuthRequestState } from './oauth-state.js';
import type { IAgentScopeResolver } from '../../agent-scope/index.js';
import '../../auth/index.js'; // Express Request augmentation (req.userId / req.userEmail)

export interface OAuthConsentRoutesDeps {
  provider: BevelOAuthProvider;
  /** Same HMAC secret the provider signs the authorize state with. */
  stateSecret: string;
  /**
   * The GitHub facade, when the deployment has one: a state it signed
   * (`gh`) is a person connecting an account on a product that speaks to
   * this deployment as a GitHub Enterprise host (claude.ai), and the code
   * that flow needs is the facade's, not the SDK's.
   */
  facade?: {
    isFacadeRequest(st: McpAuthRequestState): boolean;
    clientNameFor(st: McpAuthRequestState): string;
    completeConsent(userId: string, st: McpAuthRequestState): Promise<{ redirectTo: string }>;
  };
  /**
   * The "Connect as" choices: the `.agent` files the person may connect an
   * MCP client as, offered below Everything. Absent, the consent offers
   * Everything alone and Finish refuses any other choice.
   */
  agents?: Pick<IAgentScopeResolver, 'listChoices' | 'choosable'>;
}

/** The refusal of a choice that is not one of the person's — one answer for missing and unreadable. */
export const NOT_AN_AGENT_CHOICE = 'That agent is not one you can connect as. Choose Everything or one of the agents listed.';

/**
 * The authenticated tail of the MCP OAuth flow. `/authorize` (SDK-owned)
 * validated the client's request, packed it into a signed state, and sent the
 * browser to the SPA's `/connect?oauth=<state>` page; these routes are what
 * that page calls. Mounted behind the regular JWT middleware — a browser
 * landing from the redirect chain authenticates via the HttpOnly bevel_token
 * cookie fallback, so THIS is where a Bevel user attaches to the flow.
 */
/** A facade state reaching a deployment whose routes were built without the facade. */
const NO_FACADE = 'Connecting an external account this way is not enabled on this deployment.';

export function createOAuthConsentRoutes(deps: OAuthConsentRoutesDeps): express.Router {
  const router = express.Router();

  // Describe the pending authorization so /connect can say who's asking.
  router.get('/mcp/oauth/request', async (req, res) => {
    if (!req.userId) return void res.status(401).json({ error: 'Not authenticated' });
    const raw = typeof req.query.state === 'string' ? req.query.state : '';
    const st = raw ? verifyAuthRequest(deps.stateSecret, raw) : null;
    if (!st) return void res.status(400).json({ error: 'Invalid or expired authorization request. Restart the connection from your agent.' });
    if (st.gh) {
      if (!deps.facade) return void res.status(400).json({ error: NO_FACADE });
      res.json({ clientName: deps.facade.clientNameFor(st), scope: null, resource: null });
      return;
    }
    const client = await deps.provider.clientsStore.getClient(st.c);
    // Everything is not in the list: it is the choice every consent has, and
    // the one the page selects. A failure to read the agents costs the choice
    // of an agent, never the consent itself — but it is SAID
    // (`agentsUnavailable`), so the page does not pass an empty list off as
    // "you have no agents" and approve Everything unasked.
    let agentsUnavailable = false;
    const agents = deps.agents && req.userEmail
      ? await deps.agents.listChoices(req.userEmail).catch((err: unknown) => {
          log.warn('listing the agents to connect as failed:', { detail: err instanceof Error ? err.message : String(err) });
          agentsUnavailable = true;
          return [];
        })
      : [];
    res.json({
      clientName: client?.client_name ?? null,
      scope: st.sc ?? null,
      resource: st.rs ?? null,
      agents,
      ...(agentsUnavailable ? { agentsUnavailable: true } : {}),
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
    if (st.gh && !deps.facade) return void res.status(400).json({ error: NO_FACADE });
    // "Connect as": absent, null or empty is Everything. Anything else must be
    // an agent the person may choose right now — checked here, at the only
    // place a choice is made, so the token exchange records it as given.
    const asked: unknown = (req.body ?? {}).agentPath;
    if (asked !== undefined && asked !== null && typeof asked !== 'string') {
      return void res.status(400).json({ error: NOT_AN_AGENT_CHOICE });
    }
    const choosing = typeof asked === 'string' && asked.trim() !== '';
    // An account linked through the GitHub facade has no agent connection to
    // record a choice on.
    if (choosing && (st.gh || !deps.agents || !req.userEmail)) {
      return void res.status(400).json({ error: NOT_AN_AGENT_CHOICE });
    }
    try {
      const agentPath = choosing && deps.agents && req.userEmail ? await deps.agents.choosable(req.userEmail, asked as string) : null;
      if (choosing && agentPath === null) return void res.status(400).json({ error: NOT_AN_AGENT_CHOICE });
      const { redirectTo } = st.gh && deps.facade
        ? await deps.facade.completeConsent(userId, st)
        : await deps.provider.issueAuthCode(userId, st, agentPath);
      res.json({ redirectTo });
    } catch (err) {
      // Message only — the raw error object can carry sensitive context
      // (redirect URIs with tokens, DB details) that must not hit stdout.
      log.error(`complete failed for client=${st.c}:`, { detail: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}
