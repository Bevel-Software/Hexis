import type { RequestHandler } from 'express';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';

/**
 * Token requests one client address may make per window on `POST /token`.
 * Bevel for Copilot reaches every deployment through one relay, so every
 * Copilot user's sign-in and hourly refresh arrives from that relay's single
 * address; the SDK's default of 50 per 15 minutes refused a deployment with a
 * few dozen such users. 1,000 carries about 4,000 active users while one
 * attacking address is still slowed down.
 */
export const MCP_TOKEN_REQUESTS_PER_WINDOW = 1000;

/** The window the SDK's token limiter counts in (its own default). */
const MCP_TOKEN_RATE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The MCP OAuth 2.1 authorization server: /authorize, /token, /register,
 * /revoke and the /.well-known metadata documents. Only the token limit is
 * set here; the SDK keeps its window, headers and `too_many_requests` body,
 * and every other endpoint keeps the SDK's default limit. The client address
 * is the app's `req.ip`, so it follows the app's `trust proxy` setting.
 */
export function createMcpAuthRouter(opts: {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  resourceServerUrl: URL;
}): RequestHandler {
  return mcpAuthRouter({
    provider: opts.provider,
    issuerUrl: opts.issuerUrl,
    resourceServerUrl: opts.resourceServerUrl,
    scopesSupported: ['mcp'],
    resourceName: 'Bevel MCP',
    tokenOptions: {
      rateLimit: { windowMs: MCP_TOKEN_RATE_WINDOW_MS, max: MCP_TOKEN_REQUESTS_PER_WINDOW },
    },
  });
}
