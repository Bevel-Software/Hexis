import express from 'express';
import type { InvitationResult } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { AuthService } from './auth.service.js';
import { inviterOf, type IAccountHooks } from './account-hooks.js';
import { AccountAdmissionRefusedError, AccountChangeRefusedError } from './account-admission.js';
import { offeredProviders, type AuthProviderPlugin } from './auth.routes.js';
import type { IAdminAccessService } from '../admin/index.js';
import './auth.middleware.js'; // Express Request augmentation

const log = logger('accounts');

/** How the deployment signs people in, which decides whether an invite carries a password. */
export interface InvitationSignIn {
  /** Password sign-in is on (`LOGIN_PASSWORD`). */
  passwordSignIn: boolean;
  /** The single sign-on providers, asked at each invite whether they are offered now. */
  providers: readonly AuthProviderPlugin[];
}

/**
 * `POST /api/invitations { email, role?, startingPassword? }`: anyone signed
 * in invites somebody. It makes a NEW account and nothing else: an address
 * that already has one answers `{ status: 'existing' }` and is not written
 * (no password, no role, not switched on), whoever asks, and the answer says
 * nothing more about it.
 *
 * - `role: 'admin'` is an admin's to ask for (403 for anyone else). The
 *   route makes no role write either way: the Admin role is a `roles.yaml`
 *   membership the dialog adds after, through the roles route.
 * - The starting password is generated here, never typed. With password
 *   sign-in and no single sign-on every new account gets one, whatever
 *   `startingPassword` says, or nobody invited could sign in (the deployment
 *   admin's and the system accounts' addresses excepted: they never hold a
 *   stored password). With both, only when `startingPassword` is true.
 *   With password sign-in off none is made, and asking for one is a 400.
 *   It is returned once in the answer and carried on the invited event for
 *   a deployment's mail; never logged.
 * - The admission port is asked with the reason `invite`; a refusal is 403
 *   with `kind: 'admission'` and the port's words.
 *
 * `POST /api/admin/accounts` stays the admins' account API beside this.
 */
export function createInvitationRoutes(
  authService: Pick<AuthService, 'createInvitedAccount' | 'getUserById'>,
  adminAccess: IAdminAccessService,
  accountHooks: Pick<IAccountHooks, 'runAccountInvited'>,
  signIn: InvitationSignIn,
): express.Router {
  const router = express.Router();

  router.post('/invitations', async (req, res) => {
    const { email, role, startingPassword } = (req.body ?? {}) as {
      email?: unknown;
      role?: unknown;
      startingPassword?: unknown;
    };
    if (typeof email !== 'string' || !email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (role !== undefined && role !== 'member' && role !== 'admin') {
      res.status(400).json({ error: "role must be 'member' or 'admin'" });
      return;
    }
    // Fail closed: anything but a boolean is a mistake, never "yes".
    if (startingPassword !== undefined && typeof startingPassword !== 'boolean') {
      res.status(400).json({ error: 'startingPassword must be a boolean' });
      return;
    }
    if (role === 'admin' && !(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Only an admin can invite someone as Admin' });
      return;
    }
    if (startingPassword === true && !signIn.passwordSignIn) {
      res.status(400).json({ error: 'Password sign-in is off here, so an invite carries no password' });
      return;
    }
    const sso = offeredProviders(signIn.providers).length > 0;
    const generate = signIn.passwordSignIn && (!sso || startingPassword === true);

    let invited: Awaited<ReturnType<AuthService['createInvitedAccount']>>;
    try {
      invited = await authService.createInvitedAccount(email, { startingPassword: generate });
    } catch (error) {
      if (error instanceof AccountAdmissionRefusedError) {
        res.status(403).json({ error: error.message, kind: 'admission' });
        return;
      }
      if (error instanceof AccountChangeRefusedError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('creating an invited account failed:', { err: error });
      res.status(500).json({ error: 'Could not create the account' });
      return;
    }
    if (!invited.created) {
      const answer: InvitationResult = { status: 'existing' };
      res.json(answer);
      return;
    }

    const { user, startingPassword: password } = invited;
    // Never the password: whether one was made is all the line says.
    log.info('account audit:', {
      action: 'invite',
      actorUserId: req.userId,
      targetUserId: user.id,
      passwordGenerated: password !== undefined,
    });
    const account = { id: user.id, email: user.email, name: user.name };
    const notified = await accountHooks.runAccountInvited({
      account,
      invitedBy: await inviterOf(req, (id) => authService.getUserById(id)),
      passwordSet: password !== undefined,
      ...(password !== undefined ? { startingPassword: password } : {}),
    });
    const answer: InvitationResult = {
      status: 'created',
      account,
      ...(password !== undefined ? { startingPassword: password } : {}),
      notified,
    };
    res.status(201).json(answer);
  });

  return router;
}
