import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import type { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import { createAgentInstructionsRoutes } from '../agent-instructions.routes.js';
import { PLATFORM_HEADER, TOOL_PREFIX_LINE } from '../compose.js';

/**
 * `GET /agent/instructions` behind the REAL manual-auth gate, with the three
 * credential stores faked at their seams: a connection key, an internal token
 * and a browser JWT all get in, nothing else does, and the response is the
 * composer's result with the no-store header. Absence and failure of the file
 * stay distinguishable: ENOENT is the header alone, anything else is a 500.
 */

let httpServer: HttpServer | undefined;

const CONNECTION_KEY = 'bevel_abc';
const INTERNAL_TOKEN = 'bit_xyz';
const BROWSER_JWT = 'jwt.session.token';

async function serve(readPreamble: () => Promise<string | null>): Promise<string> {
  const externalKeys = {
    looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
    verifyAndLoadToken: async (t: string) => (t === CONNECTION_KEY ? { user: { id: 'u-key' }, tokenId: 'tok-1' } : null),
  } as unknown as IExternalApiKeyService;
  const internalTokens = {
    looksLikeInternalToken: (t: string) => t.startsWith('bit_'),
    verify: (t: string) => (t === INTERNAL_TOKEN ? { userId: 'u-internal' } : null),
  } as unknown as InternalTokenService;
  const authService = {
    verifyToken: (t: string) => {
      if (t !== BROWSER_JWT) throw new Error('bad jwt');
      return { userId: 'u-browser' };
    },
  } as unknown as AuthService;
  const app = express();
  app.use('/api', createAgentInstructionsRoutes(createManualAuthMiddleware(externalKeys, internalTokens, authService), readPreamble));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/api/agent/instructions`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

describe('GET /agent/instructions', () => {
  it('answers 200 for a connection key, an internal token and a browser JWT alike', async () => {
    const url = await serve(async () => 'Acme builds solar farms.\n');
    for (const bearer of [CONNECTION_KEY, INTERNAL_TOKEN, BROWSER_JWT]) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
      expect(res.status, bearer).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.instructions).toBe(`${PLATFORM_HEADER}\n\nAcme builds solar farms.`);
      expect(body.toolPrefix).toBe(`${TOOL_PREFIX_LINE} Acme builds solar farms.`);
      expect(body).toMatchObject({
        truncated: false,
        preambleChars: 'Acme builds solar farms.'.length,
        toolPrefixTruncated: false,
        unterminatedComment: false,
      });
    }
  });

  it('answers 401 without a credential, and for an invalid one', async () => {
    const url = await serve(async () => 'x');
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer bevel_wrong' } })).status).toBe(401);
    expect((await fetch(url, { headers: { Authorization: 'Bearer not-a-session' } })).status).toBe(401);
  });

  it('a missing file yields the header alone', async () => {
    const url = await serve(async () => null);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${CONNECTION_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instructions: string; toolPrefix: string; preambleChars: number };
    expect(body.instructions).toBe(PLATFORM_HEADER);
    expect(body.toolPrefix).toBe(TOOL_PREFIX_LINE);
    expect(body.preambleChars).toBe(0);
  });

  it('a read error other than ENOENT is a 500, never an empty preamble', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = await serve(async () => {
      throw Object.assign(new Error('disk'), { code: 'EIO' });
    });
    const res = await fetch(url, { headers: { Authorization: `Bearer ${CONNECTION_KEY}` } });
    expect(res.status).toBe(500);
    // The failure is no more cacheable than a success.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
