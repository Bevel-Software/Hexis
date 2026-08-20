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
  // authority. The users schema carries no dedicated bot/provenance column,
  // so adoption gates on the strongest invariants the row can carry:
  //   1. NO PASSWORD. The bot is only ever created by this function, without
  //      credentials, and never signs in — nothing legitimate ever provisions
  //      it a password. A row with a password hash is a login-capable account
  //      (a person, or a credential a person could use) no matter what its
  //      display name says, so the hash is the hard evidence a name can't be.
  //   2. THE EXPECTED NAME. A display name is mutable and a human account
  //      could carry the bot's name (e.g. an SSO service account), so this is
  //      only a tripwire — it still catches password-less human rows created
  //      under their real names.
  // A password-less SSO account that also mimics the bot's exact display name
  // is indistinguishable at this layer; that shape only arises from the
  // operator deliberately configuring it. Refuse loudly instead of adopting.
  if (row.passwordHash !== null || row.name !== DIRECTORY_SYNC_BOT_NAME) {
    const evidence =
      row.passwordHash !== null
        ? `it can sign in with a password (name '${row.name}')`
        : `its name is '${row.name}'`;
    throw new Error(
      `directory-sync bot email ${DIRECTORY_SYNC_BOT_EMAIL} already belongs to an existing account ` +
        `(id=${row.id}) that is not the sync bot — ${evidence}. Refusing to bind the materializer ` +
        `to it. Set DIRECTORY_SYNC_BOT_EMAIL to an address no person uses.`,
    );
  }
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl ?? undefined };
}
