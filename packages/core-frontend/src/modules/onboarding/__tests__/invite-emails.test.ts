import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isInvited, sendInvites } from '../invite-emails';

/**
 * `sendInvites` with and without a starting password: who gets it, who keeps
 * their own, who is left alone, and that a send with a password never writes
 * blind when the account list cannot be read (the server's account write
 * replaces a stored password).
 */

const PW = 'welcome-to-acme';
/** How a starting password is sent: the server never writes it over one of the account's own. */
const KEEP = { keepExistingPassword: true };

function makeApi(accounts: { email: string; hasPassword?: boolean; isEnvAdmin?: boolean; deactivatedAt?: string | null }[] | Error) {
  return {
    listAccounts: vi.fn(async () => {
      if (accounts instanceof Error) throw accounts;
      return accounts;
    }),
    createAccount: vi.fn<
      (
        email: string,
        name: string,
        password?: string,
        options?: { keepExistingPassword?: boolean },
      ) => Promise<{ passwordSet?: boolean; deactivated?: boolean } | void>
    >(async () => ({ passwordSet: true })),
    addMember: vi.fn(async () => []),
    fetchRoles: vi.fn(async () => [{ canonical: 'admin', members: ['boss@acme.com'] }]),
  };
}

let api: ReturnType<typeof makeApi>;
beforeEach(() => {
  api = makeApi([
    { email: 'nopw@acme.com', hasPassword: false },
    { email: 'own@acme.com', hasPassword: true },
    { email: 'env@acme.com', hasPassword: false, isEnvAdmin: true },
    { email: 'off@acme.com', hasPassword: false, deactivatedAt: '2026-09-01T00:00:00Z' },
  ]);
});

describe('sendInvites with a starting password', () => {
  it('creates new accounts with it and completes an existing one that has none', async () => {
    const result = await sendInvites(['new@acme.com', 'nopw@acme.com'], 'member', api, { password: PW });
    expect(api.createAccount.mock.calls).toEqual([
      ['new@acme.com', '', PW, KEEP],
      ['nopw@acme.com', '', PW, KEEP],
    ]);
    expect(result).toEqual({
      status: 'sent',
      outcomes: [
        { email: 'new@acme.com', status: 'created', role: 'member', passwordSet: true },
        { email: 'nopw@acme.com', status: 'existing', passwordSet: true },
      ],
    });
  });

  it('never writes an account with its own password, the deployment admin, or a switched-off one', async () => {
    const result = await sendInvites(['own@acme.com', 'env@acme.com', 'off@acme.com'], 'member', api, { password: PW });
    expect(api.createAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'sent',
      outcomes: [
        { email: 'own@acme.com', status: 'existing', hasOwnPassword: true },
        { email: 'env@acme.com', status: 'existing', hasOwnPassword: true },
        { email: 'off@acme.com', status: 'existing', deactivated: true },
      ],
    });
  });

  it('still makes Admin invites admins, after the password', async () => {
    await sendInvites(['new@acme.com', 'nopw@acme.com'], 'admin', api, { password: PW });
    expect(api.createAccount.mock.calls.map((c) => c[2])).toEqual([PW, PW]);
    expect(api.addMember.mock.calls).toEqual([
      ['admin', 'new@acme.com'],
      ['admin', 'nopw@acme.com'],
    ]);
  });

  it('leaves an existing account as it was when setting the password fails, with the reason', async () => {
    api.createAccount.mockRejectedValueOnce(new Error('Password too common'));
    const result = await sendInvites(['nopw@acme.com'], 'admin', api, { password: PW });
    expect(result).toEqual({
      status: 'sent',
      outcomes: [{ email: 'nopw@acme.com', status: 'existing', passwordError: 'Password too common' }],
    });
    expect(api.addMember).not.toHaveBeenCalled();
  });

  it('sends nothing at all when the account list cannot be read', async () => {
    api = makeApi(new Error('down'));
    const result = await sendInvites(['new@acme.com'], 'admin', api, { password: PW });
    expect(result).toEqual({ status: 'accounts-unreadable' });
    expect(api.createAccount).not.toHaveBeenCalled();
    expect(api.addMember).not.toHaveBeenCalled();
    expect(api.fetchRoles).not.toHaveBeenCalled();
  });

  it('keeps a password the account set after the list was read: the server refused the write', async () => {
    api.createAccount.mockResolvedValue({ passwordSet: false });
    const result = await sendInvites(['nopw@acme.com', 'new@acme.com'], 'member', api, { password: PW });
    expect(api.createAccount.mock.calls).toEqual([
      ['nopw@acme.com', '', PW, KEEP],
      ['new@acme.com', '', PW, KEEP],
    ]);
    expect(result).toEqual({
      status: 'sent',
      outcomes: [
        { email: 'nopw@acme.com', status: 'existing', hasOwnPassword: true },
        // Not on the list, but there with a password of its own by the time of the write.
        { email: 'new@acme.com', status: 'existing', hasOwnPassword: true },
      ],
    });
  });

  it('reports an account switched off after the list was read as switched off, not invited', async () => {
    api.createAccount.mockResolvedValue({ passwordSet: false, deactivated: true });
    const result = await sendInvites(['nopw@acme.com', 'new@acme.com'], 'member', api, { password: PW });
    expect(result).toEqual({
      status: 'sent',
      outcomes: [
        { email: 'nopw@acme.com', status: 'existing', deactivated: true },
        { email: 'new@acme.com', status: 'existing', deactivated: true },
      ],
    });
    if (result.status !== 'sent') throw new Error('not sent');
    expect(result.outcomes.filter((o) => isInvited(o, true))).toEqual([]);
  });

  it('does not make a switched-off account an Admin, listed so or switched off since the read', async () => {
    // Listed as switched off: no password write and no promotion.
    const listed = await sendInvites(['off@acme.com'], 'admin', api, { password: PW });
    expect(listed).toEqual({ status: 'sent', outcomes: [{ email: 'off@acme.com', status: 'existing', deactivated: true }] });
    // Switched off between the read and the write: the server left it, and so does the promotion.
    api.createAccount.mockResolvedValue({ passwordSet: false, deactivated: true });
    const since = await sendInvites(['nopw@acme.com', 'new@acme.com'], 'admin', api, { password: PW });
    expect(since).toEqual({
      status: 'sent',
      outcomes: [
        { email: 'nopw@acme.com', status: 'existing', deactivated: true },
        { email: 'new@acme.com', status: 'existing', deactivated: true },
      ],
    });
    expect(api.addMember).not.toHaveBeenCalled();
  });

  it('still promotes an account that got its own password since the read', async () => {
    api.createAccount.mockResolvedValue({ passwordSet: false });
    await sendInvites(['new@acme.com'], 'admin', api, { password: PW });
    expect(api.addMember.mock.calls).toEqual([['admin', 'new@acme.com']]);
  });

  it('carries the password in no outcome', async () => {
    const result = await sendInvites(['new@acme.com', 'nopw@acme.com', 'own@acme.com'], 'member', api, {
      password: PW,
    });
    expect(JSON.stringify(result)).not.toContain(PW);
  });
});

describe('sendInvites without a password', () => {
  it('gives no account one', async () => {
    await sendInvites(['new@acme.com', 'nopw@acme.com'], 'member', api);
    expect(api.createAccount.mock.calls).toEqual([['new@acme.com', '']]);
  });

  it('treats every address as new when the list cannot be read, as before', async () => {
    api = makeApi(new Error('down'));
    const result = await sendInvites(['new@acme.com'], 'member', api);
    expect(api.createAccount).toHaveBeenCalledWith('new@acme.com', '');
    expect(result).toEqual({ status: 'sent', outcomes: [{ email: 'new@acme.com', status: 'created', role: 'member' }] });
  });
  it('leaves a switched-off account unchanged on an Admin invite: no promotion', async () => {
    const result = await sendInvites(['off@acme.com'], 'admin', api);
    expect(api.addMember).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'sent', outcomes: [{ email: 'off@acme.com', status: 'existing', deactivated: true }] });
  });
});

describe('isInvited', () => {
  const failed = { email: 'nopw@acme.com', status: 'existing' as const, passwordError: 'Password too common' };
  it('does not count an account whose password could not be set, without single sign-on', () => {
    expect(isInvited(failed)).toBe(false);
  });
  it('counts it with single sign-on: it can still sign in that way', () => {
    expect(isInvited(failed, true)).toBe(true);
  });
  it('never counts a switched-off account', () => {
    expect(isInvited({ email: 'off@acme.com', status: 'existing', deactivated: true }, true)).toBe(false);
  });
});
