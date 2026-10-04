import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { PII_CIPHERTEXT_PREFIX, PiiParam, derivePiiKeys, type PiiKeys } from '../../shared/column-crypto.js';

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
  // Names Postgres or drizzle already own. `pg_*` would fail at CREATE
  // SCHEMA anyway; `information_schema` would not, and `drizzle` is where a
  // deployment on the default schema keeps its migration ledger, so a
  // knowledge base placed there would share that ledger's home.
  if (name.startsWith('pg_') || name === 'information_schema' || name === 'drizzle') {
    throw new Error(`Database schema name "${name}" is reserved`);
  }
  return name;
}

/**
 * Prove that this handle's connections really search `schema` first, by
 * asking the server. The schema is set as a startup parameter, and a
 * transaction- or statement-mode pooler in front of the database (PgBouncer
 * in those modes, RDS Proxy) either refuses that parameter or resets it
 * between transactions; every unqualified table name would then resolve to
 * `public`, and tenants would read each other's rows without a single
 * error. So a graph refuses to come up on a handle that lost its schema,
 * which is the failure an operator can see. Only session pooling is
 * supported in front of a process that serves several knowledge bases.
 */
export async function assertSearchPath(db: Pick<Database, 'execute'>, schema: string): Promise<void> {
  const result = await db.execute(sql`select current_schema() as schema`);
  const current = (result.rows[0] as { schema?: string } | undefined)?.schema ?? null;
  if (current !== schema) {
    throw new Error(
      `Database connections search "${current ?? '(none)'}" first, not the configured schema "${schema}". ` +
        'A transaction-mode pooler in front of Postgres drops the search_path startup parameter; ' +
        'use session pooling, or connect directly.',
    );
  }
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
  /**
   * The key this handle seals personal data with: the `SECRETS_ENC_KEY` of
   * the knowledge base whose rows it holds (its own derived one, for a
   * tenant). Without it the handle reads sealed values as their blobs and
   * refuses to write one — right for a handle that only touches tables with
   * no personal data, and a loud failure for one that was meant to have it.
   */
  piiKey?: string;
}

type QueryFn = (this: pg.Client, config?: unknown, values?: unknown, callback?: unknown) => unknown;
type ResultCallback = (err: unknown, result: unknown) => void;

/**
 * The `pg` client of a handle that holds `keys`: the one place personal data
 * changes form. Going in, every value a personal-data column marked (see
 * `column-crypto.ts`) is replaced by its ciphertext or its blind index.
 * Coming out, every sealed value of a result is opened — by its prefix, not
 * by its column, so raw SQL through the handle reads plaintext too; a
 * statement that needs what is STORED asks for it as bytes
 * (`convert_to(col, 'UTF8')`).
 *
 * At the client, because that is what the handle owns: the pool builds every
 * connection from this class, a transaction's included, so there is no path
 * from this handle to the database that goes round it. Results that are
 * streamed to a `Submittable` (a cursor) are not opened; nothing here uses one.
 */
function keyedClient(keys: PiiKeys | null): typeof pg.Client {
  const stored = (value: unknown): unknown => {
    if (!(value instanceof PiiParam)) return value;
    return keys ? value.stored(keys) : value.toPostgres();
  };
  const openCell = (value: unknown): unknown =>
    typeof value === 'string' && value.startsWith(PII_CIPHERTEXT_PREFIX) ? keys!.read(value) : value;
  const openOne = (result: unknown): void => {
    const rows = (result as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (Array.isArray(row)) {
        for (let i = 0; i < row.length; i++) row[i] = openCell(row[i]);
      } else if (row && typeof row === 'object') {
        const record = row as Record<string, unknown>;
        for (const column of Object.keys(record)) record[column] = openCell(record[column]);
      }
    }
  };
  const open = <T,>(result: T): T => {
    if (!keys) return result;
    // Several statements in one query string come back as several results.
    if (Array.isArray(result)) result.forEach(openOne);
    else openOne(result);
    return result;
  };

  const base = pg.Client.prototype.query as unknown as QueryFn;
  class KeyedClient extends pg.Client {}
  const query: QueryFn = function (config, values, callback) {
    if (typeof values === 'function') {
      callback = values;
      values = undefined;
    }
    if (Array.isArray(values)) {
      values = values.map(stored);
    } else if (config && typeof config === 'object' && Array.isArray((config as { values?: unknown }).values)) {
      const withValues = config as { values: unknown[]; submit?: unknown };
      if (typeof withValues.submit === 'function') withValues.values = withValues.values.map(stored);
      else config = { ...withValues, values: withValues.values.map(stored) };
    }
    if (typeof callback === 'function') {
      const done = callback as ResultCallback;
      return base.call(this, config, values, (err: unknown, result: unknown) => done(err, err ? result : open(result)));
    }
    const pending = base.call(this, config, values);
    return pending instanceof Promise ? pending.then(open) : pending;
  };
  Object.defineProperty(KeyedClient.prototype, 'query', { value: query, writable: true, configurable: true });
  return KeyedClient;
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
  // Only an ABSENT key means "this handle holds none". A blank or malformed
  // one was meant to be a key, and is refused here rather than read as none.
  const keys = opts.piiKey === undefined ? null : derivePiiKeys(opts.piiKey);
  const pool = new pg.Pool({
    Client: keyedClient(keys),
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
  if (keys) piiKeys.set(db, { keys, of: opts.piiKey! });
  return db;
}

export type Database = ReturnType<typeof createDb>;

/** The schema a database handle searches first — for the callers that name it in DDL. */
export function dbSchemaOf(db: Pick<Database, '$client'>): string {
  return schemas.get(db as Database) ?? DEFAULT_DB_SCHEMA;
}

/**
 * The keys a handle seals personal data with — for the few callers that
 * handle the stored form themselves (the backfill at start; an overlay's own
 * SQL). Everything else never sees a key: the column types and the handle's
 * connection do the work. Throws for a handle built without one.
 */
export function piiKeysOf(db: Pick<Database, '$client'>): PiiKeys {
  const held = piiKeys.get(db as Database);
  if (!held) {
    throw new Error('This database handle holds no personal-data key: build it with createDb/getDb and its piiKey.');
  }
  return held.keys;
}

const schemas = new WeakMap<Database, string>();
const piiKeys = new WeakMap<Database, { keys: PiiKeys; of: string }>();
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
  } else if (opts.piiKey !== undefined && piiKeys.get(db)?.of !== opts.piiKey) {
    // One schema is one knowledge base and one key. Handing back the cached
    // pool would seal this caller's rows under the other caller's key.
    throw new Error(`The database handle for schema "${dbSchema}" is already open with a different personal-data key.`);
  }
  return db;
}

/**
 * End a handle's pool and forget it, so a later {@link getDb} for the same
 * schema opens a fresh one rather than handing out a pool that was ended.
 * The last step of stopping a knowledge base's graph.
 */
export async function closeDb(db: Pick<Database, '$client'>): Promise<void> {
  for (const [key, cached] of cache) {
    if (cached === db) cache.delete(key);
  }
  await db.$client.end();
}
