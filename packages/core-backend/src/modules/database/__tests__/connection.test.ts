import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_DB_SCHEMA, assertSchemaName, closeDb, createDb, dbSchemaOf, getDb, type Database } from '../connection.js';

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

  it('opens a fresh pool after the cached one was closed', async () => {
    const first = getDb(URL, { schema: 'closing' });
    await closeDb(first);
    const second = getDb(URL, { schema: 'closing' });
    opened.push(second);
    expect(second).not.toBe(first);
  });
});
