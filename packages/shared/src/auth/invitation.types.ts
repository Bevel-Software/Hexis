import type { AuthUser } from './types.js';

/**
 * `POST /api/invitations`: invite one address. Anyone signed in may send it;
 * `role: 'admin'` only an admin. `startingPassword` asks the server to
 * generate a starting password for the new account where single sign-on is
 * on too; it is refused when password sign-in is off. Where password sign-in
 * is the only way in, every new account gets one whatever this says, except
 * on the owner's and the system accounts' addresses, which never get one,
 * and, from a non-admin, on an address that already holds Admin.
 */
export interface InvitationRequest {
  email: string;
  role?: 'member' | 'admin';
  startingPassword?: boolean;
}

/**
 * What an invitation came to. `created`: a NEW account was made.
 * `startingPassword` is the generated password, present only when one was
 * made, and returned this once: it is stored only as a hash. `notified`:
 * how the deployment told the person (`'email'`, say), empty when nobody did.
 * `singleSignOn`: whether this deployment's single sign-on lets the address
 * in. False when none is offered, and false when the address is outside the
 * domains it admits (`ALLOWED_EMAIL_DOMAINS`): such an account can sign in
 * only with its starting password, or not at all without one.
 *
 * `existing`: the address already has an account, and nothing was written to
 * it. That is all the answer says about it.
 */
export type InvitationResult =
  | {
      status: 'created';
      account: Pick<AuthUser, 'id' | 'email' | 'name'>;
      startingPassword?: string;
      notified: string[];
      singleSignOn: boolean;
    }
  | { status: 'existing' };
