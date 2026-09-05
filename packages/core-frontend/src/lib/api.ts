const TOKEN_KEY = 'bevel_token';

/**
 * Window event dispatched when an API call fails at the transport level —
 * the fetch itself rejected (backend/container down, connection refused) or
 * the reverse proxy answered for a dead upstream (502/503/504). The
 * MaintenanceOverlay listens for this, confirms via /api/health, and takes
 * over the screen during a redeploy. Application-level errors (4xx, 500)
 * are NOT signalled — those mean the backend is up and responding. Neither is
 * an aborted request, which says nothing about the backend at all.
 */
export const API_UNREACHABLE_EVENT = 'bevel:api-unreachable';

const PROXY_DOWN_STATUSES = new Set([502, 503, 504]);

function signalUnreachable(): void {
  window.dispatchEvent(new Event(API_UNREACHABLE_EVENT));
}

/**
 * Whether a rejection is a caller aborting its own request rather than a
 * transport failure.
 *
 * The signal is asked first because it is the only reliable witness:
 * `abort(reason)` rejects the fetch with THAT reason, which can be any value
 * and carries no marking of its own. Only the signal the fetch actually ran on
 * is asked — `init`'s wins where it has one, and a `Request` input's is used
 * only otherwise — so a stale signal on a Request that `init` overrode cannot
 * mask a real transport failure on the live one.
 *
 * The rejection is consulted as a fallback, for an abort whose signal never
 * reached us; there it is matched by `name` rather than `instanceof
 * DOMException`, which does not hold across realms.
 */
function wasAborted(input: RequestInfo | URL, init: RequestInit | undefined, err: unknown): boolean {
  const requestSignal =
    typeof input === 'object' && 'signal' in input ? (input as Request).signal : undefined;
  const signal = init?.signal ?? requestSignal;
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
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

export interface AuthFetchOptions {
  /**
   * Recognise a response that carries one of the proxy-down statuses but is
   * in fact the BACKEND answering — an ordinary result of this endpoint, not
   * the proxy standing in for a dead upstream. `POST /api/sync` says 503 when
   * a branch could not be pulled, and marks every response it writes with a
   * header a proxy never sets; the caller checks for that marker here. A
   * status alone is never enough: a proxy 503 looks identical by status.
   * Network failures always signal, whatever this returns.
   */
  isApplicationResponse?: (response: Response) => boolean;
}

/**
 * Fetch wrapper that injects the Authorization header from localStorage.
 * On 401 responses, clears the stored token.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts: AuthFetchOptions = {},
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(input, { ...init, headers });
  } catch (err) {
    // An abort is the caller's own doing, not the backend going away: the
    // binary viewers abort in flight on unmount and on every file switch.
    // Signalling here would probe /api/health on ordinary navigation and
    // could raise the maintenance overlay when a probe transiently fails.
    if (!wasAborted(input, init, err)) signalUnreachable();
    throw err;
  }

  if (PROXY_DOWN_STATUSES.has(response.status) && !opts.isApplicationResponse?.(response)) {
    signalUnreachable();
  }

  if (response.status === 401) {
    clearToken();
  }

  return response;
}
