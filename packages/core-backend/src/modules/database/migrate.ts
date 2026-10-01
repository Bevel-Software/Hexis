import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { logger } from '../../shared/logging.js';

const log = logger('database');
import { DEFAULT_DB_SCHEMA, dbSchemaOf, type Database } from './connection.js';
import { AdvisoryLock, withAdvisoryLock } from './advisory-lock.js';
import { PII_CIPHERTEXT_PREFIX, blindIndex, decryptPii, encryptPii, isEncryptedBlob } from '../../shared/column-crypto.js';

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
      // the data half of migration 0014, which SQL cannot do (see below).
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
 * Migration 0014 adds the `*_bidx` columns; the DATA change — rewriting
 * pre-existing plaintext PII to AES-256-GCM ciphertext and filling the blind
 * indexes — happens here, programmatically, because it needs the key from the
 * environment (SQL migrations cannot encrypt). Runs on every start right after
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
 * `public`. Every table name is unqualified for that reason.
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
  { table: 'change_requests', key: ['id'], encrypted: ['author_email', 'author_name', 'title', 'body'], bidx: { source: 'author_email', column: 'author_email_bidx' } },
  { table: 'pending_commits', key: ['id'], encrypted: ['author_email', 'author_name', 'last_error'], bidx: { source: 'author_email', column: 'author_email_bidx' } },
  { table: 'file_locks', key: ['workspace_id', 'branch', 'path'], encrypted: ['holder_name'] },
  { table: 'plugin_join_requests', key: ['id'], encrypted: ['requester_email', 'requester_name', 'failure_reason'], bidx: { source: 'requester_email', column: 'requester_email_bidx' } },
];

const ident = (name: string) => sql.raw(`"${name}"`);

/** What the backfill needs from a drizzle client — the db or a transaction. */
type Executor = Pick<Database, 'execute'>;

/**
 * SQL approximation of `isEncryptedBlob`: the version prefix followed by
 * base64 segments with the exact widths GCM produces (12-byte IV → 16 chars,
 * 16-byte tag → 22 chars + `==`). Deliberately a NEGATIVE filter: anything
 * failing it — including plaintext that merely BEGINS with the prefix — is
 * selected and re-examined app-side by `isEncryptedBlob`, so only values
 * byte-for-byte indistinguishable from a well-formed blob are trusted as
 * sealed. Sealed rows all match, keeping the steady-state scan an
 * empty-result query.
 */
const SEALED_SHAPE_REGEX = `^${PII_CIPHERTEXT_PREFIX}[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]+={0,2}$`;

/** A column "needs sealing" when it holds non-empty text that isn't a blob. */
function needsSealing(col: string) {
  return sql`(${ident(col)} IS NOT NULL AND ${ident(col)} <> '' AND ${ident(col)} !~ ${SEALED_SHAPE_REGEX})`;
}

async function backfillTable(tx: Executor, t: PiiBackfillTable): Promise<number> {
  const cols = [...t.key, ...t.encrypted, ...(t.bidx ? [t.bidx.column] : [])];
  // Only rows with work left: the ciphertext prefix makes "unsealed" a plain
  // SQL predicate, so a fully-sealed table costs one empty-result query.
  const pending = [
    ...t.encrypted.map(needsSealing),
    ...(t.bidx ? [sql`${ident(t.bidx.column)} IS NULL`] : []),
  ];
  const result = await tx.execute(
    sql`SELECT ${sql.join(cols.map(ident), sql`, `)} FROM ${ident(t.table)} WHERE ${sql.join(pending, sql` OR `)}`,
  );
  let rewritten = 0;
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const sets = [];
    // Compare-and-swap: pin every value this row was read with, so a write
    // that lands between scan and update makes this UPDATE match zero rows
    // instead of clobbering the newer value.
    const where = t.key.map((k) => sql`${ident(k)} = ${row[k]}`);
    for (const col of t.encrypted) {
      const value = row[col];
      if (typeof value === 'string' && value !== '' && !isEncryptedBlob(value)) {
        sets.push(sql`${ident(col)} = ${encryptPii(value)}`);
        where.push(sql`${ident(col)} = ${value}`);
      }
    }
    if (t.bidx && row[t.bidx.column] == null) {
      // The source may already be ciphertext (a partial earlier run) — the
      // blind index is always computed over the plaintext. If the source is
      // ciphertext the configured key cannot open, refuse rather than derive
      // a blind index from ciphertext (it would never match a real lookup).
      const source = row[t.bidx.source];
      const raw = typeof source === 'string' ? source : '';
      const plain = decryptPii(raw);
      if (isEncryptedBlob(plain)) {
        throw new Error(
          `PII encryption backfill: ${t.table}.${t.bidx.source} cannot be decrypted with the ` +
            'configured SECRETS_ENC_KEY — refusing to derive a blind index from ciphertext. ' +
            'Restore the key that sealed it, then restart.',
        );
      }
      sets.push(sql`${ident(t.bidx.column)} = ${blindIndex(plain)}`);
      where.push(sql`${ident(t.bidx.column)} IS NULL`);
      // Pin the source too: if a concurrent writer replaces the email between
      // scan and write, the CAS must not attach the OLD email's blind index
      // to the NEW value.
      where.push(sql`${ident(t.bidx.source)} IS NOT DISTINCT FROM ${source ?? null}`);
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
 * apply the constraints migration 0014 deferred. Idempotent; `runCoreMigrations`
 * runs it under the migrations lock right after the history. Requires
 * `initColumnCrypto` to have run (CoreConfig's constructor and the tenant host
 * do).
 */
export async function runPiiEncryptionBackfill(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    let rewritten = 0;
    for (const t of PII_BACKFILL_TABLES) {
      rewritten += await backfillTable(tx, t);
    }
    if (rewritten > 0) log.info(`PII encryption backfill: rewrote ${rewritten} row(s).`);
    await resolveBidxCollisions(tx);
    for (const statement of PII_FINALIZE_STATEMENTS) {
      await tx.execute(sql.raw(statement));
    }
  });
}
