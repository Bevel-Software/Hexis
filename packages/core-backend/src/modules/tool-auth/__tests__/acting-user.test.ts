import { describe, expect, it } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { actingUser } from '../index.js';

const BOT = { id: 'u-bot', email: 'release-helper@agent.hexis', name: 'release-helper' } as AuthUser;
const DANA = { id: 'u-dana', email: 'dana@acme.com', name: 'Dana' } as AuthUser;
const rows = new Map<string, AuthUser>([
  [BOT.id, BOT],
  [DANA.id, DANA],
]);
const getUserById = async (id: string) => rows.get(id) ?? null;

describe('the account a tool credential acts as', () => {
  it('is the credential’s own row for a connection made as a person', async () => {
    expect(await actingUser(getUserById, { userId: DANA.id })).toEqual({ user: DANA });
  });

  it('is the bot’s row with the person who made the connection beside it', async () => {
    expect(await actingUser(getUserById, { userId: BOT.id, madeBy: { id: DANA.id, email: DANA.email } })).toEqual({
      user: { ...BOT, madeBy: { name: 'Dana', email: 'dana@acme.com' } },
    });
  });

  it('is refused, in one sentence, when the maker or the account cannot be loaded', async () => {
    expect(await actingUser(getUserById, { userId: BOT.id, madeBy: { id: 'u-gone', email: 'gone@acme.com' } })).toEqual({
      refused: 'The person who made this connection is no longer available, so it loads nothing.',
    });
    expect(await actingUser(getUserById, { userId: 'u-gone' })).toEqual({ refused: 'Your account is no longer available.' });
  });
});
