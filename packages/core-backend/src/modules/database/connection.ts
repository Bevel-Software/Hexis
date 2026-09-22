import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb(databaseUrl: string) {
  if (!db) {
    // A bounded handshake: `pg` waits forever by default for a NEW connection
    // to come up, so a database that accepts the socket and never finishes
    // the handshake would hold a boot (the migration lock is the first thing
    // that asks) with nothing to say and nothing for the restart policy to
    // see. Half a minute is generous for a handshake and short enough for a
    // failed boot to be visible. It bounds only that: a checkout queued
    // behind a saturated pool, or a query on a connection that stopped
    // answering, is the caller's to bound — the advisory lock does.
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 30_000 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export type Database = ReturnType<typeof getDb>;
