/* eslint-disable @typescript-eslint/no-explicit-any -- the fake drizzle chain below is untyped by design, like its siblings */
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AgentAuditService, retentionDaysFrom } from '../agent-audit.service.js';
import { AuditPrincipalNotFoundError, InvalidCursorError } from '../audit.contract.js';
import type { Database } from '../../database/connection.js';
import { agentConnections, oauthTokens } from '../../database/schema.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';

/**
 * The fake drizzle chain the other service tests use: every chainable method
 * returns the chain, the chain is thenable, and each `db.insert / select /
 * update / delete` pops the next queued result. `transaction` runs its
 * callback against the same fake, so queued results are consumed in order.
 * Every `where` predicate and `update` target is captured, so a test can pin
 * WHICH rows a statement addressed (see {@link render}), not just that it ran.
 */
function makeFakeDb(queue: unknown[]) {
  const captured: { values: any[]; set: any[]; where: SQL[]; updateTargets: unknown[] } = {
    values: [],
    set: [],
    where: [],
    updateTargets: [],
  };
  const counts = { insert: 0, select: 0, update: 0, delete: 0 };

  function nextChain() {
    const result = queue.shift();
    const chain: any = {};
    const passthrough = (recorder?: (args: any[]) => void) =>
      vi.fn((...args: any[]) => {
        recorder?.(args);
        return chain;
      });
    chain.values = passthrough((a) => captured.values.push(a[0]));
    chain.set = passthrough((a) => captured.set.push(a[0]));
    chain.where = passthrough((a) => captured.where.push(a[0]));
    chain.limit = passthrough();
    chain.innerJoin = passthrough();
    chain.from = passthrough();
    chain.orderBy = passthrough();
    chain.groupBy = passthrough();
    chain.returning = passthrough();
    chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
    return chain;
  }

  const db: any = {
    insert: vi.fn(() => (counts.insert++, nextChain())),
    select: vi.fn(() => (counts.select++, nextChain())),
    update: vi.fn((table: unknown) => (counts.update++, captured.updateTargets.push(table), nextChain())),
    delete: vi.fn(() => (counts.delete++, nextChain())),
    transaction: vi.fn((fn: (tx: any) => Promise<unknown>) => fn(db)),
  };
  return { db: db as Database, captured, counts };
}

/** A captured predicate as the SQL it would send, with its parameters. */
function render(fragment: SQL | undefined): { sql: string; params: unknown[] } {
  if (!fragment) return { sql: '', params: [] };
  const q = new PgDialect().sqlToQuery(fragment);
  return { sql: q.sql, params: q.params };
}

const ALICE = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };
const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

const key = (over: object) => ({
  id: 'k-1',
  label: 'CI pipeline',
  kind: 'key',
  createdAt: NOW - 10 * DAY,
  lastUsedAt: NOW - DAY,
  revokedAt: null,
  revokedBy: null,
  ...over,
});
const connection = (over: object) => ({
  id: 'c-1',
  userId: ALICE.id,
  clientId: 'client-claude',
  clientName: 'Claude',
  connectedAt: new Date(NOW - 5 * DAY),
  lastUsedAt: new Date(NOW - 60_000),
  revokedAt: null,
  revokedBy: null,
  ...over,
});

function makeService(queue: unknown[], keys: Partial<IExternalApiKeyService> = {}, retention = 90) {
  const fake = makeFakeDb(queue);
  const keyService = {
    listForUser: vi.fn(async () => []),
    listForDeployment: vi.fn(async () => []),
    ownerOf: vi.fn(async () => null),
    ...keys,
  } as unknown as IExternalApiKeyService;
  const service = new AgentAuditService(fake.db, keyService, () => retention, () => NOW);
  return { service, ...fake, keyService };
}

/** Let the fire-and-forget insert (and whatever it schedules) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AgentAuditService.record', () => {
  it('inserts the event with exactly one principal column set and never throws to the caller', async () => {
    const { service, captured } = makeService([undefined /* insert */]);
    service.record({
      userId: ALICE.id,
      principal: { kind: 'key', id: 'k-1' },
      kind: 'tool',
      manual: 'notion',
      name: 'search',
      outcome: 'ok',
      durationMs: 42,
    });
    await flush();
    expect(captured.values[0]).toMatchObject({
      userId: ALICE.id,
      keyId: 'k-1',
      connectionId: null,
      kind: 'tool',
      manual: 'notion',
      name: 'search',
      outcome: 'ok',
      durationMs: 42,
    });

    const agent = makeService([undefined]);
    agent.service.record({
      userId: ALICE.id,
      principal: { kind: 'agent', id: 'c-1' },
      kind: 'skill',
      manual: 'Plugins/Sales/rfi',
      name: 'rfi',
      outcome: 'ok',
      durationMs: null,
    });
    await flush();
    expect(agent.captured.values[0]).toMatchObject({ keyId: null, connectionId: 'c-1', kind: 'skill' });
  });

  it('prunes past the retention window once per hour, not on every insert', async () => {
    const { service, counts } = makeService([undefined, undefined, undefined, undefined], {}, 30);
    const event = {
      userId: ALICE.id,
      principal: { kind: 'key' as const, id: 'k-1' },
      kind: 'capability' as const,
      manual: null,
      name: 'read_file',
      outcome: 'ok' as const,
      durationMs: 3,
    };
    service.record(event);
    await flush();
    expect(counts.delete).toBe(1); // the first insert sweeps
    service.record(event);
    await flush();
    expect(counts.delete).toBe(1); // the second, a moment later, does not
  });

  it('swallows an insert failure (logged), so a tool result never fails over its bookkeeping', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service } = makeService([Promise.reject(new Error('db down'))]);
    expect(() =>
      service.record({
        userId: ALICE.id,
        principal: { kind: 'key', id: 'k-1' },
        kind: 'capability',
        manual: null,
        name: 'ask',
        outcome: 'ok',
        durationMs: 1,
      }),
    ).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('AgentAuditService.listPrincipals', () => {
  it("lists a person's keys and agents with event counts, live first, most recently used first", async () => {
    const { service } = makeService(
      [
        // keysForUser: the user row
        [ALICE],
        // connections joined with users
        [
          { connection: connection({ id: 'c-old', revokedAt: new Date(NOW - DAY), revokedBy: 'owner', lastUsedAt: new Date(NOW) }), user: ALICE },
          { connection: connection({ id: 'c-1' }), user: ALICE },
        ],
        // event counts
        [
          { keyId: 'k-1', connectionId: null, n: 7 },
          { keyId: null, connectionId: 'c-1', n: 3 },
        ],
      ],
      { listForUser: vi.fn(async () => [key({ lastUsedAt: NOW - 2 * DAY })]) },
    );

    const rows = await service.listPrincipals({ userId: ALICE.id });

    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['agent:c-1', 'key:k-1', 'agent:c-old']);
    expect(rows[0]).toMatchObject({ label: 'Claude', eventCount: 3, user: ALICE, revokedAt: null });
    expect(rows[1]).toMatchObject({ label: 'CI pipeline', keyKind: 'key', eventCount: 7, user: ALICE });
    // The revoked one sinks, still carrying who ended it and its (zero) count.
    expect(rows[2]).toMatchObject({ revokedBy: 'owner', eventCount: 0 });
  });

  it('lists every account for the deployment, grouped by owner email', async () => {
    const { service, keyService } = makeService(
      [
        [{ connection: connection({ id: 'c-bob', userId: BOB.id }), user: BOB }],
        [],
      ],
      { listForDeployment: vi.fn(async () => [{ ...key({}), user: ALICE }]) },
    );

    const rows = await service.listPrincipals('all');

    expect(rows.map((r) => r.user.email)).toEqual(['alice@example.com', 'bob@example.com']);
    expect((keyService.listForDeployment as any)).toHaveBeenCalled();
    expect((keyService.listForUser as any)).not.toHaveBeenCalled();
  });
});

describe('AgentAuditService.listEvents', () => {
  const eventId = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
  const eventRow = (i: number) => ({
    id: eventId(i),
    kind: 'capability',
    manual: null,
    name: `tool-${i}`,
    outcome: 'ok',
    at: new Date(NOW - i * 1000),
  });

  it('pages newest first with a keyset cursor and reports the total', async () => {
    const { service, captured } = makeService([
      [eventRow(1), eventRow(2), eventRow(3)] /* limit 2 → 3 rows means more */,
      [{ total: 12 }],
    ]);

    const page = await service.listEvents({ kind: 'key', id: 'k-1' }, { limit: 2 });

    expect(page.events.map((e) => e.id)).toEqual([eventId(1), eventId(2)]);
    expect(page.events[0]).toMatchObject({ kind: 'capability', name: 'tool-1', outcome: 'ok', at: NOW - 1000 });
    expect(page.total).toBe(12);
    expect(page.nextCursor).toBe(`${NOW - 2000}.${eventId(2)}`);
    // The page and the total both read THIS principal's rows and nobody else's.
    expect(render(captured.where[0]).params).toEqual(['k-1']);
    expect(render(captured.where[1]).params).toEqual(['k-1']);

    // A cursor page counts nothing: the reader holds the first page's total.
    const last = makeService([[eventRow(3)]]);
    const tail = await last.service.listEvents({ kind: 'key', id: 'k-1' }, { before: page.nextCursor!, limit: 2 });
    expect(tail.events.map((e) => e.id)).toEqual([eventId(3)]);
    expect(tail.nextCursor).toBeNull();
    expect(tail.total).toBeNull();
    expect(last.counts.select).toBe(1);
    // The cursor became the keyset predicate: strictly older, or the same
    // instant and a smaller id.
    const after = render(last.captured.where[0]);
    expect(after.sql).toMatch(/"at" < \$2 or \("agent_events"."at" = \$3 and "agent_events"."id" < \$4\)/);
    // The instant rides twice (strictly-older, and same-instant) as whatever
    // the driver spells a timestamp as; the id is the cursor's own.
    expect(after.params[0]).toBe('k-1');
    expect(after.params[1]).toEqual(after.params[2]);
    expect(new Date(after.params[1] as string | Date).getTime()).toBe(NOW - 2000);
    expect(after.params[3]).toBe(eventId(2));
  });

  it('refuses a cursor it did not issue instead of sending it to the database', async () => {
    const { service, counts } = makeService([]);
    for (const before of ['123.bad', 'notanumber.' + eventId(1), '1e5.' + eventId(1), eventId(1)]) {
      await expect(service.listEvents({ kind: 'key', id: 'k-1' }, { before, limit: 2 })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
    expect(counts.select).toBe(0);
  });
});

describe('AgentAuditService.ownerOf', () => {
  it('answers for a key through the key service, and for an agent from its connection row', async () => {
    const { service, keyService } = makeService([[{ userId: BOB.id }]], { ownerOf: vi.fn(async () => ALICE.id) });
    await expect(service.ownerOf({ kind: 'key', id: 'k-1' })).resolves.toBe(ALICE.id);
    expect(keyService.ownerOf).toHaveBeenCalledWith('k-1');
    await expect(service.ownerOf({ kind: 'agent', id: 'c-1' })).resolves.toBe(BOB.id);
  });
});

describe('AgentAuditService.revokeConnection', () => {
  it('marks the connection revoked by whom, and revokes every live token it holds', async () => {
    const { service, captured } = makeService([
      [{ id: 'c-1' }] /* connection update.returning */,
      undefined /* tokens update */,
    ]);

    await service.revokeConnection('c-1', 'admin');

    expect(captured.updateTargets).toEqual([agentConnections, oauthTokens]);
    expect(captured.set[0]).toMatchObject({ revokedBy: 'admin' });
    expect(captured.set[0].revokedAt).toBeInstanceOf(Date);
    expect(captured.set[1].revokedAt).toBeInstanceOf(Date);
    // An admin's revoke is unscoped by owner, and touches only a LIVE connection…
    const connection = render(captured.where[0]);
    expect(connection.sql).toMatch(/"agent_connections"."id" = \$1 and "agent_connections"."revoked_at" is null/);
    expect(connection.params).toEqual(['c-1']);
    // …and exactly its own live tokens, never another connection's.
    const tokens = render(captured.where[1]);
    expect(tokens.sql).toMatch(/"oauth_tokens"."connection_id" = \$1 and "oauth_tokens"."revoked_at" is null/);
    expect(tokens.params).toEqual(['c-1']);
  });

  it("scopes an owner's revoke to their own connections", async () => {
    const { service, captured } = makeService([[{ id: 'c-1' }], undefined]);
    await service.revokeConnection('c-1', 'owner', ALICE.id);
    const connection = render(captured.where[0]);
    expect(connection.sql).toMatch(/"agent_connections"."user_id" = \$2/);
    expect(connection.params).toEqual(['c-1', ALICE.id]);
    expect(captured.set[0]).toMatchObject({ revokedBy: 'owner' });
  });

  it('is idempotent on an already-revoked connection and throws for one out of scope', async () => {
    const already = makeService([[] /* nothing live */, [{ id: 'c-1' }] /* but it exists */]);
    await expect(already.service.revokeConnection('c-1', 'owner', ALICE.id)).resolves.toBeUndefined();
    expect(already.counts.update).toBe(1); // no token revoke on a no-op
    // The existence probe carries the SAME owner scope as the revoke itself.
    expect(render(already.captured.where[1]).params).toEqual(['c-1', ALICE.id]);

    const foreign = makeService([[], []]);
    await expect(foreign.service.revokeConnection('c-1', 'owner', BOB.id)).rejects.toBeInstanceOf(
      AuditPrincipalNotFoundError,
    );
  });
});

describe('retentionDaysFrom', () => {
  it('reads a whole number of days within the window and falls back to the default otherwise', () => {
    expect(retentionDaysFrom('30')).toBe(30);
    expect(retentionDaysFrom(' 3650 ')).toBe(3650);
    expect(retentionDaysFrom('')).toBe(90);
    expect(retentionDaysFrom('0')).toBe(90);
    expect(retentionDaysFrom('-5')).toBe(90);
    expect(retentionDaysFrom('1.5')).toBe(90);
    expect(retentionDaysFrom('lots')).toBe(90);
    // The same ceiling the Deployment page enforces: a typo in the
    // environment cannot stretch the window to forever.
    expect(retentionDaysFrom('3651')).toBe(90);
    expect(retentionDaysFrom('99999999')).toBe(90);
  });
});
