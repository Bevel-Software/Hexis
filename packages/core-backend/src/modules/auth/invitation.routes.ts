import express from 'express';
import type { InvitationResult } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { canonicalEmail } from '../../shared/email-identity.js';
import type { AuthService } from './auth.service.js';
import { inviterOf, type IAccountHooks } from './account-hooks.js';
import { AccountChangeRefusedError, answerAdmissionRefusal } from './account-admission.js';
import { offeredProviders, type AuthProviderPlugin } from './auth.routes.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import type { IAdminAccessService, IAdminRoleLookup } from '../admin/index.js';
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
 *   owner's and the system accounts' addresses excepted: an inviter never
 *   learns an owner's password, and the system accounts hold none). With
 *   both, only when `startingPassword` is true. With password sign-in off
 *   none is made, and asking for one is a 400. An address the access model
 *   already names (a grant, a group) gets one like any other.
 * - Who gets it (the credential delivery policy): it is carried on the
 *   invited event, and when a listener answers that what it sent the person
 *   carried it (`deliveredStartingPassword`: their email, the companion),
 *   the answer leaves it out and says by which channel instead
 *   (`passwordDeliveredBy`). Otherwise it is returned once in the answer,
 *   for the inviter to copy and pass on. Never logged; a listener's channel
 *   name that carries it is refused at the listener seam, so neither
 *   `notified` nor `passwordDeliveredBy` can.
 * - One exception to that fallback: from a non-admin, for an address that
 *   already holds Admin (listed in `roles.yaml` before it has an account),
 *   the password is never handed to the inviter, who would then sign in as
 *   an admin. It still goes to a listener that can deliver it; when none
 *   does, it is discarded and the account is left with no password (an admin
 *   sets one in User accounts); a discard that fails is logged and leaves a
 *   hash of a password nobody was given. Asked only once the account is made, so an
 *   address that already has one is answered `existing` whatever that lookup
 *   would do; when it cannot be read, the address is taken to hold Admin.
 * - The admission port is asked with the reason `invite`; a refusal is 403
 *   with `kind: 'admission'` and the port's words.
 * - Each inviter has a budget of invitations per window, and past it the
 *   answer is 429. It is spent right after the request is read, before any
 *   role, account or password work, so a refused request costs the server
 *   nothing more.
 *
 * `POST /api/admin/accounts` stays the admins' account API beside this.
 */
export function createInvitationRoutes(
  authService: Pick<AuthService, 'createInvitedAccount' | 'discardStartingPassword' | 'getUserById' | 'isEmailDomainAllowed'>,
  adminAccess: IAdminAccessService & IAdminRoleLookup,
  accountHooks: Pick<IAccountHooks, 'deliverAccountInvited'>,
  signIn: InvitationSignIn,
  /**
   * Invitations per inviter per window. Generous: one dialog sends a whole
   * list. Held in this process, like the sign-in limiters: Hexis runs one
   * replica (see `core/lifecycle.ts`), and a second one would get a budget
   * of its own.
   */
  limiter: FixedWindowRateLimiter = new FixedWindowRateLimiter(200, 15 * 60_000),
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
    if (!limiter.consume(req.userId!)) {
      res.status(429).json({ error: 'Too many invitations. Try again later.' });
      return;
    }
    const inviterIsAdmin = await adminAccess.isAdmin(req.userEmail);
    if (role === 'admin' && !inviterIsAdmin) {
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
      if (answerAdmissionRefusal(res, error)) return;
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
    // An address that already holds Admin (listed in `roles.yaml` before it
    // had an account) never has its password handed to a non-admin inviter:
    // whoever learned it would sign in as an admin. Asked only when a
    // password was made, and a lookup that fails is never read as "not an
    // admin": the password is then withheld as if it were one.
    let withholdFromInviter = false;
    if (password !== undefined && !inviterIsAdmin) {
      try {
        withholdFromInviter = await adminAccess.holdsAdmin(canonicalEmail(user.email));
      } catch (error) {
        log.warn('an invite could not tell whether the address holds Admin; its password is withheld from the inviter:', {
          err: error,
        });
        withholdFromInviter = true;
      }
    }
    const account = { id: user.id, email: user.email, name: user.name };
    const { notified, passwordDeliveredBy } = await accountHooks.deliverAccountInvited({
      account,
      invitedBy: await inviterOf(req, (id) => authService.getUserById(id)),
      passwordSet: password !== undefined,
      ...(password !== undefined ? { startingPassword: password } : {}),
    });
    const delivered = password !== undefined && passwordDeliveredBy.length > 0;
    // The inviter is handed the password only when nobody delivered it to
    // the person, and never an Admin's from a non-admin.
    const returned = password !== undefined && !delivered && !withholdFromInviter;
    let discarded = false;
    if (password !== undefined && !delivered && withholdFromInviter) {
      // Nobody holds it now: drop it, so the account honestly has no
      // password and User accounts offers to set one. A failure leaves a
      // password nobody was given, which lets nobody in: logged, not fatal.
      try {
        discarded = await authService.discardStartingPassword(user.id, password);
      } catch (error) {
        log.error('an undelivered starting password could not be discarded; nobody was given it:', { err: error });
      }
    }
    // Never the password: whether one was made, and where it went, is all the line says.
    log.info('account audit:', {
      action: 'invite',
      actorUserId: req.userId,
      targetUserId: user.id,
      passwordGenerated: password !== undefined,
      passwordDeliveredBy: delivered ? passwordDeliveredBy : [],
      passwordReturned: returned,
      ...(discarded ? { passwordDiscarded: true } : {}),
    });
    const answer: InvitationResult = {
      status: 'created',
      account,
      ...(returned ? { startingPassword: password } : {}),
      ...(delivered ? { passwordDeliveredBy } : {}),
      notified,
      // Single sign-on refuses an address outside the allowed domains, so the
      // dialog may say "signs in with SSO" only where this is true.
      singleSignOn: sso && authService.isEmailDomainAllowed(user.email),
    };
    res.status(201).json(answer);
  });

  return router;
}
