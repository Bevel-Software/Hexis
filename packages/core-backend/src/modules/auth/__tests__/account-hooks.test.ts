import { describe, expect, it, vi } from 'vitest';
import { AccountHooks, type AccountInvitedEvent } from '../account-hooks.js';

const EVENT: AccountInvitedEvent = {
  account: { id: 'u-lena', email: 'lena@acme.test', name: 'lena' },
  invitedBy: { id: 'u-dana', email: 'dana@acme.test', name: 'Dana Admin' },
  passwordSet: true,
};

describe('AccountHooks: an account was invited', () => {
  it('notifies nobody when nothing is registered, and says so', async () => {
    expect(await new AccountHooks().runAccountInvited(EVENT)).toEqual([]);
  });

  it('runs every listener in registration order, with the event, and collects the channels that reached the person', async () => {
    const hooks = new AccountHooks();
    const seen: string[] = [];
    hooks.onAccountInvited(async (event) => {
      seen.push(`mail:${event.account.email}:${event.passwordSet}`);
      return 'email';
    });
    hooks.onAccountInvited(async () => {
      seen.push('chat');
      return null;
    });
    hooks.onAccountInvited(async () => {
      seen.push('sms');
      return 'sms';
    });
    expect(await hooks.runAccountInvited(EVENT)).toEqual(['email', 'sms']);
    expect(seen).toEqual(['mail:lena@acme.test:true', 'chat', 'sms']);
  });

  it('a listener that throws counts as not having notified, and stops nothing', async () => {
    const hooks = new AccountHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      hooks.onAccountInvited(async () => {
        throw new Error('smtp down');
      });
      hooks.onAccountInvited(async () => 'email');
      expect(await hooks.runAccountInvited(EVENT)).toEqual(['email']);
    } finally {
      error.mockRestore();
    }
  });
});
