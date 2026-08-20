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

// Trimmed BEFORE the empty-fallback so a whitespace-only override falls back,
// and so the constant always compares equal to a trimmed caller email (the
// machine-owned write rule trims the caller's side).
export const DIRECTORY_SYNC_BOT_EMAIL = (
  process.env.DIRECTORY_SYNC_BOT_EMAIL?.trim() || 'directory-sync@bevel.local'
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
  // The bot's IDENTITY is its email: the machine-owned write rule on
  // synced-groups.yaml authorizes by DIRECTORY_SYNC_BOT_EMAIL alone. If the
  // email already belongs to a pre-existing HUMAN account (a person signed up
  // with it, or the override points at someone's address), silently binding
  // the materializer to that row would attribute every sync commit to them —
  // and, worse, hand their interactive session the bot's exclusive write
  // authority. The bot row is only ever created by this function with
  // DIRECTORY_SYNC_BOT_NAME, so a row under this email with any other name is
  // NOT the bot: refuse loudly instead of adopting it.
  if (row.name !== DIRECTORY_SYNC_BOT_NAME) {
    throw new Error(
      `directory-sync bot email ${DIRECTORY_SYNC_BOT_EMAIL} already belongs to an existing account ` +
        `('${row.name}', id=${row.id}) that is not the sync bot — refusing to bind the materializer ` +
        `to it. Set DIRECTORY_SYNC_BOT_EMAIL to an address no person uses.`,
    );
  }
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl ?? undefined };
}
