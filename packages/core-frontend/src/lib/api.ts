const TOKEN_KEY = 'bevel_token';

/**
 * Window event dispatched when an API call fails at the transport level —
 * the fetch itself rejected (backend/container down, connection refused) or
 * the reverse proxy answered for a dead upstream (502/503/504). The
 * MaintenanceOverlay listens for this, confirms via /api/health, and takes
 * over the screen during a redeploy. Application-level errors (4xx, 500)
 * are NOT signalled — those mean the backend is up and responding.
 */
export const API_UNREACHABLE_EVENT = 'bevel:api-unreachable';

const PROXY_DOWN_STATUSES = new Set([502, 503, 504]);

function signalUnreachable(): void {
  window.dispatchEvent(new Event(API_UNREACHABLE_EVENT));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Fetch wrapper that injects the Authorization header from localStorage.
 * On 401 responses, clears the stored token.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (err) {
    signalUnreachable();
    throw err;
  }

  if (PROXY_DOWN_STATUSES.has(response.status)) {
    signalUnreachable();
  }

  if (response.status === 401) {
    clearToken();
  }

  return response;
}
