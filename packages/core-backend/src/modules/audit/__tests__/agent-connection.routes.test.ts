import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAgentConnectionRoutes } from '../agent-connection.routes.js';
import type { AgentUse, IAgentConnectionStatus } from '../audit.contract.js';

/**
 * GET /onboarding/agent-connection — what the connect-your-agent page polls.
 * The contract worth pinning:
 *
 *  - it answers for the AUTHENTICATED user (req.userId) and nobody else;
 *    nothing in the request — query or otherwise — can name another account;
 *  - "not yet" and "connected" are the two shapes, the second with when, as
 *    what, and whether that name is an agent's or a connection key's label;
 *  - the answer is never cached, since the next poll expects it to change;
 *  - a failure is a generic 500, never the driver's message.
 */

const ALICE = 'u-alice';
const BOB = 'u-bob';

const USES: Record<string, AgentUse> = {
  [BOB]: { at: new Date(Date.UTC(2026, 9, 7, 12, 0, 0)), client: 'Claude', kind: 'agent' },
};

const status = {
  lastAgentUse: vi.fn(async (userId: string) => USES[userId] ?? null),
} satisfies IAgentConnectionStatus;

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Mount the route with a stand-in auth middleware stamping `as` as the caller. */
async function listen(as: string): Promise<string> {
  const app = express();
  app.use((req, _res, next) => {
    req.userId = as;
    next();
  });
  app.use('/api', createAgentConnectionRoutes(status));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('GET /onboarding/agent-connection', () => {
  it('says "not yet" for a caller whose agents have not been used', async () => {
    const base = await listen(ALICE);
    const res = await fetch(`${base}/api/onboarding/agent-connection`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(status.lastAgentUse).toHaveBeenCalledWith(ALICE);
  });

  it('says connected, with when and as what, once one has', async () => {
    const base = await listen(BOB);
    const res = await fetch(`${base}/api/onboarding/agent-connection`);
    expect(await res.json()).toEqual({ connected: true, at: '2026-10-07T12:00:00.000Z', client: 'Claude', kind: 'agent' });
  });

  it("answers for the caller alone — a named account in the query is not asked about", async () => {
    const base = await listen(ALICE);
    const res = await fetch(`${base}/api/onboarding/agent-connection?userId=${BOB}&user=${BOB}`);
    expect(await res.json()).toEqual({ connected: false });
    expect(status.lastAgentUse).toHaveBeenCalledTimes(1);
    expect(status.lastAgentUse).toHaveBeenCalledWith(ALICE);
  });

  it('is never cached: the next poll expects a different answer', async () => {
    const base = await listen(ALICE);
    const res = await fetch(`${base}/api/onboarding/agent-connection`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports a failed read as a generic 500, keeping the detail server-side', async () => {
    const detail = 'connection to 10.0.0.4:5432 refused';
    status.lastAgentUse.mockRejectedValueOnce(new Error(detail));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await listen(ALICE);
    const res = await fetch(`${base}/api/onboarding/agent-connection`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Could not check your agent');
    expect(body.error).not.toContain(detail);
  });
});
