import { describe, it, expect } from 'vitest';

import type { Database } from '../../database/connection.js';
import {
  DIRECTORY_SYNC_BOT_EMAIL,
  DIRECTORY_SYNC_BOT_NAME,
  ensureDirectorySyncBot,
} from '../directory-sync-bot.js';

interface Row {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  passwordHash: string | null;
}

/** Minimal fake of the two drizzle chains `ensureDirectorySyncBot` runs. */
function fakeDb(opts: { existing: Row | null }): Database {
  const created: Row = {
    id: 'bot-row',
    email: DIRECTORY_SYNC_BOT_EMAIL,
    name: DIRECTORY_SYNC_BOT_NAME,
    avatarUrl: null,
    passwordHash: null,
  };
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          // Conflict (row exists) → empty; otherwise the fresh bot row.
          returning: async () => (opts.existing ? [] : [created]),
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.existing ? [opts.existing] : []),
        }),
      }),
    }),
  } as unknown as Database;
}

describe('ensureDirectorySyncBot — the bot identity is exclusive', () => {
  it('creates the bot row when the email is free', async () => {
    const bot = await ensureDirectorySyncBot(fakeDb({ existing: null }));
    expect(bot).toMatchObject({ email: DIRECTORY_SYNC_BOT_EMAIL, name: DIRECTORY_SYNC_BOT_NAME });
  });

  it('reuses an existing row only when it IS the bot', async () => {
    const bot = await ensureDirectorySyncBot(
      fakeDb({
        existing: {
          id: 'prev-bot',
          email: DIRECTORY_SYNC_BOT_EMAIL,
          name: DIRECTORY_SYNC_BOT_NAME,
          avatarUrl: null,
          passwordHash: null,
        },
      }),
    );
    expect(bot.id).toBe('prev-bot');
  });

  it('REFUSES to bind the materializer to a pre-existing human account under the bot email', async () => {
    // The machine-owned write rule on synced-groups.yaml authorizes by this
    // email alone — silently adopting a human's row would attribute every
    // sync commit to them and hand their session the bot's write authority.
    await expect(
      ensureDirectorySyncBot(
        fakeDb({
          existing: {
            id: 'human-1',
            email: DIRECTORY_SYNC_BOT_EMAIL,
            name: 'Mallory Human',
            avatarUrl: null,
            passwordHash: null,
          },
        }),
      ),
    ).rejects.toThrow(/already belongs to an existing account/);
  });

  it('REFUSES a password-capable row even when it mimics the bot display name', async () => {
    // A display name is not an identity marker — anyone can carry the bot's
    // name. A password hash IS hard evidence: the bot never signs in and is
    // never provisioned credentials, so a login-capable row under the bot
    // email is a person's account (or a credential a person could use) and
    // must never be adopted as the materializer's identity.
    await expect(
      ensureDirectorySyncBot(
        fakeDb({
          existing: {
            id: 'human-2',
            email: DIRECTORY_SYNC_BOT_EMAIL,
            name: DIRECTORY_SYNC_BOT_NAME,
            avatarUrl: null,
            passwordHash: 'scrypt:deadbeef',
          },
        }),
      ),
    ).rejects.toThrow(/can sign in with a password/);
  });
});
