import type { AuthUser } from './types.js';

/**
 * `POST /api/invitations`: invite one address. Anyone signed in may send it;
 * `role: 'admin'` only an admin. `startingPassword` asks the server to
 * generate a starting password for the new account: refused when password
 * sign-in is off. Left out, the server decides from how the deployment signs
 * people in (password sign-in and no single sign-on: a password; otherwise
 * none).
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
    }
  | { status: 'existing' };
