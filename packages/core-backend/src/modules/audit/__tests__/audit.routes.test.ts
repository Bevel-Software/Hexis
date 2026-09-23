import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAuditRoutes } from '../audit.routes.js';
import {
  AuditPrincipalNotFoundError,
  InvalidCursorError,
  type AuditPrincipal,
  type IAgentAuditService,
} from '../audit.contract.js';
import { TokenNotFoundError } from '../../tool-auth/external-api-key.errors.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

const ALICE = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };
const KEY_ID = '0f1e2d3c-4b5a-4697-8877-665544332211';
const AGENT_ID = '11111111-2222-4333-8444-555555555555';

const ALICE_KEY: AuditPrincipal = {
  kind: 'key',
  id: KEY_ID,
  label: 'CI pipeline',
  keyKind: 'key',
  createdAt: Date.UTC(2026, 0, 1),
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
  eventCount: 2,
  user: ALICE,
};

/** Who owns what, as the fake service answers `ownerOf`. */
const OWNERS: Record<string, string> = { [KEY_ID]: ALICE.id, [AGENT_ID]: BOB.id };

const audit = {
  listPrincipals: vi.fn(async () => [ALICE_KEY]),
  ownerOf: vi.fn(async (p: { id: string }) => OWNERS[p.id] ?? null),
  listEvents: vi.fn(async () => ({ events: [], total: 0, nextCursor: null })),
  revokeConnection: vi.fn(async () => {}),
} satisfies IAgentAuditService;

const keys = {
  revoke: vi.fn(async () => {}),
  revokeAny: vi.fn(async () => {}),
};

function makeApp(opts: { admin: boolean; as?: { id: string; email: string } }) {
  const adminAccess: IAdminAccessService = { isAdmin: vi.fn(async () => opts.admin) };
  const app = express();
  app.use(express.json());
  // Stand-in auth middleware: stamps the caller identity the way the real JWT middleware does.
  app.use((req, _res, next) => {
    req.userId = opts.as?.id ?? ALICE.id;
    req.userEmail = opts.as?.email ?? ALICE.email;
    next();
  });
  app.use('/api', createAuditRoutes(audit, keys, adminAccess));
  return app;
}

let server: Server;
afterEach(() => {
  server?.close();
  vi.clearAllMocks();
});

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('audit routes — principals', () => {
  it("lists the caller's own rows by default, and refuses scope=all to a member", async () => {
    const base = await listen(makeApp({ admin: false }));
    const mine = await fetch(`${base}/api/audit/principals`);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ principals: [ALICE_KEY] });
    expect(audit.listPrincipals).toHaveBeenCalledWith({ userId: ALICE.id });

    expect((await fetch(`${base}/api/audit/principals?scope=all`)).status).toBe(403);
    expect(audit.listPrincipals).toHaveBeenCalledTimes(1);
  });

  it('lists every account for an admin asking for scope=all', async () => {
    const base = await listen(makeApp({ admin: true }));
    const res = await fetch(`${base}/api/audit/principals?scope=all`);
    expect(res.status).toBe(200);
    expect(audit.listPrincipals).toHaveBeenCalledWith('all');
  });
});

describe('audit routes — events', () => {
  it('serves the owner their events, with the page parameters passed through and clamped', async () => {
    const base = await listen(makeApp({ admin: false }));
    const res = await fetch(`${base}/api/audit/principals/key/${KEY_ID}/events?before=123.e-9&limit=5000`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], total: 0, nextCursor: null });
    expect(audit.listEvents).toHaveBeenCalledWith({ kind: 'key', id: KEY_ID }, { before: '123.e-9', limit: 200 });
  });

  it('answers a cursor the service does not recognise with 400, not 500', async () => {
    const base = await listen(makeApp({ admin: false }));
    audit.listEvents.mockRejectedValueOnce(new InvalidCursorError());
    const res = await fetch(`${base}/api/audit/principals/key/${KEY_ID}/events?before=123.bad`);
    expect(res.status).toBe(400);
  });

  it("refuses another person's principal to a member, and serves it to an admin", async () => {
    const asAlice = await listen(makeApp({ admin: false }));
    expect((await fetch(`${asAlice}/api/audit/principals/agent/${AGENT_ID}/events`)).status).toBe(403);
    expect(audit.listEvents).not.toHaveBeenCalled();
    server.close();

    const asAdmin = await listen(makeApp({ admin: true }));
    expect((await fetch(`${asAdmin}/api/audit/principals/agent/${AGENT_ID}/events`)).status).toBe(200);
  });

  it('404s an unknown kind, a malformed id, and a principal nobody owns', async () => {
    const base = await listen(makeApp({ admin: true }));
    expect((await fetch(`${base}/api/audit/principals/robot/${KEY_ID}/events`)).status).toBe(404);
    expect((await fetch(`${base}/api/audit/principals/key/not-a-uuid/events`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/audit/principals/key/00000000-0000-4000-8000-000000000000/events`)).status,
    ).toBe(404);
    expect(audit.listEvents).not.toHaveBeenCalled();
  });
});

describe('audit routes — revoke an agent', () => {
  it("scopes a member's revoke to their own connections and records it as the owner's", async () => {
    const base = await listen(makeApp({ admin: false, as: BOB }));
    const res = await fetch(`${base}/api/audit/agents/${AGENT_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(audit.revokeConnection).toHaveBeenCalledWith(AGENT_ID, 'owner', BOB.id);
  });

  it("revokes anyone's connection for an admin, recorded as an admin's doing", async () => {
    const base = await listen(makeApp({ admin: true }));
    const res = await fetch(`${base}/api/audit/agents/${AGENT_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(audit.revokeConnection).toHaveBeenCalledWith(AGENT_ID, 'admin', undefined);
  });

  it('404s a malformed id without touching the service, and an unknown/foreign one after it', async () => {
    const base = await listen(makeApp({ admin: false }));
    expect((await fetch(`${base}/api/audit/agents/nope`, { method: 'DELETE' })).status).toBe(404);
    expect(audit.revokeConnection).not.toHaveBeenCalled();

    audit.revokeConnection.mockRejectedValueOnce(new AuditPrincipalNotFoundError());
    expect((await fetch(`${base}/api/audit/agents/${AGENT_ID}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('audit routes — revoke a key', () => {
  it("revokes the caller's own key through the owner path", async () => {
    const base = await listen(makeApp({ admin: false }));
    const res = await fetch(`${base}/api/audit/keys/${KEY_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(keys.revoke).toHaveBeenCalledWith(KEY_ID, ALICE.id);
    expect(keys.revokeAny).not.toHaveBeenCalled();
  });

  it("revokes someone else's key only for an admin, through the admin path", async () => {
    const asBob = await listen(makeApp({ admin: false, as: BOB }));
    expect((await fetch(`${asBob}/api/audit/keys/${KEY_ID}`, { method: 'DELETE' })).status).toBe(403);
    expect(keys.revoke).not.toHaveBeenCalled();
    expect(keys.revokeAny).not.toHaveBeenCalled();
    server.close();

    const asAdmin = await listen(makeApp({ admin: true, as: BOB }));
    expect((await fetch(`${asAdmin}/api/audit/keys/${KEY_ID}`, { method: 'DELETE' })).status).toBe(200);
    expect(keys.revokeAny).toHaveBeenCalledWith(KEY_ID);
  });

  it('404s an unknown key, for members and admins alike', async () => {
    const base = await listen(makeApp({ admin: true }));
    const ghost = '00000000-0000-4000-8000-000000000000';
    keys.revokeAny.mockRejectedValueOnce(new TokenNotFoundError());
    expect((await fetch(`${base}/api/audit/keys/${ghost}`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/audit/keys/garbage`, { method: 'DELETE' })).status).toBe(404);
  });
});
