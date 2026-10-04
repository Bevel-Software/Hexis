import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { logger } from '../../shared/logging.js';

const log = logger('database');
import { DEFAULT_DB_SCHEMA, dbSchemaOf, piiKeysOf, type Database } from './connection.js';
import { AdvisoryLock, withAdvisoryLock } from './advisory-lock.js';
import { PII_SEALED_SHAPE_SQL_REGEX, isEncryptedBlob, type PiiKeys } from '../../shared/column-crypto.js';

/*
 * ── Per-tier migration folders ──────────────────────────────────────────────
 *
 * The schema is split into a CORE slice (this package's `core-schema.ts`,
 * migration history in the packaged `migrations/` folder — see
 * `coreMigrationsDir()` in `src/assets.ts`) and an optional ENTERPRISE slice
 * maintained by the consuming product. Each history has its OWN drizzle
 * tracking table (`migrationsTable`) so the two advance independently:
 *
 *   - `__drizzle_migrations_core`       — applied core migrations
 *   - `__drizzle_migrations_enterprise` — applied enterprise migrations
 *
 * Run core BEFORE enterprise on every boot — enterprise tables FK into core
 * tables (`users`, `api_tokens`). The core init migration is written to be
 * IDEMPOTENT (`CREATE TABLE IF NOT EXISTS` + guarded DO-blocks) so a database
 * that predates the split (tables created by a legacy single-folder history)
 * no-ops instead of failing.
 *
 * Note: drizzle-orm's node-postgres `migrate()` accepts `migrationsTable` (and
 * `migrationsSchema`) in the installed version (0.45.x) — see
 * `drizzle-orm/migrator.d.ts` (`MigrationConfig`).
 *
 * BOTH RUNNERS TAKE AN ADVISORY LOCK. Drizzle's migrator takes none of its own:
 * it reads the newest applied migration, then opens a transaction and applies
 * everything newer — so two processes booting at once read the same watermark
 * and both apply. The idempotence described above covers a RE-run, which is a
 * different thing from a CONCURRENT one, and it only covers the init migration
 * anyway; 0002 onward are plain DDL, where the second process fails on an
 * already-applied `ALTER TABLE` and crash-loops. Two processes booting at once
 * is not hypothetical here — it is every redeploy, for as long as the outgoing
 * container takes to exit. See `advisory-lock.ts` for the mechanism.
 */

/**
 * Where a handle's migration ledger lives, and which lock guards its runs.
 *
 * The default schema keeps drizzle's own `drizzle` schema for the ledger,
 * where every existing deployment already has one: naming `public` here
 * would make the next boot read an empty ledger and re-apply plain DDL that
 * is already applied. A knowledge base on a schema of its own keeps its
 * ledger IN that schema, so the schema is the whole of the tenant: what
 * `pg_dump -n` carries out includes what has been applied to it, and the
 * dedicated deployment it is restored into resumes from there rather than
 * from nothing. The lock is keyed the same way, so two tenants of one
 * database migrate side by side while two processes of one tenant still
 * take turns.
 */
function ledgerOptions(db: Database): { migrationsSchema?: string; tenantKey: string } {
  const schema = dbSchemaOf(db);
  return schema === DEFAULT_DB_SCHEMA
    ? { tenantKey: '' }
    : { migrationsSchema: schema, tenantKey: schema };
}

/** Apply the CORE migration history from `folder`, tracked in `__drizzle_migrations_core`. */
export async function runCoreMigrations(db: Database, folder: string): Promise<void> {
  const { migrationsSchema, tenantKey } = ledgerOptions(db);
  await withAdvisoryLock(
    db,
    AdvisoryLock.Migrations,
    async () => {
      log.info('Running core database migrations...');
      await migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations_core', migrationsSchema });
      log.info('Core migrations complete.');
      // Under the same lock, before anything reads or writes a PII column:
      // the data half of migration 0016, which SQL cannot do (see below).
      await runPiiEncryptionBackfill(db);
    },
    { tenantKey },
  );
}

/**
 * Apply the ENTERPRISE migration history from `folder`, tracked in
 * `__drizzle_migrations_enterprise`. Run AFTER {@link runCoreMigrations} —
 * enterprise tables FK into core tables.
 */
export async function runEnterpriseMigrations(db: Database, folder: string): Promise<void> {
  const { migrationsSchema, tenantKey } = ledgerOptions(db);
  await withAdvisoryLock(
    db,
    AdvisoryLock.Migrations,
    async () => {
      log.info('Running enterprise database migrations...');
      await migrate(db, {
        migrationsFolder: folder,
        migrationsTable: '__drizzle_migrations_enterprise',
        migrationsSchema,
      });
      log.info('Enterprise migrations complete.');
    },
    { tenantKey },
  );
}

/*
 * ── PII column encryption backfill ──────────────────────────────────────────
 *
 * Migration 0016 adds the `*_bidx` columns; the DATA change — rewriting
 * pre-existing plaintext PII to AES-256-GCM ciphertext and filling the blind
 * indexes — happens here, programmatically, because it needs the key the
 * handle holds (SQL migrations cannot encrypt). Runs on every start right after
 * the core history, under the migrations lock, and is idempotent: sealed rows
 * carry the `PII_CIPHERTEXT_PREFIX` marker and are excluded by the SELECT's
 * own WHERE clause, so a completed backfill degenerates to one cheap,
 * empty-result query per table.
 *
 * Concurrency: the migrations lock (keyed per tenant, like the history it
 * guards) serialises two processes booting at once. Each UPDATE is also
 * compare-and-swap — the WHERE clause pins every value the row was read with
 * — so a writer that slips in between the scan and the write (an old-version
 * instance in a mixed-version window) loses nothing: the CAS update matches
 * zero rows and the next start's pass seals whatever that writer left
 * behind. Deployments should still stop the old app before starting the new
 * one (see UPGRADING.md); the lock and CAS make the failure mode of not doing
 * so "unsealed until next start", never "silently overwritten".
 *
 * Once every row is sealed, the same transaction applies the constraints that
 * could not ship in the SQL migration: SET NOT NULL on the bidx columns and
 * the unique-index swaps (`users_email_unique` on the now-randomized
 * ciphertext is meaningless, `users_email_bidx_unq` takes over; the same for
 * the approvals and the join requests). The new unique index goes up BEFORE
 * the old one is dropped so duplicate protection never has a gap. Legacy rows
 * that collide under the normalized blind index are handled first: duplicate
 * approval and join-request rows (the same logical row, a case-variant email)
 * are collapsed; duplicate USERS are a genuine account conflict and abort the
 * start with the row ids so an operator can merge them deliberately. All
 * statements are IF-EXISTS-guarded — re-running is a no-op.
 *
 * Runs against whatever schema the handle searches first: a tenant's own, or
 * `public`, under that handle's key. Every table name is unqualified for that
 * reason.
 *
 * This is the one place that works on the STORED form. The handle's
 * connection opens every sealed value of a result, which here would hide
 * exactly what has to be told apart — so the columns are read as bytes
 * ({@link asStored}), which it leaves alone, and written as ready-made
 * ciphertext, which it passes through.
 */

interface PiiBackfillTable {
  table: string;
  /** Columns that uniquely identify a row for the write-back UPDATE. */
  key: string[];
  /** Columns whose plaintext values get rewritten as ciphertext. */
  encrypted: string[];
  /** Blind-index column to fill from the plaintext of `source`. */
  bidx?: { source: string; column: string };
}

const PII_BACKFILL_TABLES: PiiBackfillTable[] = [
  { table: 'users', key: ['id'], encrypted: ['email', 'name', 'avatar_url'], bidx: { source: 'email', column: 'email_bidx' } },
  { table: 'pr_file_approvals', key: ['id'], encrypted: ['approver_email', 'approver_name'], bidx: { source: 'approver_email', column: 'approver_email_bidx' } },
  { table: 'pr_merge_log', key: ['id'], encrypted: ['triggered_by_email', 'triggered_by_name', 'error'], bidx: { source: 'triggered_by_email', column: 'triggered_by_email_bidx' } },
  { table: 'pr_comments', key: ['id'], encrypted: ['author_email', 'author_name', 'body'], bidx: { source: 'author_email', column: 'author_email_bidx' } },
  { table: 'change_requests', key: ['id'], encrypted: ['author_email', 'author_name', 'title', 'body', 'apply_failure_reason', 'apply_failed_by_name'], bidx: { source: 'author_email', column: 'author_email_bidx' } },
  { table: 'pending_commits', key: ['id'], encrypted: ['author_email', 'author_name', 'last_error'], bidx: { source: 'author_email', column: 'author_email_bidx' } },
  { table: 'file_locks', key: ['workspace_id', 'branch', 'path'], encrypted: ['holder_name'] },
  { table: 'plugin_join_requests', key: ['id'], encrypted: ['requester_email', 'requester_name', 'failure_reason'], bidx: { source: 'requester_email', column: 'requester_email_bidx' } },
];

const ident = (name: string) => sql.raw(`"${name}"`);

/** What the backfill needs from a drizzle client — the db or a transaction. */
type Executor = Pick<Database, 'execute'>;

/** A text column as it is stored: bytes, so the handle's connection does not open it. */
const asStored = (col: string) => sql`convert_to(${ident(col)}, 'UTF8') AS ${ident(col)}`;

/** What {@link asStored} selected, back as text; anything else as it came. */
const storedText = (value: unknown): unknown => (Buffer.isBuffer(value) ? value.toString('utf8') : value);

/**
 * A column "needs sealing" when it holds non-empty text that isn't a blob.
 * The shape regex is deliberately used as a NEGATIVE filter: anything failing
 * it — including plaintext that merely BEGINS with the prefix — is selected
 * and re-examined app-side by `isEncryptedBlob`, so only values byte-for-byte
 * indistinguishable from a well-formed blob are trusted as sealed. Sealed rows
 * all match, keeping the steady-state scan an empty-result query.
 */
function needsSealing(col: string) {
  return sql`(${ident(col)} IS NOT NULL AND ${ident(col)} <> '' AND ${ident(col)} !~ ${PII_SEALED_SHAPE_SQL_REGEX})`;
}

/**
 * The configured key must open what earlier starts sealed. A rotated or
 * mistyped `SECRETS_ENC_KEY` would otherwise go unnoticed here — sealed rows
 * are exactly the ones the scan skips — and surface only as every login
 * failing and every lookup by email missing, because the blind indexes would
 * be computed under the new key. One sealed value per table is enough: all
 * rows of a deployment are sealed under one key. Refusing the start is the
 * loud failure; re-keying a database is a deliberate operation, not a boot.
 */
async function assertKeyOpensSealedRows(tx: Executor, keys: PiiKeys): Promise<void> {
  for (const t of PII_BACKFILL_TABLES) {
    const col = t.bidx?.source ?? t.encrypted[0]!;
    const sample = await tx.execute(
      sql`SELECT ${asStored(col)} FROM ${ident(t.table)} WHERE ${ident(col)} ~ ${PII_SEALED_SHAPE_SQL_REGEX} LIMIT 1`,
    );
    const value = storedText((sample.rows[0] as Record<string, unknown> | undefined)?.[col]);
    if (typeof value === 'string' && !keys.open(value).ok) {
      throw new Error(
        `PII encryption: ${t.table}.${col} is sealed with a key the configured SECRETS_ENC_KEY ` +
          '(for a tenant: the one derived from TENANT_MASTER_KEY) does not open — refusing to start. ' +
          'Restore the key that sealed it; changing the key is a re-keying of the database, not a configuration change.',
      );
    }
  }
}

async function backfillTable(tx: Executor, keys: PiiKeys, t: PiiBackfillTable): Promise<number> {
  const cols = [...t.key.map(ident), ...t.encrypted.map(asStored), ...(t.bidx ? [ident(t.bidx.column)] : [])];
  // Only rows with work left: the ciphertext prefix makes "unsealed" a plain
  // SQL predicate, so a fully-sealed table costs one empty-result query.
  const pending = [
    ...t.encrypted.map(needsSealing),
    ...(t.bidx ? [sql`${ident(t.bidx.column)} IS NULL`] : []),
  ];
  const result = await tx.execute(
    sql`SELECT ${sql.join(cols, sql`, `)} FROM ${ident(t.table)} WHERE ${sql.join(pending, sql` OR `)}`,
  );
  let rewritten = 0;
  for (const read of result.rows as Array<Record<string, unknown>>) {
    const row = Object.fromEntries(Object.entries(read).map(([col, value]) => [col, storedText(value)]));
    const sets = [];
    // Compare-and-swap: pin every value this row was read with, so a write
    // that lands between scan and update makes this UPDATE match zero rows
    // instead of clobbering the newer value.
    const where = t.key.map((k) => sql`${ident(k)} = ${row[k]}`);
    for (const col of t.encrypted) {
      const value = row[col];
      if (typeof value === 'string' && value !== '' && !isEncryptedBlob(value)) {
        sets.push(sql`${ident(col)} = ${keys.seal(value)}`);
        where.push(sql`${ident(col)} = ${value}`);
      }
    }
    if (t.bidx) {
      // The blind index is derived from its source, so it is (re)computed
      // whenever the source is being sealed in this pass — a legacy writer
      // that put a NEW plaintext email on an already-indexed row left a stale
      // index behind, and sealing the email alone would freeze that mismatch
      // — and whenever it was never filled. The source may already be
      // ciphertext (a partial earlier run); the index is always computed
      // over the plaintext, never over a blob the key cannot open.
      const source = row[t.bidx.source];
      const stored = row[t.bidx.column];
      const sealingSource = typeof source === 'string' && source !== '' && !isEncryptedBlob(source);
      if (sealingSource || stored == null) {
        const opened = keys.open(typeof source === 'string' ? source : '');
        if (!opened.ok) {
          throw new Error(
            `PII encryption backfill: ${t.table}.${t.bidx.source} cannot be decrypted with the ` +
              'configured SECRETS_ENC_KEY — refusing to derive a blind index from ciphertext. ' +
              'Restore the key that sealed it, then restart.',
          );
        }
        sets.push(sql`${ident(t.bidx.column)} = ${keys.index(opened.plain)}`);
        // Pin the index AND its source: if a concurrent writer replaces the
        // email between scan and write, the CAS must not attach the OLD
        // email's blind index to the NEW value.
        where.push(sql`${ident(t.bidx.column)} IS NOT DISTINCT FROM ${stored ?? null}`);
        where.push(sql`${ident(t.bidx.source)} IS NOT DISTINCT FROM ${source ?? null}`);
      }
    }
    if (sets.length === 0) continue;
    const updated = await tx.execute(
      sql`UPDATE ${ident(t.table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(where, sql` AND `)}`,
    );
    rewritten += updated.rowCount ?? 0;
  }
  return rewritten;
}

/**
 * Legacy uniqueness was on the RAW email, so rows differing only by case or
 * whitespace could coexist; under the normalized blind index they collide and
 * the unique-index creation below would abort the start. Approval rows and
 * join-request rows are the same logical row — collapse them, keeping the
 * earliest. Colliding USER rows are distinct accounts; refuse loudly with the
 * ids so an operator resolves the conflict deliberately instead of the
 * upgrade guessing.
 */
async function resolveBidxCollisions(tx: Executor): Promise<void> {
  await tx.execute(sql.raw(`
    DELETE FROM "pr_file_approvals" a USING "pr_file_approvals" b
    WHERE a."pr_number" = b."pr_number" AND a."path" = b."path"
      AND a."approver_email_bidx" = b."approver_email_bidx" AND a."head_sha" = b."head_sha"
      AND (a."approved_at" > b."approved_at" OR (a."approved_at" = b."approved_at" AND a."id" > b."id"))
  `));
  await tx.execute(sql.raw(`
    DELETE FROM "plugin_join_requests" a USING "plugin_join_requests" b
    WHERE a."plugin_key" = b."plugin_key" AND a."requester_email_bidx" = b."requester_email_bidx"
      AND (a."created_at" > b."created_at" OR (a."created_at" = b."created_at" AND a."id" > b."id"))
  `));
  const dupes = await tx.execute(sql.raw(`
    SELECT array_agg("id") AS ids FROM "users" GROUP BY "email_bidx" HAVING count(*) > 1
  `));
  if (dupes.rows.length > 0) {
    const groups = (dupes.rows as Array<{ ids: string[] }>).map((r) => r.ids.join(', '));
    throw new Error(
      'PII encryption backfill: multiple user rows share the same email after normalization ' +
        '(case/whitespace variants of one address). Merge or delete the duplicates, then restart. ' +
        `Conflicting user ids: [${groups.join('], [')}]`,
    );
  }
}

const PII_FINALIZE_STATEMENTS = [
  'ALTER TABLE "users" ALTER COLUMN "email_bidx" SET NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_bidx_unq" ON "users" ("email_bidx")',
  'ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique"',
  'ALTER TABLE "pr_file_approvals" ALTER COLUMN "approver_email_bidx" SET NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "pr_file_approvals_bidx_unq" ON "pr_file_approvals" ("pr_number","path","approver_email_bidx","head_sha")',
  'DROP INDEX IF EXISTS "pr_file_approvals_unq"',
  'ALTER TABLE "pr_merge_log" ALTER COLUMN "triggered_by_email_bidx" SET NOT NULL',
  'ALTER TABLE "pr_comments" ALTER COLUMN "author_email_bidx" SET NOT NULL',
  'ALTER TABLE "change_requests" ALTER COLUMN "author_email_bidx" SET NOT NULL',
  'ALTER TABLE "pending_commits" ALTER COLUMN "author_email_bidx" SET NOT NULL',
  'ALTER TABLE "plugin_join_requests" ALTER COLUMN "requester_email_bidx" SET NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "plugin_join_requests_requester_bidx_plugin_unq" ON "plugin_join_requests" ("requester_email_bidx","plugin_key")',
  'DROP INDEX IF EXISTS "plugin_join_requests_requester_plugin_unq"',
];

/**
 * Encrypt pre-existing plaintext PII rows, fill the blind-index columns, and
 * apply the constraints migration 0016 deferred. Idempotent; `runCoreMigrations`
 * runs it under the migrations lock right after the history. The handle must
 * hold the knowledge base's key (`createDb(url, { piiKey })`; the composition
 * root's does): one that holds none is refused before anything is read.
 */
export async function runPiiEncryptionBackfill(db: Database): Promise<void> {
  const keys = piiKeysOf(db);
  await db.transaction(async (tx) => {
    await assertKeyOpensSealedRows(tx, keys);
    let rewritten = 0;
    for (const t of PII_BACKFILL_TABLES) {
      rewritten += await backfillTable(tx, keys, t);
    }
    if (rewritten > 0) log.info(`PII encryption backfill: rewrote ${rewritten} row(s).`);
    await resolveBidxCollisions(tx);
    for (const statement of PII_FINALIZE_STATEMENTS) {
      await tx.execute(sql.raw(statement));
    }
  });
}
