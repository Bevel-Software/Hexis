import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createInvitationRoutes, type InvitationSignIn } from '../invitation.routes.js';
import type { AccountInvitedEvent } from '../account-hooks.js';
import type { AuthProviderPlugin } from '../auth.routes.js';
import type { AuthService } from '../auth.service.js';
import { AccountAdmissionRefusedError, AccountChangeRefusedError } from '../index.js';
import type { IAdminAccessService } from '../../admin/index.js';
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
const runAccountInvited = vi.fn<(event: AccountInvitedEvent) => Promise<string[]>>(async () => []);

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
beforeEach(() => {
  lines = [];
  previousLogger = setLogger(capturingLogger());
  createInvitedAccount.mockReset();
  createInvitedAccount.mockImplementation(async (email, { startingPassword }) => ({
    created: true,
    user: { id: 'new-1', email, name: email.split('@')[0] },
    ...(startingPassword ? { startingPassword: GENERATED } : {}),
  }));
  runAccountInvited.mockClear();
});
afterEach(() => {
  setLogger(previousLogger);
  server?.close();
  server = undefined;
});

async function start(opts: { admin: boolean; signIn?: Partial<InvitationSignIn> }): Promise<string> {
  const adminAccess: IAdminAccessService = { isAdmin: vi.fn(async () => opts.admin) };
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
      { createInvitedAccount, getUserById },
      adminAccess,
      { runAccountInvited },
      { passwordSignIn: true, providers: [], ...opts.signIn },
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
    });
    expect(createInvitedAccount).toHaveBeenCalledWith('new@acme.test', { startingPassword: true });
  });

  it("refuses a member's role: admin with 403 and creates nothing", async () => {
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test', role: 'admin' });
    expect(res.status).toBe(403);
    expect(createInvitedAccount).not.toHaveBeenCalled();
    expect(runAccountInvited).not.toHaveBeenCalled();
  });

  it("takes an admin's role: admin (the promotion itself is the roles route's)", async () => {
    const base = await start({ admin: true });
    const res = await invite(base, { email: 'new@acme.test', role: 'admin' });
    expect(res.status).toBe(201);
    expect(createInvitedAccount).toHaveBeenCalledTimes(1);
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
    expect(runAccountInvited).not.toHaveBeenCalled();
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

  it('refuses a startingPassword that is not a boolean', async () => {
    const base = await start({ admin: false });
    expect((await invite(base, { email: 'a@acme.test', startingPassword: 'yes' })).status).toBe(400);
    expect(createInvitedAccount).not.toHaveBeenCalled();
  });
});

describe('POST /api/invitations — the event, the audit line and the refusals', () => {
  it('carries the generated password on the invited event, and the channels back in the answer', async () => {
    runAccountInvited.mockResolvedValueOnce(['email']);
    const base = await start({ admin: false });
    const res = await invite(base, { email: 'new@acme.test' });
    expect((await res.json()).notified).toEqual(['email']);
    expect(runAccountInvited).toHaveBeenCalledWith({
      account: { id: 'new-1', email: 'new@acme.test', name: 'new' },
      invitedBy: { id: 'inviter-1', email: 'inviter-1@acme.test', name: 'Inviter' },
      passwordSet: true,
      startingPassword: GENERATED,
    });
  });

  it('leaves startingPassword off the event when none was generated', async () => {
    const base = await start({ admin: false, signIn: { providers: [sso] } });
    await invite(base, { email: 'new@acme.test' });
    const event = runAccountInvited.mock.calls[0]![0];
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
        fields: { action: 'invite', actorUserId: 'inviter-1', targetUserId: 'new-1', passwordGenerated: true },
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
    expect(runAccountInvited).not.toHaveBeenCalled();
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
