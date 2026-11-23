import type { AuthUser } from '@bevel-software/platform-shared';
import type { ToolAuth } from './tool-auth.middleware.js';

/**
 * The account a tool credential acts as, as every surface that admits one
 * records it: the credential's own row and, for a connection made as a bot,
 * the person who made the connection beside it (`madeBy`), so what the call
 * writes, opens and merges names both. A maker that cannot be loaded refuses
 * the call: it would otherwise run as the bot with nobody named behind it.
 * Answers the refusal as one sentence; the caller chooses how to send it.
 */
export async function actingUser(
  getUserById: (id: string) => Promise<AuthUser | null | undefined>,
  auth: Pick<ToolAuth, 'userId' | 'madeBy'>,
): Promise<{ user: AuthUser } | { refused: string }> {
  const found = await getUserById(auth.userId);
  if (!found) return { refused: 'Your account is no longer available.' };
  if (!auth.madeBy) return { user: found };
  const maker = await getUserById(auth.madeBy.id);
  if (!maker) return { refused: 'The person who made this connection is no longer available, so it loads nothing.' };
  return { user: { ...found, madeBy: { name: maker.name, email: maker.email } } };
}
