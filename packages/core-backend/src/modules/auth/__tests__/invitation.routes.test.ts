import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInvitationRoutes, type InvitationSignIn } from '../invitation.routes.js';
import type { AccountInvitedEvent, AccountInvitedNotice } from '../account-hooks.js';
import type { AuthProviderPlugin } from '../auth.routes.js';
import type { AuthService } from '../auth.service.js';
import { FixedWindowRateLimiter } from '../rate-limit.js';
import { AccountAdmissionRefusedError, AccountChangeRefusedError } from '../index.js';
import type { IAdminAccessService, IAdminRoleLookup } from '../../admin/index.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger, LogFields } from '../../../shared/logger.contract.js';

/**
 * `POST /api/invitations` over a stubbed account service: who may ask for
 * what, which sign-in shapes generate a password, and what the answer, the
 * invited event and the audit line carry. Whether an existing account is
 * left byte for byte as it was is a property of the insert itself, and is
 * pinned on a real Postgres in `invitation.pg.test.ts`.
 */

const GENERATED = 'Gen3ratedPassw0rdXYZ';

const createInvitedAccount = vi.fn<AuthService['createInvitedAccount']>();
const getUserById = vi.fn<AuthService['getUserById']>(async (id) => ({ id, email: `${id}@acme.test`, name: 'Inviter' }));
// The deployment's ALLOWED_EMAIL_DOMAINS, as single sign-on reads it: acme.test only.
const isEmailDomainAllowed = vi.fn<AuthService['isEmailDomainAllowed']>((email) => email.endsWith('@acme.test'));
const deliverAccountInvited = vi.fn<(event: AccountInvitedEvent) => Promise<AccountInvitedNotice>>(async () => ({
  notified: [],
  passwordDeliveredBy: [],
}));
const discardStartingPassword = vi.fn<AuthService['discardStartingPassword']>(async () => true);

/** Every line logged while a test runs, message and fields. */
let lines: { level: string; message: string; fields?: LogFields }[] = [];
let previousLogger: ILogger;
function capturingLogger(): ILogger {
  const record = (level: string) => (message: string, fields?: LogFields) => {
    lines.push({ level, message, fields });
  };
  const self: ILogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => self,
  };
  return self;
}

const sso: AuthProviderPlugin = {
  key: 'oidc',
  label: 'Okta',
  startPath: '/api/auth/oidc/login',
  mountRoutes: () => {},
};

let server: Server | undefined;
/** The admin lookups the last `start` wired in, to assert what was asked. */
let adminLookups: { isAdmin: ReturnType<typeof vi.fn>; holdsAdmin: ReturnType<typeof vi.fn> };
beforeEach(() => {
  lines = [];
  previousLogger = setLogger(capturingLogger());
  createInvitedAccount.mockReset();
  createInvitedAccount.mockImplementation(async (email, { startingPassword }) => ({
    created: true,
    user: { id: 'new-1', email, name: email.split('@')[0] },
    ...(startingPassword ? { startingPassword: GENERATED } : {}),
  }));
  deliverAccountInvited.mockClear();
  discardStartingPassword.mockReset();
  discardStartingPassword.mockResolvedValue(true);
});
afterEach(() => {
  setLogger(previousLogger);
  server?.close();
  server = undefined;
});

async function start(opts: {
  admin: boolean;
  /** Addresses that already hold Admin (in `roles.yaml`), besides the inviter. */
  admins?: string[];
  /** Reading whether an invited address holds Admin fails. */
  adminLookupFails?: boolean;
  signIn?: Partial<InvitationSignIn>;
  limiter?: FixedWindowRateLimiter;
}): Promise<string> {
  const holds = (email: string | undefined) =>
    email === 'inviter@acme.test' ? opts.admin : (opts.admins ?? []).includes(email ?? '');
  const lookups = {
    // Like the real check: a failed read answers "not admin".
    isAdmin: vi.fn(async (email: string | undefined) =>
      opts.adminLookupFails && email !== 'inviter@acme.test' ? false : holds(email),
    ),
    holdsAdmin: vi.fn(async (email: string) => {
      if (opts.adminLookupFails) throw new Error('roles.yaml unreadable');
      return holds(email);
    }),
  };
  adminLookups = lookups;
  const adminAccess: IAdminAccessService & IAdminRoleLookup = lookups;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'inviter-1';
    req.userEmail = 'inviter@acme.test';
    next();
  });
  app.use(
    '/api',
    createInvitationRoutes(
      { createInvitedAccount, discardStartingPassword, getUserById, isEmailDomainAllowed },
      adminAccess,
      { deliverAccountInvited },
      { passwordSignIn: true, providers: [], ...opts.signIn },
      opts.limiter,
    ),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function invite(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/invitations — who may invite as what', () => {
  it('a member creates a Member account, with a generated password on a password-only deployment', async () => {
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      status: 'created',
      account: { id: 'new-1', email: 'new@acme.test', name: 'new' },
      startingPassword: GENERATED,
      notified: [],
      singleSignOn: false,
    });
    expect(createInvitedAccount).toHaveBeenCalledWith('new@acme.test', { startingPassword: true });
  });

  it("refuses a member's role: admin with 403 and creates nothing", async () => {
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test', role: 'admin' });
    expect(res.status).toBe(403);
    expect(createInvitedAccount).not.toHaveBeenCalled();
    expect(deliverAccountInvited).not.toHaveBeenCalled();
  });

  it("takes an admin's role: admin (the promotion itself is the roles route's)", async () => {
    const base = await start({ admin: true });
    const res = await invite(base, { email: 'new@acme.test', role: 'admin' });
    expect(res.status).toBe(201);
    expect(createInvitedAccount).toHaveBeenCalledTimes(1);
  });

  it("never hands a member the password of an address that already holds Admin: undelivered, it is discarded", async () => {
    const base = await start({ admin: false, admins: ['boss@acme.test'] });
    const res = await invite(base, { email: 'Boss@Acme.test', startingPassword: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty('startingPassword');
    expect(body).not.toHaveProperty('passwordDeliveredBy');
    // Made, offered to the listeners, and taken back when none delivered it.
    expect(createInvitedAccount).toHaveBeenCalledWith('Boss@Acme.test', { startingPassword: true });
    expect(deliverAccountInvited.mock.calls[0]![0].startingPassword).toBe(GENERATED);
    expect(discardStartingPassword).toHaveBeenCalledWith('new-1', GENERATED);
    expect(lines.find((l) => l.message === 'account audit:')?.fields).toMatchObject({
      passwordGenerated: true,
      passwordReturned: false,
      passwordDiscarded: true,
    });
  });

  it('delivers the password of an address that already holds Admin when a listener can, and keeps it', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['email'], passwordDeliveredBy: ['email'] });
    const base = await start({ admin: false, admins: ['boss@acme.test'] });
    const body = await (await invite(base, { email: 'boss@acme.test' })).json();
    expect(body).not.toHaveProperty('startingPassword');
    expect(body.passwordDeliveredBy).toEqual(['email']);
    expect(discardStartingPassword).not.toHaveBeenCalled();
  });

  it('answers 201 with no password when discarding the undelivered Admin password fails, and logs it', async () => {
    discardStartingPassword.mockRejectedValueOnce(new Error('db down'));
    const base = await start({ admin: false, admins: ['boss@acme.test'] });
    const res = await invite(base, { email: 'boss@acme.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty('startingPassword');
    expect(lines.some((l) => l.level === 'error' && l.message.includes('could not be discarded'))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(GENERATED);
  });

  it('still makes one when an admin invites an address that already holds Admin', async () => {
    const base = await start({ admin: true, admins: ['boss@acme.test'] });
    const res = await invite(base, { email: 'boss@acme.test' });
    expect(res.status).toBe(201);
    expect((await res.json()).startingPassword).toBe(GENERATED);
  });

  it("withholds the password from a member, as if the address held Admin, when the lookup fails", async () => {
    const base = await start({ admin: false, adminLookupFails: true });
    const res = await invite(base, { email: 'boss@acme.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty('startingPassword');
    expect(deliverAccountInvited.mock.calls[0]![0].startingPassword).toBe(GENERATED);
    expect(discardStartingPassword).toHaveBeenCalledWith('new-1', GENERATED);
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('withheld from the inviter'))).toBe(true);
  });

  it("answers an existing address 'existing' even when the Admin lookup would fail, and does not ask it", async () => {
    createInvitedAccount.mockResolvedValueOnce({ created: false });
    const base = await start({ admin: false, adminLookupFails: true });
    const res = await invite(base, { email: 'boss@acme.test' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'existing' });
    expect(adminLookups.holdsAdmin).not.toHaveBeenCalled();
  });

  it('asks whether the address holds Admin only when a password was made', async () => {
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    expect((await invite(base, { email: 'a@acme.test' })).status).toBe(201);
    expect(adminLookups.holdsAdmin).not.toHaveBeenCalled();
  });

  it("does not ask when an admin invites, so a failed lookup does not stop the admin's invite", async () => {
    const base = await start({ admin: true, adminLookupFails: true });
    const res = await invite(base, { email: 'boss@acme.test' });
    expect(res.status).toBe(201);
    expect((await res.json()).startingPassword).toBe(GENERATED);
  });

  it('refuses a role that is neither member nor admin', async () => {
    const base = await start({ admin: true });
    const res = await invite(base, { email: 'new@acme.test', role: 'owner' });
    expect(res.status).toBe(400);
    expect(createInvitedAccount).not.toHaveBeenCalled();
  });

  it('answers an existing address with its status and nothing more, and tells nobody', async () => {
    createInvitedAccount.mockResolvedValueOnce({ created: false });
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'old@acme.test' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'existing' });
    expect(deliverAccountInvited).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.message === 'account audit:')).toEqual([]);
  });
});

describe('POST /api/invitations — the starting password follows how people sign in', () => {
  it('password sign-in and single sign-on: none unless asked for, generated when asked', async () => {
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    expect((await invite(base, { email: 'a@acme.test' })).status).toBe(201);
    expect(createInvitedAccount).toHaveBeenLastCalledWith('a@acme.test', { startingPassword: false });
    const asked = await invite(base, { email: 'b@acme.test', startingPassword: true });
    expect((await asked.json()).startingPassword).toBe(GENERATED);
    expect(createInvitedAccount).toHaveBeenLastCalledWith('b@acme.test', { startingPassword: true });
  });

  it('password sign-in and no single sign-on: one is generated even when the client asks for none', async () => {
    const base = await start({ admin: false });
    await invite(base, { email: 'a@acme.test', startingPassword: false });
    expect(createInvitedAccount).toHaveBeenLastCalledWith('a@acme.test', { startingPassword: true });
  });

  it('a provider that says it is off is no single sign-on', async () => {
    const base = await start({ admin: false, signIn: { providers: [{ ...sso, isEnabled: () => false }] } });
    await invite(base, { email: 'a@acme.test' });
    expect(createInvitedAccount).toHaveBeenLastCalledWith('a@acme.test', { startingPassword: true });
  });

  it('password sign-in off: none generated, and asking for one is a 400', async () => {
    const base = await start({ admin: false, signIn: { passwordSignIn: false, providers: [sso] } });
    const refused = await invite(base, { email: 'a@acme.test', startingPassword: true });
    expect(refused.status).toBe(400);
    expect(createInvitedAccount).not.toHaveBeenCalled();
    const res = await invite(base, { email: 'a@acme.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty('startingPassword');
    expect(createInvitedAccount).toHaveBeenLastCalledWith('a@acme.test', { startingPassword: false });
  });

  it('says single sign-on lets the account in only when the address is in a domain it admits', async () => {
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    expect((await (await invite(base, { email: 'in@acme.test' })).json()).singleSignOn).toBe(true);
    // Outside ALLOWED_EMAIL_DOMAINS: the account is made, but SSO would refuse it.
    expect((await (await invite(base, { email: 'out@elsewhere.test' })).json()).singleSignOn).toBe(false);
  });

  it('refuses a startingPassword that is not a boolean', async () => {
    const base = await start({ admin: false });
    expect((await invite(base, { email: 'a@acme.test', startingPassword: 'yes' })).status).toBe(400);
    expect(createInvitedAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/invitations — who gets the password (the credential delivery policy)', () => {
  it('a password a listener delivered to the person is not returned to the inviter; the answer says by which channel', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['email'], passwordDeliveredBy: ['email'] });
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      status: 'created',
      account: { id: 'new-1', email: 'new@acme.test', name: 'new' },
      passwordDeliveredBy: ['email'],
      notified: ['email'],
      singleSignOn: false,
    });
    expect(discardStartingPassword).not.toHaveBeenCalled();
    expect(lines.find((l) => l.message === 'account audit:')?.fields).toEqual({
      action: 'invite',
      actorUserId: 'inviter-1',
      targetUserId: 'new-1',
      passwordGenerated: true,
      passwordDeliveredBy: ['email'],
      passwordReturned: false,
    });
  });

  it('the companion delivering it counts the same, for an admin too', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['companion'], passwordDeliveredBy: ['companion'] });
    const base = await start({ admin: true });
    const body = await (await invite(base, { email: 'new@acme.test' })).json();
    expect(body).not.toHaveProperty('startingPassword');
    expect(body.passwordDeliveredBy).toEqual(['companion']);
  });

  it('a listener that only announced the invite leaves the password with the inviter, once', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['email'], passwordDeliveredBy: [] });
    const base = await start({ admin: false });
    const body = await (await invite(base, { email: 'new@acme.test' })).json();
    expect(body.startingPassword).toBe(GENERATED);
    expect(body).not.toHaveProperty('passwordDeliveredBy');
    expect(body.notified).toEqual(['email']);
  });

  it('nobody to deliver it: the inviter gets it, for an address any grant may already name', async () => {
    // Only Admin is asked about; grants and groups never hold a password back.
    const base = await start({ admin: false, admins: [] });
    const body = await (await invite(base, { email: 'granted@acme.test' })).json();
    expect(body.startingPassword).toBe(GENERATED);
    expect(discardStartingPassword).not.toHaveBeenCalled();
  });

  it('a delivery claimed for an invite that made no password changes nothing', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['email'], passwordDeliveredBy: ['email'] });
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    const body = await (await invite(base, { email: 'new@acme.test' })).json();
    expect(body).not.toHaveProperty('startingPassword');
    expect(body).not.toHaveProperty('passwordDeliveredBy');
  });
});

describe('POST /api/invitations — the event, the audit line and the refusals', () => {
  it('carries the generated password on the invited event, and the channels back in the answer', async () => {
    deliverAccountInvited.mockResolvedValueOnce({ notified: ['email'], passwordDeliveredBy: [] });
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test' });
    expect((await res.json()).notified).toEqual(['email']);
    expect(deliverAccountInvited).toHaveBeenCalledWith({
      account: { id: 'new-1', email: 'new@acme.test', name: 'new' },
      invitedBy: { id: 'inviter-1', email: 'inviter-1@acme.test', name: 'Inviter' },
      passwordSet: true,
      startingPassword: GENERATED,
    });
  });

  it('names the inviter on the event by id, email and name only, whatever else their account carries', async () => {
    getUserById.mockResolvedValueOnce({ id: 'inviter-1', email: 'inviter@acme.test', name: 'Inviter', isEnvAdmin: true });
    const base = await start({ admin: false });
    await invite(base, { email: 'new@acme.test' });
    expect(deliverAccountInvited.mock.calls[0]![0].invitedBy).toStrictEqual({
      id: 'inviter-1',
      email: 'inviter@acme.test',
      name: 'Inviter',
    });
  });

  it('leaves startingPassword off the event when none was generated', async () => {
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    await invite(base, { email: 'new@acme.test' });
    const event = deliverAccountInvited.mock.calls[0]![0];
    expect(event.passwordSet).toBe(false);
    expect(event).not.toHaveProperty('startingPassword');
  });

  it('writes one account audit line naming the actor, the account and whether a password was made, never the password', async () => {
    const base = await start({ admin: false });
    await invite(base, { email: 'new@acme.test' });
    const audits = lines.filter((l) => l.message === 'account audit:');
    expect(audits).toEqual([
      {
        level: 'info',
        message: 'account audit:',
        fields: {
          action: 'invite',
          actorUserId: 'inviter-1',
          targetUserId: 'new-1',
          passwordGenerated: true,
          passwordDeliveredBy: [],
          passwordReturned: true,
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(GENERATED);
  });

  it("answers the admission port's refusal with 403, kind admission and its words", async () => {
    createInvitedAccount.mockRejectedValueOnce(new AccountAdmissionRefusedError('Your plan has no seat left'));
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Your plan has no seat left', kind: 'admission' });
    expect(deliverAccountInvited).not.toHaveBeenCalled();
  });

  it('answers an invalid address with 400, and anything unexpected with 500 and no internals', async () => {
    createInvitedAccount.mockRejectedValueOnce(new AccountChangeRefusedError('Invalid email'));
    const base = await start({ admin: false });
    const bad = await invite(base, { email: 'not-an-address' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid email' });

    createInvitedAccount.mockRejectedValueOnce(new Error('connection to db-internal:5432 refused'));
    const broken = await invite(base, { email: 'new@acme.test' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: 'Could not create the account' });
  });

  it('requires an email', async () => {
    const base = await start({ admin: false });
    expect((await invite(base, {})).status).toBe(400);
    expect(createInvitedAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/invitations — the per-inviter budget', () => {
  it('answers 429 past the budget, before any role, account or password work', async () => {
    const base = await start({ admin: false, limiter: new FixedWindowRateLimiter(2, 60_000) });
    expect((await invite(base, { email: 'a@acme.test' })).status).toBe(201);
    createInvitedAccount.mockResolvedValueOnce({ created: false });
    expect((await invite(base, { email: 'a@acme.test' })).status).toBe(200);
    adminLookups.isAdmin.mockClear();
    adminLookups.holdsAdmin.mockClear();
    const res = await invite(base, { email: 'b@acme.test' });
    expect(res.status).toBe(429);
    expect(adminLookups.isAdmin).not.toHaveBeenCalled();
    expect(adminLookups.holdsAdmin).not.toHaveBeenCalled();
    expect(createInvitedAccount).toHaveBeenCalledTimes(2);
    expect(deliverAccountInvited).toHaveBeenCalledTimes(1);
  });
});
