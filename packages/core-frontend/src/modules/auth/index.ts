/**
 * What the auth module offers the other modules. A consumer outside the
 * module imports from here, never from the files: they are the module's own
 * layout and free to move. Export what another module needs; nothing more.
 */
export { useAuthState } from './hooks/useAuthState';
export { LoginScreen } from './components/LoginScreen';
export { createAccount, deactivateAccount, deleteAccount, getAccountReferences, listAccounts, reactivateAccount } from './services/account.api';
export type { AccountReferences, AccountSummary } from './services/account.api';
export { OAUTH_ERROR_KEY, startSsoLogin, takePostLoginRedirect } from './services/sso';
export type { LoginProviders, SsoProvider } from './services/sso';
export { AuthContext, useAuth, type AuthContextValue } from './state/auth.context';
export { useSignInMethods } from './state/use-sign-in-methods';
