/** Shown beside a relative change-request `url` so a caller knows how to get an absolute one. */
export const CHANGE_REQUEST_URL_NOTE = 'Set PUBLIC_FRONTEND_URL to get absolute links.';

/**
 * The base a change-request link is built on: the configured public frontend
 * address reduced to origin + path prefix. Credentials, query and fragment are
 * dropped so nothing but the public location can reach the link. Null when no
 * address is configured or it does not parse as http(s).
 */
export function changeRequestLinkBase(configured: string | null | undefined): string | null {
  const raw = configured?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * The link a person can open for change request `number`: absolute under
 * `base` (a proxied deployment's path prefix included), else the in-app
 * relative path plus a note on how to make it absolute. Only the number goes
 * into the path — never a branch name.
 */
export function changeRequestLink(
  number: number,
  base: string | null,
): { url: string; urlNote?: string } {
  const path = `/change-requests/${number}`;
  return base ? { url: `${base}${path}` } : { url: path, urlNote: CHANGE_REQUEST_URL_NOTE };
}
