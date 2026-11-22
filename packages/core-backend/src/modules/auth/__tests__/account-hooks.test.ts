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
      // Diagnosable by its shape (what failed, where), never by its words.
      expect(logged).toContain('Error (message withheld)');
      expect(logged).toContain('account-hooks.test.ts:'); // a stack frame: where it failed
      expect(logged).not.toContain('550 rejected');
      expect(logged).not.toContain(password);
      expect(logged).not.toContain(password.slice(0, 12));
    } finally {
      error.mockRestore();
    }
  });

  it('a listener error carrying the password in a Buffer or an encoded field never logs it', async () => {
    const hooks = new AccountHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const password = 'Kq7mZt3xWp9rHs4v';
    try {
      // A mailer keeping its payload as bytes and as base64: the literal scrub cannot see either.
      const failure = Object.assign(new Error('550 rejected', { cause: Object.assign(new Error('smtp'), { body: Buffer.from(password) }) }), {
        code: 'EENVELOPE',
        body: Buffer.from(`Your password is ${password}`),
        encoded: Buffer.from(password).toString('base64'),
      });
      hooks.onAccountInvited(async () => {
        throw failure;
      });
      expect(await hooks.runAccountInvited({ ...EVENT, startingPassword: password })).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
      const logged = error.mock.calls[0]!.map((arg) => inspect(arg, { depth: 6 })).join(' ');
      expect(logged).toContain('EENVELOPE');
      expect(logged).toContain('caused by: Error (message withheld)');
      for (const form of [password, Buffer.from(password).toString('hex'), Buffer.from(password).toString('base64')]) {
        expect(logged).not.toContain(form);
      }
      // Buffer bytes as inspect prints them (`<Buffer 4b 71 ...>`).
      expect(logged).not.toContain('<Buffer');
    } finally {
      error.mockRestore();
    }
  });

  it('a listener error quoting the password encoded in its message never logs it', async () => {
    const hooks = new AccountHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const password = 'Kq7mZt3xWp9rHs4v';
    const encoded = [
      Buffer.from(password).toString('base64'),
      Buffer.from(password).toString('hex'),
    ];
    try {
      // A mailer quoting its encoded body in the message, with a line that looks like a frame.
      const failure = new Error(`550 rejected: ${encoded.join(' ')}\n    at body (${encoded[0]})`);
      hooks.onAccountInvited(async () => {
        throw failure;
      });
      expect(await hooks.runAccountInvited({ ...EVENT, startingPassword: password })).toEqual([]);
      const logged = error.mock.calls[0]!.map((arg) => inspect(arg, { depth: 6 })).join(' ');
      expect(logged).toContain('Error (message withheld)');
      for (const form of [password, ...encoded]) expect(logged).not.toContain(form);
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

describe('AccountHooks: who delivered the starting password', () => {
  const PASSWORD = 'Kq7mZt3xWp9rHs4v';

  it('collects the channels that say they carried the password, beside every channel that notified', async () => {
    const hooks = new AccountHooks();
    hooks.onAccountInvited(async () => 'chat');
    hooks.onAccountInvited(async () => ({ channel: 'email', deliveredStartingPassword: true }));
    hooks.onAccountInvited(async () => ({ channel: 'companion', deliveredStartingPassword: true }));
    expect(await hooks.deliverAccountInvited({ ...EVENT, startingPassword: PASSWORD })).toEqual({
      notified: ['chat', 'email', 'companion'],
      passwordDeliveredBy: ['email', 'companion'],
    });
  });

  it('a plain channel, or deliveredStartingPassword other than true, never claims the password', async () => {
    const hooks = new AccountHooks();
    hooks.onAccountInvited(async () => 'email');
    hooks.onAccountInvited(async () => ({ channel: 'sms', deliveredStartingPassword: false }));
    // A listener written in plain JavaScript can answer anything.
    hooks.onAccountInvited(async () => ({ channel: 'fax', deliveredStartingPassword: 'yes' }) as never);
    expect(await hooks.deliverAccountInvited({ ...EVENT, startingPassword: PASSWORD })).toEqual({
      notified: ['email', 'sms', 'fax'],
      passwordDeliveredBy: [],
    });
  });

  it('claims nothing for an event that carried no password, and an empty channel is no channel', async () => {
    const hooks = new AccountHooks();
    hooks.onAccountInvited(async () => ({ channel: 'email', deliveredStartingPassword: true }));
    hooks.onAccountInvited(async () => ({ channel: '', deliveredStartingPassword: true }));
    expect(await hooks.deliverAccountInvited(EVENT)).toEqual({ notified: ['email'], passwordDeliveredBy: [] });
    expect(await hooks.runAccountInvited(EVENT)).toEqual(['email']);
  });

  it('a listener that throws delivered nothing', async () => {
    const hooks = new AccountHooks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      hooks.onAccountInvited(async () => {
        throw new Error('smtp down');
      });
      expect(await hooks.deliverAccountInvited({ ...EVENT, startingPassword: PASSWORD })).toEqual({
        notified: [],
        passwordDeliveredBy: [],
      });
    } finally {
      error.mockRestore();
    }
  });

  it('keeps each run to its own deliveries when invites overlap', async () => {
    const hooks = new AccountHooks();
    hooks.onAccountInvited(async (event) => {
      await new Promise((r) => setTimeout(r, event.account.id === 'slow' ? 20 : 0));
      return event.account.id === 'slow' ? { channel: 'email', deliveredStartingPassword: true } : 'chat';
    });
    const [slow, fast] = await Promise.all([
      hooks.deliverAccountInvited({ ...EVENT, account: { ...EVENT.account, id: 'slow' }, startingPassword: PASSWORD }),
      hooks.deliverAccountInvited({ ...EVENT, account: { ...EVENT.account, id: 'fast' }, startingPassword: PASSWORD }),
    ]);
    expect(slow.passwordDeliveredBy).toEqual(['email']);
    expect(fast).toEqual({ notified: ['chat'], passwordDeliveredBy: [] });
  });
});
