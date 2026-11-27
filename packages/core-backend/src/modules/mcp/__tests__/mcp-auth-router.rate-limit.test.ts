import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpAuthRouter, MCP_TOKEN_REQUESTS_PER_WINDOW } from '../oauth/mcp-auth-router.js';

/**
 * The rate limits of the MCP OAuth authorization server, through the router
 * the server mounts. `POST /token` carries every Copilot user of a deployment
 * from the relay's one address, so it allows MCP_TOKEN_REQUESTS_PER_WINDOW
 * per address; /authorize and /register keep the SDK's own limits. The
 * client address is `req.ip`, set here the way `TRUST_PROXY=1` sets it.
 */

let http: Server | null = null;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = null;
});

/** A provider that knows no client: every token request is refused as `invalid_client`. */
const provider = {
  clientsStore: {
    getClient: async () => undefined,
    registerClient: async (c: unknown) => c,
  },
  authorize: async () => { throw new Error('not reached'); },
  challengeForAuthorizationCode: async () => { throw new Error('not reached'); },
  exchangeAuthorizationCode: async () => { throw new Error('not reached'); },
  exchangeRefreshToken: async () => { throw new Error('not reached'); },
  verifyAccessToken: async () => { throw new Error('not reached'); },
} as unknown as OAuthServerProvider;

async function mount(): Promise<string> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createMcpAuthRouter({
    provider,
    issuerUrl: new URL('http://localhost'),
    resourceServerUrl: new URL('http://localhost/api/mcp'),
  }));
  http = app.listen(0);
  await new Promise<void>((r) => http!.once('listening', () => r()));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function token(base: string, from: string) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from },
    body: 'grant_type=refresh_token&refresh_token=r&client_id=unknown-client',
  });
}

/** `n` requests in sequence; the statuses in order. */
async function statuses(n: number, send: () => Promise<Response>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await send();
    await res.arrayBuffer();
    out.push(res.status);
  }
  return out;
}

describe('MCP OAuth rate limits', () => {
  it('answers 60 token requests from one address without a 429', async () => {
    const base = await mount();
    const got = await statuses(60, () => token(base, '203.0.113.7'));
    expect(got.filter((s) => s === 429)).toEqual([]);
    expect(new Set(got)).toEqual(new Set([400]));
  });

  it('answers the 1,000th token request normally and the 1,001st with 429 too_many_requests, per address', async () => {
    expect(MCP_TOKEN_REQUESTS_PER_WINDOW).toBe(1000);
    const base = await mount();
    const got = await statuses(MCP_TOKEN_REQUESTS_PER_WINDOW, () => token(base, '203.0.113.7'));
    expect(got.filter((s) => s === 429)).toEqual([]);

    const over = await token(base, '203.0.113.7');
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: 'too_many_requests' });

    // Another address has its own count.
    const other = await token(base, '198.51.100.9');
    expect(other.status).toBe(400);
  }, 60_000);

  it('keeps the SDK limits on /authorize (100 per 15 minutes) and /register (20 per hour)', async () => {
    const base = await mount();
    const authorize = () => fetch(
      `${base}/authorize?client_id=unknown-client&redirect_uri=${encodeURIComponent('https://a.example/cb')}&response_type=code`,
      { headers: { 'x-forwarded-for': '203.0.113.7' }, redirect: 'manual' },
    );
    const a = await statuses(101, authorize);
    expect(a.slice(0, 100).filter((s) => s === 429)).toEqual([]);
    expect(a[100]).toBe(429);

    const register = () => fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: '{}',
    });
    const r = await statuses(21, register);
    expect(r.slice(0, 20).filter((s) => s === 429)).toEqual([]);
    expect(r[20]).toBe(429);
  }, 60_000);
});
