import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb } from '../connection.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger, LogFields } from '../../../shared/logger.contract.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, withPgAdmin } from '../../../__tests__/pg-scratch.js';

/**
 * The recovery the pool's error listener promises, on a real Postgres: a
 * pooled client the server terminates while it idles — a restart, a forced
 * database drop, an administrator's `pg_terminate_backend` — is logged and
 * let go, and the next query opens a fresh connection and succeeds. The unit
 * case in `connection.test.ts` pins the listener on a pool that never
 * connected; this one pins what the listener is for.
 *
 * Runs where `TEST_DATABASE_URL` names a server; only connects to the
 * database it names and terminates this test's own backend. Writes nothing.
 */
describe.skipIf(!PG_ADMIN_URL)('a pooled connection the server terminates', () => {
  it(
    'is logged with the error, and the next query succeeds on a new connection',
    async () => {
      const lines: { level: string; message: string; fields: LogFields }[] = [];
      const capture = (bindings: LogFields = {}): ILogger => {
        const line = (level: string) => (message: string, fields: LogFields = {}) =>
          void lines.push({ level, message, fields: { ...bindings, ...fields } });
        return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error'), child: (m) => capture({ ...bindings, ...m }) };
      };
      const previous = setLogger(capture());
      const db = createDb(PG_ADMIN_URL!);
      try {
        const backendPid = async () => Number((await db.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
        // The query's client now idles in the pool; the server ends it.
        const first = await backendPid();
        const noticed = new Promise<void>((resolve) => db.$client.once('error', () => resolve()));
        // The signal is checked before the wait: a backend that was not
        // terminated would otherwise surface as a timeout, not as the cause.
        const { rows } = await withPgAdmin((admin) =>
          admin.query<{ pg_terminate_backend: boolean }>('select pg_terminate_backend($1)', [first]),
        );
        expect(rows[0]?.pg_terminate_backend).toBe(true);
        await noticed;

        const second = await backendPid();
        expect(second).not.toBe(first);
        expect(lines).toEqual([
          {
            level: 'warn',
            message: 'an idle database connection was closed by the server; the next query opens a new one:',
            fields: { module: 'database', err: expect.objectContaining({ code: '57P01' }) },
          },
        ]);
      } finally {
        await closeDb(db);
        setLogger(previous);
      }
    },
    PG_TEST_TIMEOUT,
  );
});
