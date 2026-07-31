import type { AuthUser, LoginResponse } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Login failed');
  }
  return res.json();
}

export async function fetchCurrentUser(): Promise<AuthUser> {
  const res = await authFetch('/api/auth/me');
  if (!res.ok) throw new Error('Not authenticated');
  return res.json();
}
