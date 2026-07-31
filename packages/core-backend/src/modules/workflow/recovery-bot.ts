/**
 * Synthetic user identity the pending-commits pipeline uses for:
 *
 *   1. The recovery agent's commit authorship — when the background
 *      agent resolves a non-FF conflict and lands a resolution commit,
 *      that commit needs an author. The recovery bot is a stable
 *      attribution that's clearly "the system" rather than any human.
 *   2. The `'system'` feedback notice's `user_id` FK — feedback
 *      submissions reference `users(id)`, so we need a real row.
 *   3. The startup-sweep enqueue of orphaned dirty files — those have
 *      no recoverable original author, and the recovery bot fits the
 *      "this is the system reconciling state" framing.
 *
 * Email convention mirrors the routine-bot pattern (`<role>-bot@<host>`)
 * so admins can tell at a glance what an automation account is for. The
 * `RECOVERY_BOT_EMAIL` env override mirrors `ROUTINE_BOT_EMAIL`.
 */

import { eq } from 'drizzle-orm';
import type { AuthUser } from '@bevel-software/shared';
import type { Database } from '../database/connection.js';
import { users } from '../database/schema.js';

export const RECOVERY_BOT_EMAIL = (
  process.env.RECOVERY_BOT_EMAIL ?? 'recovery-bot@bevel.local'
).toLowerCase();

export const RECOVERY_BOT_NAME = 'Bevel Recovery Bot';

/**
 * Idempotent ensure-or-fetch of the recovery-bot user row. Modelled on
 * `RoutineRunnerService.ensureBotUser` — same race-safe shape via
 * `onConflictDoNothing` + re-select.
 *
 * Called once at composition-root boot; the resolved `AuthUser` is then
 * cached for the lifetime of the process (the row never changes).
 */
export async function ensureRecoveryBotUser(db: Database): Promise<AuthUser> {
  const inserted = await db
    .insert(users)
    .values({ email: RECOVERY_BOT_EMAIL, name: RECOVERY_BOT_NAME })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted.length > 0) {
    const row = inserted[0];
    console.log(`[pending-commits] created recovery-bot user id=${row.id} email=${row.email}`);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatarUrl ?? undefined,
    };
  }
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, RECOVERY_BOT_EMAIL))
    .limit(1);
  if (!row) {
    // Vanishingly unlikely: the row exists for the conflict to fire but is
    // gone by the time we re-select. Surface loudly rather than crashing
    // on `row.id` below.
    throw new Error(
      `recovery-bot user (${RECOVERY_BOT_EMAIL}) disappeared between insert-conflict and re-select`,
    );
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl ?? undefined,
  };
}
