/**
 * The entry other modules reach auth through: its admission contract, and
 * the two things a module checking a credential or refusing a switched-off
 * account needs to agree with auth on. The composition root wires the rest.
 *
 * The embed reaches auth here. Modules written before this entry existed
 * still import auth's files directly (`auth.service.ts`, the middleware's
 * request augmentation, `account-admission.ts`); each moves here as it is
 * touched, and what it needs is added here then — this file holds what is
 * offered, not everything auth has.
 */
export {
  ACCOUNT_DEACTIVATED_MESSAGE,
  AccountAdmissionRefusedError,
  AccountChangeRefusedError,
  AccountDeactivatedError,
  AuthBackendError,
  SESSION_ENDED_MESSAGE,
  SessionEndedError,
  admitEveryone,
  type AccountAdmissionVerdict,
  type AccountProvisionReason,
  type IAccountAdmission,
} from './account-admission.js';
// A constant-time comparison for a secret arriving on a request, so a
// shared-secret check elsewhere cannot leak the secret's length or prefix by
// timing — one implementation, auth's.
export { timingSafeStringEqual } from './password-hash.js';
// The Express `Request` augmentation (`req.userId`, …): a module whose routes
// read it imports this entry, never the middleware file.
import './auth.middleware.js';
// Reached by other modules; exported here so they stop importing the files.
export type { IAccountSwitchGuard } from './account-switch-guard.js';
export type { AuthService } from './auth.service.js';
// What a DISTRIBUTION's sign-in provider needs: the plugin contract it
// implements, the one place the auth cookie's attributes are spelled (so an
// SSO provider sets the same cookie password login sets), and the one rule
// for its `Secure` flag. bevel-platform's Microsoft provider imported the
// files for these.
export type { AuthProviderPlugin } from './auth.routes.js';
export { AUTH_COOKIE_NAME, authCookieSecure, setAuthCookie } from './auth.middleware.js';
