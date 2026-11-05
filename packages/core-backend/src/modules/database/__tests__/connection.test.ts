import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_DB_SCHEMA,
  assertSchemaName,
  assertSearchPath,
  closeDb,
  createDb,
  dbSchemaOf,
  getDb,
  type Database,
} from '../connection.js';
import { setLogger } from '../../../shared/logging.js';
import { capturingLogger } from '../../../__tests__/capturing-logger.js';

/**
 * Pools here are never connected: `pg.Pool` opens nothing until a query is
 * asked of it, so what a handle was built with — the schema its connections
 * will search, whether two asks share one pool — is observable without a
 * database, and that is what these cases pin.
 */
const URL = 'postgresql://u:p@127.0.0.1:1/never';

const searchPath = (db: Database): string | undefined =>
  (db.$client.options as { options?: string }).options;

const opened: Database[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => closeDb(db)));
});

describe('an idle connection the server closes', () => {
  it('is logged, with the error, and let go — the pool has a listener, so the event cannot end the process', () => {
    // A capturing logger stands in for the process's: the warning is the
    // behaviour under test, not a side effect to tolerate.
    const { logger: capturing, lines } = capturingLogger();
    const previous = setLogger(capturing);
    try {
      const db = createDb(URL);
      opened.push(db);
      // `pg.Pool` emits an idle client's failure on itself; without a listener
      // Node throws the event. The terminated-backend error is what a server
      // restart or a forced drop sends to every idle client.
      const terminated = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      expect(db.$client.listenerCount('error')).toBe(1);
      expect(() => db.$client.emit('error', terminated)).not.toThrow();
      expect(lines).toEqual([
        {
          level: 'warn',
          message: 'an idle database connection was closed by the server; the next query opens a new one:',
          fields: { module: 'database', err: terminated },
        },
      ]);
    } finally {
      setLogger(previous);
    }
  });
});

describe('schema per knowledge base', () => {
  it('searches the schema it was built for, and leaves the default schema to the server', () => {
    const acme = createDb(URL, { schema: 'acme' });
    const plain = createDb(URL);
    opened.push(acme, plain);
    expect(searchPath(acme)).toBe('-c search_path=acme');
    expect(dbSchemaOf(acme)).toBe('acme');
    // Nothing set: an operator's own `search_path` stays in force.
    expect(searchPath(plain)).toBeUndefined();
    expect(dbSchemaOf(plain)).toBe(DEFAULT_DB_SCHEMA);
  });

  it('refuses a schema name that is not a plain lowercase identifier', () => {
    for (const bad of ['Acme', 'a-b', 'a b', '1abc', 'public; drop schema x', '', 'a'.repeat(64)]) {
      expect(() => assertSchemaName(bad), bad).toThrow(/schema name/);
      expect(() => createDb(URL, { schema: bad }), bad).toThrow(/schema name/);
    }
    expect(assertSchemaName('t_acme_2')).toBe('t_acme_2');
  });

  it('refuses the names Postgres and drizzle already own', () => {
    for (const reserved of ['pg_catalog', 'pg_toast', 'pg_x', 'information_schema', 'drizzle']) {
      expect(() => assertSchemaName(reserved), reserved).toThrow(/reserved/);
    }
    // The default schema is a valid name here: a single-tenant deployment
    // lives on it. A tenant source refuses it for a tenant, not this guard.
    expect(assertSchemaName(DEFAULT_DB_SCHEMA)).toBe(DEFAULT_DB_SCHEMA);
  });
});

describe('assertSearchPath', () => {
  const answering = (schema: string | null) => ({
    execute: async () => ({ rows: [{ schema }] }) as never,
  });

  it('passes when the server searches the configured schema first', async () => {
    await expect(assertSearchPath(answering('t_acme'), 't_acme')).resolves.toBeUndefined();
  });

  it('refuses a connection whose schema a pooler dropped, naming both schemas and the cause', async () => {
    // What a transaction-mode pooler leaves behind: the startup parameter
    // never reached the server, so `public` is searched first.
    await expect(assertSearchPath(answering('public'), 't_acme')).rejects.toThrow(
      /search "public" first, not the configured schema "t_acme".*transaction-mode pooler/,
    );
    await expect(assertSearchPath(answering(null), 't_acme')).rejects.toThrow(/\(none\)/);
  });
});

describe('getDb', () => {
  it('shares one pool per (url, schema) and keeps different schemas apart', () => {
    const a1 = getDb(URL, { schema: 'acme' });
    const a2 = getDb(URL, { schema: 'acme' });
    const b = getDb(URL, { schema: 'globex' });
    const plain = getDb(URL);
    opened.push(a1, b, plain);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
    expect(plain).not.toBe(a1);
    expect(getDb(URL, { schema: DEFAULT_DB_SCHEMA })).toBe(plain);
  });

  it('hands the cached pool to a caller holding the same key spelled otherwise, and refuses another key', () => {
    const raw = randomBytes(32);
    const first = getDb(URL, { schema: 'keyed', piiKey: raw.toString('base64') });
    opened.push(first);
    // The same 32 bytes as hex: one key, so one pool.
    expect(getDb(URL, { schema: 'keyed', piiKey: raw.toString('hex') })).toBe(first);
    expect(() => getDb(URL, { schema: 'keyed', piiKey: randomBytes(32).toString('base64') })).toThrow(
      /already open with a different personal-data key/,
    );
  });

  it('opens a fresh pool after the cached one was closed', async () => {
    const first = getDb(URL, { schema: 'closing' });
    await closeDb(first);
    const second = getDb(URL, { schema: 'closing' });
    opened.push(second);
    expect(second).not.toBe(first);
  });
});
