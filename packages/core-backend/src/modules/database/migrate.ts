import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { logger } from '../../shared/logging.js';

const log = logger('database');
import { DEFAULT_DB_SCHEMA, dbSchemaOf, type Database } from './connection.js';
import { AdvisoryLock, withAdvisoryLock } from './advisory-lock.js';

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
