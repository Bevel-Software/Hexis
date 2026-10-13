/**
 * What the auth module offers the other modules: its contracts, and the two
 * things a module checking a credential or refusing a switched-off account
 * needs to agree with auth on. Everything else in this folder is auth's own
 * — the composition root wires it, nobody else reaches in.
 */
export {
  ACCOUNT_DEACTIVATED_MESSAGE,
  AccountAdmissionRefusedError,
  AccountChangeRefusedError,
  AccountDeactivatedError,
  AuthBackendError,
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
