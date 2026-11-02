/**
 * The error codes a token endpoint may answer with, as RFC 6749 §5.2 and OIDC
 * Core §3.1.2.6 define them. A finite list, on purpose: a code is taken from
 * a refusing provider's body only when it is exactly one of these, so no other
 * string a provider puts in that field (a secret, a secret with a suffix, free
 * text) reaches a message, a verdict or a log.
 *
 * Shared, not a module's own: the OIDC configuration check reads a provider's
 * refusal through it and the secrets vault a token endpoint's, and one list is
 * the only way the two cannot disagree about which codes are standard. Each
 * caller keeps its own sentence per code (what a tool owner should do differs
 * from what a sign-in administrator should do); the set of codes is one.
 */
export const OAUTH_TOKEN_ERROR_CODES: readonly string[] = Object.freeze([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
]);

/** Whether `code` is one of the standard token-endpoint error codes, and so safe to echo. */
export function isStandardTokenErrorCode(code: unknown): code is string {
  return typeof code === 'string' && OAUTH_TOKEN_ERROR_CODES.includes(code);
}

/**
 * The standard `error` code in a refusing token endpoint's JSON body, or null:
 * when the body is not JSON, not an object, carries no string `error`, or
 * carries one that is not a standard code.
 */
export function standardTokenErrorCode(bodyText: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { error } = json as Record<string, unknown>;
  return isStandardTokenErrorCode(error) ? error : null;
}
