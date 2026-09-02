import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { Database } from './connection.js';
import { blindIndex, decryptPii, encryptPii, isEncryptedBlob } from '../../shared/column-crypto.js';

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
 * `runCoreMigrations` and is idempotent: ciphertext rows are recognised by
 * shape (`iv:tag:ct`) and skipped, so a completed backfill degenerates to one
 * read-only scan per table.
 *
 * Once every row is sealed, the same pass applies the constraints that could
 * not ship in the SQL migration: SET NOT NULL on the bidx columns and the
 * unique-index swap (`users_email_unique` on the now-randomized ciphertext is
 * meaningless, `users_email_bidx_unq` takes over; same for
 * `pr_file_approvals_unq` → `pr_file_approvals_bidx_unq`). The new unique
 * index goes up BEFORE the old one is dropped so duplicate protection never
 * has a gap. All statements are IF-EXISTS-guarded — re-running is a no-op.
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

async function backfillTable(db: Database, t: PiiBackfillTable): Promise<number> {
  const cols = [...t.key, ...t.encrypted, ...(t.bidx ? [t.bidx.column] : [])];
  const result = await db.execute(
    sql`SELECT ${sql.join(cols.map(ident), sql`, `)} FROM ${ident(t.table)}`,
  );
  let rewritten = 0;
  for (const row of result.rows as Array<Record<string, unknown>>) {
    const sets = [];
    for (const col of t.encrypted) {
      const value = row[col];
      if (typeof value === 'string' && value !== '' && !isEncryptedBlob(value)) {
        sets.push(sql`${ident(col)} = ${encryptPii(value)}`);
      }
    }
    if (t.bidx && row[t.bidx.column] == null) {
      // The source may already be ciphertext (a partial earlier run) — the
      // blind index is always computed over the plaintext.
      const source = row[t.bidx.source];
      const plain = typeof source === 'string' ? decryptPii(source) : '';
      sets.push(sql`${ident(t.bidx.column)} = ${blindIndex(plain)}`);
    }
    if (sets.length === 0) continue;
    const where = t.key.map((k) => sql`${ident(k)} = ${row[k]}`);
    await db.execute(
      sql`UPDATE ${ident(t.table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(where, sql` AND `)}`,
    );
    rewritten += 1;
  }
  return rewritten;
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
  let rewritten = 0;
  for (const t of PII_BACKFILL_TABLES) {
    rewritten += await backfillTable(db, t);
  }
  if (rewritten > 0) console.log(`PII encryption backfill: rewrote ${rewritten} row(s).`);
  for (const statement of PII_FINALIZE_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
