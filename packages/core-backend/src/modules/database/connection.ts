import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb(databaseUrl: string) {
  if (!db) {
    // A bounded checkout: `pg` waits for a connection forever by default, so
    // a database that accepts the socket and never finishes the handshake —
    // or a pool that cannot hand a client back — would hold a boot (the
    // migration lock is the first thing that asks) with nothing to say and
    // nothing for the restart policy to see. Half a minute is generous for a
    // handshake and short enough for a failed boot to be visible.
    const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 30_000 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export type Database = ReturnType<typeof getDb>;
