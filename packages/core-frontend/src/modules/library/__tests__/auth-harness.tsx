import { vi } from 'vitest';
import type { ReactNode } from 'react';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';

/**
 * The signed-in user, for tests that render a Library surface.
 *
 * The Library names a person's own space after them ("Juan's Plugin"), so the
 * sidebar and the all-plugins index now read `useAuth`. In production that is
 * free — nothing under `CoreAppShell` renders before a user exists — but a
 * test that mounts a page in isolation has no provider above it, and `useAuth`
 * throws rather than returning null.
 *
 * One harness rather than a provider pasted into each suite: the display name
 * is asserted in several files, and it should be one fact in one place.
 */

/** The name every Library suite expects to see reflected back. */
export const TEST_USER_NAME = 'Juan Viera';

/** What `personalPluginName(TEST_USER_NAME)` produces — assert against this. */
export const TEST_PERSONAL_GROUP = "Juan's Plugin";

export function authValue(over: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: { id: 'u1', email: 'juan@bevel.software', name: TEST_USER_NAME },
    token: 'test-token',
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    ...over,
  };
}

export function withAuth(children: ReactNode, over?: Partial<AuthContextValue>) {
  return <AuthContext.Provider value={authValue(over)}>{children}</AuthContext.Provider>;
}
