import { inspect } from 'node:util';
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
      // Logged, so a failing mailer is diagnosable from the server's log.
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain('an account-invited listener failed');
    } finally {
      error.mockRestore();
    }
  });

  it('a listener whose error quotes the starting password is logged with the password scrubbed', async () => {
    const hooks = new AccountHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const password = 'Kq7mZt3xWp9rHs4v';
    try {
      // A mailer echoing its payload: in the message, on a field of its own, and in the cause.
      const failure = Object.assign(new Error(`550 rejected: "Your password is ${password}"`, { cause: new Error(`body: ${password}`) }), {
        response: `DATA ... ${password} ...`,
      });
      hooks.onAccountInvited(async () => {
        throw failure;
      });
      expect(await hooks.runAccountInvited({ ...EVENT, startingPassword: password })).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      const logged = error.mock.calls[0]!.map((arg) => inspect(arg, { depth: 6 })).join(' ');
      expect(logged).toContain('an account-invited listener failed');
      // Still diagnosable: the mailer's own words stay, only the secret goes.
      expect(logged).toContain('550 rejected');
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(password.slice(0, 12));
    } finally {
      error.mockRestore();
    }
  });

  it('an empty channel name is no channel: it counts as not having notified', async () => {
    const hooks = new AccountHooks();
    hooks.onAccountInvited(async () => '');
    hooks.onAccountInvited(async () => 'email');
    expect(await hooks.runAccountInvited(EVENT)).toEqual(['email']);
  });
});
