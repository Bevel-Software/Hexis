import { useEffect, type ReactNode } from 'react';
import { AuthContext, useAuthState } from '../../src/modules/auth';

declare global {
  interface Window {
    /** Sign out through the session hook above a page mounted `signedIn`. */
    signOutHtmlPage(): void;
  }
}

/** The app's auth gate in little: the real session hook, its children only while someone is signed in. */
export function SignedIn({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  useEffect(() => {
    window.signOutHtmlPage = auth.logout;
  }, [auth.logout]);
  return <AuthContext.Provider value={auth}>{auth.user ? children : null}</AuthContext.Provider>;
}
