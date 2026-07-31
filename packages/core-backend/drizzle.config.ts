import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Generates the CORE migration history from the core schema slice into the
// packaged `migrations/` folder (shipped in `files`; applied at boot via
// `runCoreMigrations(db, coreMigrationsDir())`, tracked in
// `__drizzle_migrations_core`).
export default defineConfig({
  schema: './src/modules/database/core-schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://bevel:bevel@localhost:5432/bevel',
  },
});
