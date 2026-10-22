/**
 * What the auth module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { useAuthState } from './hooks/useAuthState';
export { createAccount, deactivateAccount, deleteAccount, getAccountReferences, listAccounts, reactivateAccount } from './services/account.api';
export type { AccountReferences, AccountSummary } from './services/account.api';
export { takePostLoginRedirect } from './services/sso';
export type { LoginProviders } from './services/sso';
export { AuthContext, useAuth } from './state/auth.context';
export { useSignInMethods } from './state/use-sign-in-methods';
