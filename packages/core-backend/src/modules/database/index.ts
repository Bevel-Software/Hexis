/**
 * The database module's entry: the `Database` handle's type and the schema's
 * tables — contracts and leaf definitions only. Opening, migrating and closing
 * a connection is the composition root's business, so `connection.ts` and
 * `migrate.ts` stay out of it.
 */
export type { Database } from './connection.js';
export * from './schema.js';
