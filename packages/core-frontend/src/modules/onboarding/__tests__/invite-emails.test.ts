import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationRequest, InvitationResult } from '@bevel-software/platform-shared';
import { gotPassword, isInvited, sendInvites, wasEmailed } from '../invite-emails';

/** Every invite promotion is sent `ifActive`: the server refuses a switched-off account at the write. */
const ACTIVE = { ifActive: true };

/**
 * `sendInvites` over `POST /api/invitations`: one request per address, in
 * order; each answer reshaped into the row the dialog shows; an admin's
 * Admin invite promoted through the roles route afterwards.
 */

const PW = 'Gen3ratedPassw0rd';

/** Addresses that already have an account, as the server would answer them. */
const EXISTING = new Set(['old@acme.com', 'boss@acme.com', 'off@acme.com']);

function makeApi() {
  return {
    sendInvitation: vi.fn<(request: InvitationRequest) => Promise<InvitationResult>>(async (request) =>
      EXISTING.has(request.email)
        ? { status: 'existing' }
        : {
            status: 'created',
            account: { id: `id-${request.email}`, email: request.email, name: request.email.split('@')[0]! },
            ...(request.startingPassword ? { startingPassword: PW } : {}),
            notified: [],
          },
    ),
    addMember: vi.fn<(canonical: string, email: string, options?: { ifActive?: boolean }) => Promise<unknown>>(
      async () => [],
    ),
    fetchRoles: vi.fn(async () => [{ canonical: 'admin', members: ['boss@acme.com'] }]),
  };
}

let api: ReturnType<typeof makeApi>;
beforeEach(() => {
  api = makeApi();
});

describe('sendInvites', () => {
  it('sends one invitation per address, in order, with the role and the password flag', async () => {
    await sendInvites(['a@acme.com', 'b@acme.com'], 'member', api, { startingPassword: true });
    expect(api.sendInvitation.mock.calls).toEqual([
      [{ email: 'a@acme.com', role: 'member', startingPassword: true }],
      [{ email: 'b@acme.com', role: 'member', startingPassword: true }],
    ]);
  });

  it('puts the generated password on the created row and nothing on an existing one', async () => {
    const outcomes = await sendInvites(['new@acme.com', 'old@acme.com'], 'member', api, { startingPassword: true });
    expect(outcomes).toEqual([
      { email: 'new@acme.com', status: 'created', role: 'member', startingPassword: PW },
      { email: 'old@acme.com', status: 'existing' },
    ]);
    expect(outcomes.map(gotPassword)).toEqual([true, false]);
    expect(api.addMember).not.toHaveBeenCalled();
    expect(api.fetchRoles).not.toHaveBeenCalled();
  });

  it('without a password flag sends none, and the server decides', async () => {
    const outcomes = await sendInvites(['new@acme.com'], 'member', api);
    expect(api.sendInvitation).toHaveBeenCalledWith({ email: 'new@acme.com', role: 'member' });
    expect(outcomes).toEqual([{ email: 'new@acme.com', status: 'created', role: 'member' }]);
  });

  it("an admin's Admin invite promotes new and existing accounts through the roles route, ifActive", async () => {
    const outcomes = await sendInvites(['new@acme.com', 'old@acme.com', 'boss@acme.com'], 'admin', api);
    expect(api.addMember.mock.calls).toEqual([
      ['admin', 'new@acme.com', ACTIVE],
      ['admin', 'old@acme.com', ACTIVE],
    ]);
    expect(outcomes).toEqual([
      { email: 'new@acme.com', status: 'created', role: 'admin' },
      { email: 'old@acme.com', status: 'existing', promoted: true },
      { email: 'boss@acme.com', status: 'existing', alreadyAdmin: true },
    ]);
  });

  it('reports an existing account the promotion found switched off as switched off, not invited', async () => {
    api.addMember.mockRejectedValueOnce(Object.assign(new Error('switched off'), { kind: 'deactivated' }));
    const [outcome] = await sendInvites(['off@acme.com'], 'admin', api);
    expect(outcome).toEqual({ email: 'off@acme.com', status: 'existing', deactivated: true });
    expect(isInvited(outcome!)).toBe(false);
  });

  it('keeps a new account as Member, with the reason, when its promotion fails', async () => {
    api.addMember.mockRejectedValueOnce(new Error('roles.yaml is locked'));
    const [outcome] = await sendInvites(['new@acme.com'], 'admin', api, { startingPassword: true });
    expect(outcome).toEqual({
      email: 'new@acme.com',
      status: 'created',
      role: 'member',
      roleError: 'roles.yaml is locked',
      startingPassword: PW,
    });
  });

  it('reads an admission refusal as no seat, and any other refusal as an error in its words', async () => {
    api.sendInvitation
      .mockRejectedValueOnce(Object.assign(new Error('Your plan is full'), { kind: 'admission' }))
      .mockRejectedValueOnce(Object.assign(new Error('Only an admin can invite someone as Admin'), { kind: null }));
    const outcomes = await sendInvites(['a@acme.com', 'b@acme.com', 'c@acme.com'], 'member', api);
    expect(outcomes).toEqual([
      { email: 'a@acme.com', status: 'no-seat', message: 'Your plan is full' },
      { email: 'b@acme.com', status: 'error', message: 'Only an admin can invite someone as Admin' },
      { email: 'c@acme.com', status: 'created', role: 'member' },
    ]);
  });
});

describe('sendInvites carries how the deployment told the person', () => {
  it('a new account the server says was emailed carries `notified`; one nobody told does not', async () => {
    api.sendInvitation.mockResolvedValueOnce({
      status: 'created',
      account: { id: '1', email: 'mailed@acme.com', name: 'mailed' },
      startingPassword: PW,
      notified: ['email'],
    });
    const outcomes = await sendInvites(['mailed@acme.com', 'quiet@acme.com'], 'member', api, { startingPassword: true });
    expect(outcomes).toEqual([
      { email: 'mailed@acme.com', status: 'created', role: 'member', startingPassword: PW, notified: ['email'] },
      { email: 'quiet@acme.com', status: 'created', role: 'member', startingPassword: PW },
    ]);
    expect(outcomes.map(wasEmailed)).toEqual([true, false]);
  });
});

describe('isInvited', () => {
  it('counts a new account and an existing one that is on', () => {
    expect(isInvited({ email: 'a@acme.com', status: 'created', role: 'member' })).toBe(true);
    expect(isInvited({ email: 'b@acme.com', status: 'existing' })).toBe(true);
  });
  it('never counts a switched-off account, a seat refusal or an error', () => {
    expect(isInvited({ email: 'off@acme.com', status: 'existing', deactivated: true })).toBe(false);
    expect(isInvited({ email: 'x@acme.com', status: 'no-seat', message: 'full' })).toBe(false);
    expect(isInvited({ email: 'x@acme.com', status: 'error', message: 'never' })).toBe(false);
  });
});
