import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { Database } from '../database/connection.js';
import { users } from '../database/core-schema.js';

/**
 * Synthetic identity for the synced-groups materializer's commits: every
 * `synced-groups.yaml` regeneration lands attributed to this bot, so the git
 * history reads as "the system mirrored the IdP", never as any human.
 * Same `<role>-bot@<host>` convention (and race-safe ensure shape) as the
 * recovery bot.
 */

export const DIRECTORY_SYNC_BOT_EMAIL = (
  process.env.DIRECTORY_SYNC_BOT_EMAIL ?? 'directory-sync@bevel.local'
).toLowerCase();

export const DIRECTORY_SYNC_BOT_NAME = 'Directory Sync Bot';

export async function ensureDirectorySyncBot(db: Database): Promise<AuthUser> {
  const inserted = await db
    .insert(users)
    .values({ email: DIRECTORY_SYNC_BOT_EMAIL, name: DIRECTORY_SYNC_BOT_NAME })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted.length > 0) {
    const row = inserted[0];
    console.log(`[directory-sync] created sync-bot user id=${row.id} email=${row.email}`);
    return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl ?? undefined };
  }
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, DIRECTORY_SYNC_BOT_EMAIL))
    .limit(1);
  if (!row) {
    throw new Error(
      `directory-sync bot (${DIRECTORY_SYNC_BOT_EMAIL}) disappeared between insert-conflict and re-select`,
    );
  }
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl ?? undefined };
}
