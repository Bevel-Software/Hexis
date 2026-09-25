import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * One database, one schema per knowledge base.
 *
 * A single-tenant deployment keeps `public`, exactly as before this option
 * existed: no `search_path` is set for it, so an operator's own default
 * (`"$user", public`) is honoured, and the migration ledger stays where
 * drizzle put it. A knowledge base hosted beside others gets a schema of its
 * own: every connection of its pool starts with `search_path` pointing at it,
 * so the unqualified table names the schema module and the migrations use
 * resolve there and nowhere else. Isolation is then a Postgres object, and a
 * tenant leaves as `pg_dump -n <schema>`.
 */
export const DEFAULT_DB_SCHEMA = 'public';

/**
 * A schema name this module will put into `search_path`: a plain lowercase
 * identifier, at most Postgres's 63 characters. Validated rather than quoted,
 * because the name also travels into `CREATE SCHEMA` and a `pg_dump`
 * invocation, and a name that needs quoting in one of them is a name that
 * will be spelled wrong in another.
 */
export function assertSchemaName(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Database schema name must be a lowercase identifier ([a-z][a-z0-9_]*, at most 63 characters); got "${name}"`,
    );
  }
  return name;
}

export interface DbOptions {
  /** The schema the pool's connections search first. Default {@link DEFAULT_DB_SCHEMA}. */
  schema?: string;
  /**
   * Connections the pool may hold. `pg`'s default (10) suits a process that
   * serves one knowledge base; a process serving many keeps each pool small,
   * since the database's `max_connections` is shared by all of them.
   */
  max?: number;
  /** How long an idle connection is kept before the pool closes it. Default: `pg`'s. */
  idleTimeoutMillis?: number;
}

/**
 * A bounded handshake: `pg` waits forever by default for a NEW connection to
 * come up, so a database that accepts the socket and never finishes the
 * handshake would hold a boot (the migration lock is the first thing that
 * asks) with nothing to say and nothing for the restart policy to see. Half
 * a minute is generous for a handshake and short enough for a failed boot to
 * be visible. It bounds only that: a checkout queued behind a saturated pool,
 * or a query on a connection that stopped answering, is the caller's to
 * bound — the advisory lock does.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * A NEW pool on `databaseUrl`, searching `opts.schema` first. Not cached:
 * the caller owns it and ends it with {@link closeDb}. The composition root
 * of a process that serves one knowledge base goes through {@link getDb}
 * instead, which caches.
 */
export function createDb(databaseUrl: string, opts: DbOptions = {}) {
  const dbSchema = assertSchemaName(opts.schema ?? DEFAULT_DB_SCHEMA);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    max: opts.max,
    idleTimeoutMillis: opts.idleTimeoutMillis,
    // A startup parameter, applied by the server to every connection this
    // pool opens — not a `SET` run after connecting, which a pooled
    // connection could outlive. The default schema sets nothing, so an
    // operator's own `search_path` stays in force there.
    ...(dbSchema === DEFAULT_DB_SCHEMA ? {} : { options: `-c search_path=${dbSchema}` }),
  });
  const db = drizzle(pool, { schema });
  schemas.set(db, dbSchema);
  return db;
}

export type Database = ReturnType<typeof createDb>;

/** The schema a database handle searches first — for the callers that name it in DDL. */
export function dbSchemaOf(db: Pick<Database, '$client'>): string {
  return schemas.get(db as Database) ?? DEFAULT_DB_SCHEMA;
}

const schemas = new WeakMap<Database, string>();
const cache = new Map<string, Database>();

const cacheKey = (databaseUrl: string, dbSchema: string) => `${dbSchema}\u0000${databaseUrl}`;

/**
 * The process's pool on `databaseUrl` for `opts.schema`, created on first
 * use and shared afterwards. One per (url, schema): two handles on the same
 * schema would be two pools competing for the same connection budget.
 */
export function getDb(databaseUrl: string, opts: DbOptions = {}): Database {
  const dbSchema = assertSchemaName(opts.schema ?? DEFAULT_DB_SCHEMA);
  const key = cacheKey(databaseUrl, dbSchema);
  let db = cache.get(key);
  if (!db) {
    db = createDb(databaseUrl, opts);
    cache.set(key, db);
  }
  return db;
}

/**
 * End a handle's pool and forget it, so a later {@link getDb} for the same
 * schema opens a fresh one rather than handing out a pool that was ended.
 * The last step of stopping a knowledge base's graph.
 */
export async function closeDb(db: Database): Promise<void> {
  for (const [key, cached] of cache) {
    if (cached === db) cache.delete(key);
  }
  await db.$client.end();
}
