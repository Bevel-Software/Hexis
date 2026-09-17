import type { Server as HttpServer } from 'node:http';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger, LogFields } from '../../../shared/logger.contract.js';
import { createMcpAuthMiddleware } from '../../mcp/mcp-auth.middleware.js';
import type { BevelOAuthProvider } from '../../mcp/oauth/bevel-oauth-provider.js';
import { createAgentInstructionsRoutes } from '../../agent-instructions/agent-instructions.routes.js';
import type { AuthService } from '../../auth/auth.service.js';
import { InternalTokenService } from '../internal-token.service.js';
import { createManualAuthMiddleware, createToolAuthMiddleware } from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';

/**
 * A bearer shaped like a connection key that does not verify is answered with
 * a plain sentence on EVERY key-authenticated endpoint the local server
 * (hexis-mcp) calls — never with the `resource_metadata` challenge that
 * invites an MCP client into a browser sign-in. A missing bearer and a bad
 * OAuth token keep today's challenges, so sign-in still starts for those.
 *
 * The middlewares are the real ones; the handlers behind them (other than
 * the agent instructions route) are stand-ins mounted at the paths the local
 * server requests, with the same gate `create-core-server.ts` puts on each.
 */
const BAD_KEY = 'bevel_revokedKeyThatMustNeverBeEchoed';
const RESOURCE_METADATA_URL = 'https://hexis.example/.well-known/oauth-protected-resource/api/mcp';
const DISCOVERY_CHALLENGE = `Bearer realm="bevel-mcp", resource_metadata="${RESOURCE_METADATA_URL}"`;
const KEY_CHALLENGE = 'Bearer error="invalid_token", error_description="Invalid or revoked connection key"';
const KEY_BODY = { error: 'Invalid or revoked connection key. Mint a new one in External agent access.' };

const externalApiKeys = {
  looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
  verifyAndLoadToken: async () => null,
} as unknown as IExternalApiKeyService;

const oauthProvider = {
  looksLikeAccessToken: (t: string) => t.startsWith('bevel-mcp_'),
  verifyAccessToken: async () => {
    throw new InvalidTokenError('expired');
  },
} as unknown as BevelOAuthProvider;

const authService = {
  verifyToken: () => {
    throw new Error('bad jwt');
  },
} as unknown as AuthService;

/** Every line logged during a test, fields serialized, so a key anywhere in one is found. */
let logged: string[] = [];
let previousLogger: ILogger | undefined;
function capturingLogger(bindings: LogFields = {}): ILogger {
  const line = (level: string) => (message: string, fields?: LogFields) => {
    logged.push(`${level} ${message} ${JSON.stringify({ ...bindings, ...fields }, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v))}`);
  };
  return {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
    child: (more) => capturingLogger({ ...bindings, ...more }),
  };
}

let server: HttpServer | undefined;
beforeEach(() => {
  logged = [];
  previousLogger = setLogger(capturingLogger());
});
afterEach(async () => {
  if (previousLogger) setLogger(previousLogger);
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start(): Promise<string> {
  const internalTokens = new InternalTokenService({ secret: 'test-secret-32-bytes-long-enough!!' });
  const mcpAuth = createMcpAuthMiddleware(authService, externalApiKeys, oauthProvider, RESOURCE_METADATA_URL, internalTokens);
  const toolAuth = createToolAuthMiddleware(externalApiKeys, internalTokens);
  const manualAuth = createManualAuthMiddleware(externalApiKeys, internalTokens, authService);
  const ok: RequestHandler = (_req, res) => {
    res.json({ ok: true });
  };
  const app = express();
  app.post('/api/mcp', mcpAuth, ok);
  app.use('/api', createAgentInstructionsRoutes(manualAuth, async () => 'preamble'));
  app.get('/api/agent/all-tools', manualAuth, ok);
  app.post('/api/agent/tools/list_local_tools', toolAuth, ok);
  app.post('/api/agent/local-tools/:slug/variables', manualAuth, ok);
  app.get('/api/agent/plugins/:folder/archive', manualAuth, ok);
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** The key-authenticated requests hexis-mcp makes, as it makes them. */
const KEY_ENDPOINTS: { name: string; method: 'GET' | 'POST'; path: string }[] = [
  { name: 'MCP', method: 'POST', path: '/api/mcp' },
  { name: 'agent instructions', method: 'GET', path: '/api/agent/instructions' },
  { name: 'tool manual list', method: 'GET', path: '/api/agent/all-tools?remote=false' },
  { name: 'local-only tool list', method: 'POST', path: '/api/agent/tools/list_local_tools' },
  { name: 'local tool variables', method: 'POST', path: '/api/agent/local-tools/notion/variables' },
  { name: 'plugin archive', method: 'GET', path: '/api/agent/plugins/GTM/archive' },
];

const call = (base: string, method: string, path: string, bearer?: string) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? '{}' : undefined,
  });

describe('an invalid connection key is rejected plainly', () => {
  for (const endpoint of KEY_ENDPOINTS) {
    it(`${endpoint.name}: 401, invalid_token challenge without resource_metadata, the sentence, and no key anywhere`, async () => {
      const base = await start();
      const res = await call(base, endpoint.method, endpoint.path, BAD_KEY);
      const text = await res.text();

      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(KEY_CHALLENGE);
      expect(JSON.parse(text)).toEqual(KEY_BODY);

      const everyHeader = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      expect(everyHeader).not.toContain('resource_metadata');
      expect(everyHeader).not.toContain(BAD_KEY);
      expect(text).not.toContain(BAD_KEY);
      expect(logged.join('\n')).not.toContain(BAD_KEY);
    });
  }
});

describe('the MCP endpoint keeps inviting sign-in where sign-in is the answer', () => {
  it('no Authorization header: the resource_metadata discovery challenge, unchanged', async () => {
    const base = await start();
    const res = await call(base, 'POST', '/api/mcp');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(DISCOVERY_CHALLENGE);
    expect(await res.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('an invalid or expired OAuth access token: the resource_metadata discovery challenge, unchanged', async () => {
    const base = await start();
    const res = await call(base, 'POST', '/api/mcp', 'bevel-mcp_expiredAccessToken');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(DISCOVERY_CHALLENGE);
    expect(await res.json()).toEqual({ error: 'Invalid, expired, or revoked access token' });
    expect(logged.join('\n')).not.toContain('bevel-mcp_expiredAccessToken');
  });
});

describe('the REST agent surface keeps its challenge for everything but a key', () => {
  it('no Authorization header: the bevel-tools realm challenge, unchanged', async () => {
    const base = await start();
    for (const endpoint of KEY_ENDPOINTS.filter((e) => e.name !== 'MCP')) {
      const res = await call(base, endpoint.method, endpoint.path);
      expect(res.status, endpoint.name).toBe(401);
      expect(res.headers.get('www-authenticate'), endpoint.name).toBe('Bearer realm="bevel-tools"');
    }
  });
});
