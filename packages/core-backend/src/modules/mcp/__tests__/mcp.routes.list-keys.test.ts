/* eslint-disable @typescript-eslint/no-explicit-any -- the fake drizzle chain below is untyped by design, like its siblings */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AgentAuditService } from '../../audit/index.js';
import type { Database } from '../../database/index.js';
import type { IExternalApiKeyService } from '../../tool-auth/index.js';
import { closeMountedRoutes, mountMcpRoutes } from './mcp-routes-harness.js';

/**
 * A person's own key list (the External agent access page) shows each key's
 * "last used" as its newest recorded call, from the same audit read the Audit
 * log uses, not the stamp the key service writes on every authenticated
 * request (a git pull or a tools listing moves it while calling nothing).
 */

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const FOUR_DAYS_AGO = NOW - 4 * DAY;

afterEach(async () => {
  await closeMountedRoutes();
  vi.restoreAllMocks();
});

/**
 * A database whose every select resolves to the next queued result, whatever
 * its chain. It applies no `where`, so each one is captured for a test to pin
 * which rows the read asked for.
 */
function fakeDb(queue: unknown[]) {
  const where: SQL[] = [];
  const chain = (result: unknown): any => {
    const c: any = {};
    for (const m of ['from', 'groupBy', 'innerJoin', 'orderBy', 'limit']) c[m] = () => c;
    c.where = (w: SQL) => (where.push(w), c);
    c.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
    return c;
  };
  return { db: { select: () => chain(queue.shift()) } as unknown as Database, where };
}

const summary = (id: string, lastUsedAt: number | null) => ({
  id,
  label: id,
  kind: 'key',
  createdAt: NOW - 10 * DAY,
  lastUsedAt,
  revokedAt: null,
  revokedBy: null,
});

describe('GET /mcp/external-api-keys', () => {
  it("lists each key's last recorded call as its last used, and null for a key with none", async () => {
    const keys = {
      // Both stamped a minute ago: one by a call four days back and a pull since, one by pulls alone.
      listForUser: vi.fn(async () => [summary('k-called', NOW - 60_000), summary('k-pulled', NOW - 60_000)]),
    } as unknown as IExternalApiKeyService;
    const fake = fakeDb([[{ keyId: 'k-called', connectionId: null, n: 3, last: new Date(FOUR_DAYS_AGO) }]]);
    const audit = new AgentAuditService(
      fake.db,
      keys,
      () => null,
      () => NOW,
    );
    const llm = { usageForTokens: vi.fn(async () => ({})), dailyCap: 0 };
    const base = await mountMcpRoutes({ externalApiKeyService: keys, llmUsageService: llm, lastCalls: audit });

    const res = await fetch(`${base}/api/mcp/external-api-keys`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; lastUsedAt: number | null }[];
    expect(body.map((k) => [k.id, k.lastUsedAt])).toEqual([
      ['k-called', FOUR_DAYS_AGO],
      ['k-pulled', null],
    ]);
    // The events read are the signed-in person's alone (the harness signs in as user-A).
    expect(keys.listForUser).toHaveBeenCalledWith('user-A');
    expect(fake.where).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(fake.where[0]!);
    expect({ sql, params }).toEqual({ sql: '"agent_events"."user_id" = $1', params: ['user-A'] });
  });

  it("answers a failed read with a fixed error, never the database's own message", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const keys = { listForUser: vi.fn(async () => [summary('k-1', NOW)]) } as unknown as IExternalApiKeyService;
    const lastCalls = { lastCalls: vi.fn(async () => Promise.reject(new Error('relation "agent_events" does not exist'))) };
    const llm = { usageForTokens: vi.fn(async () => ({})), dailyCap: 0 };
    const base = await mountMcpRoutes({ externalApiKeyService: keys, llmUsageService: llm, lastCalls });

    const res = await fetch(`${base}/api/mcp/external-api-keys`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Couldn't load external API keys." });
  });
});
