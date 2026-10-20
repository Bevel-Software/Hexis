/**
 * Auth's public surface: who is signed in (`useAuth`), the state and screens
 * the shell mounts for signing in and the account page, and the account
 * reads and writes an administrator's screens call. Other modules import
 * these from here rather than reaching into auth's files.
 */
export { AccountPage } from './components/AccountPage';
export { LoginScreen } from './components/LoginScreen';
export { useAuthState } from './hooks/useAuthState';
export {
  type AccountReferences,
  type AccountSummary,
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccountReferences,
  listAccounts,
  reactivateAccount,
} from './services/account.api';
export { type LoginProviders, takePostLoginRedirect } from './services/sso';
export { AuthContext, useAuth } from './state/auth.context';
export { useSignInMethods } from './state/use-sign-in-methods';
