/* eslint-disable @typescript-eslint/no-explicit-any -- the fake drizzle chain below is untyped by design, like its siblings */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentAuditService } from '../../audit/index.js';
import type { Database } from '../../database/index.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
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

/** A database whose every select resolves to the next queued result, whatever its chain. */
function fakeDb(queue: unknown[]): Database {
  const chain = (result: unknown): any => {
    const c: any = {};
    for (const m of ['from', 'where', 'groupBy', 'innerJoin', 'orderBy', 'limit']) c[m] = () => c;
    c.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
    return c;
  };
  return { select: () => chain(queue.shift()) } as unknown as Database;
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
    const audit = new AgentAuditService(
      fakeDb([[{ keyId: 'k-called', connectionId: null, n: 3, last: new Date(FOUR_DAYS_AGO) }]]),
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
  });
});
