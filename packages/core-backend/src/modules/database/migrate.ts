import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './connection.js';
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
 */

/** Apply the CORE migration history from `folder`, tracked in `__drizzle_migrations_core`. */
export async function runCoreMigrations(db: Database, folder: string): Promise<void> {
  console.log('Running core database migrations...');
  await migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations_core' });
  console.log('Core migrations complete.');
}

/**
 * Apply the ENTERPRISE migration history from `folder`, tracked in
 * `__drizzle_migrations_enterprise`. Run AFTER {@link runCoreMigrations} —
 * enterprise tables FK into core tables.
 */
export async function runEnterpriseMigrations(db: Database, folder: string): Promise<void> {
  console.log('Running enterprise database migrations...');
  await migrate(db, { migrationsFolder: folder, migrationsTable: '__drizzle_migrations_enterprise' });
  console.log('Enterprise migrations complete.');
}

/*
 * ── PII column encryption backfill ──────────────────────────────────────────
 *
 * Migration 0005 adds the `*_bidx` columns; the DATA change — rewriting
 * pre-existing plaintext PII to AES-256-GCM ciphertext and filling the blind
 * indexes — happens here, programmatically, because it needs the key from the
 * environment (SQL migrations cannot encrypt). Runs on every boot right after
 * `runCoreMigrations` and is idempotent: sealed rows carry the
 * `PII_CIPHERTEXT_PREFIX` marker and are excluded by the SELECT's own WHERE
 * clause, so a completed backfill degenerates to one cheap, empty-result
 * query per table.
 *
 * Concurrency: the whole pass runs in ONE transaction that opens by taking
 * `pg_advisory_xact_lock` on a constant key, so two instances booting at once
 * serialize instead of interleaving. Each UPDATE is also compare-and-swap —
 * the WHERE clause pins every value the row was read with — so a writer that
 * slips in between the scan and the write (an old-version instance in a
 * mixed-version window) loses nothing: the CAS update matches zero rows and
 * the next boot's pass seals whatever that writer left behind. Deployments
 * should still stop the old app before starting the new one (see
 * UPGRADING.md); the lock and CAS make the failure mode of not doing so
 * "unsealed until next boot", never "silently overwritten".
 *
 * Once every row is sealed, the same transaction applies the constraints that
 * could not ship in the SQL migration: SET NOT NULL on the bidx columns and
 * the unique-index swap (`users_email_unique` on the now-randomized
 * ciphertext is meaningless, `users_email_bidx_unq` takes over; same for
 * `pr_file_approvals_unq` → `pr_file_approvals_bidx_unq`). The new unique
 * index goes up BEFORE the old one is dropped so duplicate protection never
 * has a gap. Legacy rows that collide under the normalized blind index are
 * handled first: duplicate approval rows (same logical approval, case-variant
 * email) are collapsed; duplicate USERS are a genuine account conflict and
 * abort the boot with the row ids so an operator can merge them deliberately.
 * All statements are IF-EXISTS-guarded — re-running is a no-op.
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
];

const ident = (name: string) => sql.raw(`"${name}"`);

/** What the backfill needs from a drizzle client — the db or a transaction. */
type Executor = Pick<Database, 'execute'>;

/**
 * Constant key for `pg_advisory_xact_lock` serializing concurrent backfills.
 * Arbitrary but stable — never reuse it for another lock.
 */
const PII_BACKFILL_LOCK_KEY = 7_458_392_017;

/** A column "needs sealing" when it holds non-empty text without the prefix. */
function needsSealing(col: string) {
  return sql`(${ident(col)} IS NOT NULL AND ${ident(col)} <> '' AND ${ident(col)} NOT LIKE ${`${PII_CIPHERTEXT_PREFIX}%`})`;
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
      // blind index is always computed over the plaintext.
      const source = row[t.bidx.source];
      const plain = typeof source === 'string' ? decryptPii(source) : '';
      sets.push(sql`${ident(t.bidx.column)} = ${blindIndex(plain)}`);
      where.push(sql`${ident(t.bidx.column)} IS NULL`);
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
 * the unique-index creation below would abort the boot. Approval rows are the
 * same logical approval — collapse them, keeping the earliest. Colliding USER
 * rows are distinct accounts; refuse loudly with the ids so an operator
 * resolves the conflict deliberately instead of the upgrade guessing.
 */
async function resolveBidxCollisions(tx: Executor): Promise<void> {
  await tx.execute(sql.raw(`
    DELETE FROM "pr_file_approvals" a USING "pr_file_approvals" b
    WHERE a."pr_number" = b."pr_number" AND a."path" = b."path"
      AND a."approver_email_bidx" = b."approver_email_bidx" AND a."head_sha" = b."head_sha"
      AND (a."approved_at" > b."approved_at" OR (a."approved_at" = b."approved_at" AND a."id" > b."id"))
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
];

/**
 * Encrypt pre-existing plaintext PII rows, fill the blind-index columns, and
 * apply the constraints migration 0005 deferred. Idempotent; run on every
 * boot immediately after {@link runCoreMigrations}. Requires
 * `initColumnCrypto` to have run (CoreConfig's constructor does).
 */
export async function runPiiEncryptionBackfill(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    // One backfill at a time, released at commit/rollback. Transaction-scoped
    // (not session-scoped) because the pool hands each statement its own
    // connection outside a transaction.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(PII_BACKFILL_LOCK_KEY))})`);
    let rewritten = 0;
    for (const t of PII_BACKFILL_TABLES) {
      rewritten += await backfillTable(tx, t);
    }
    if (rewritten > 0) console.log(`PII encryption backfill: rewrote ${rewritten} row(s).`);
    await resolveBidxCollisions(tx);
    for (const statement of PII_FINALIZE_STATEMENTS) {
      await tx.execute(sql.raw(statement));
    }
  });
}
