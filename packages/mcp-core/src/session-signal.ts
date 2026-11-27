/*
 * The one rule for "the server has forgotten this session" on a single error:
 * HTTP 404 carrying JSON-RPC `-32001` or "Session not found". Session recovery
 * walks a failure's cause chain with it (`session-recovery.ts`), and the
 * redaction of a downstream failure keeps it readable on an error it would
 * otherwise withhold (`downstream-tool-errors.ts`), so a lost session is
 * still recovered when the call carried arguments and a secret.
 */

/** The JSON-RPC code the Streamable HTTP transport reserves for a missing session. */
const SESSION_NOT_FOUND_CODE = -32001;

/**
 * The HTTP status an error carries, or undefined when it carries none.
 *
 * The MCP SDK's `StreamableHTTPError` puts the HTTP status in `code`, which is
 * also where `McpError` puts its JSON-RPC code — and those two namespaces
 * OVERLAP on the very number this module cares about: `-32001` is "Session not
 * found" on the wire but `ErrorCode.RequestTimeout` in the SDK's own enum. The
 * range test is what keeps them apart: a JSON-RPC code is negative and can
 * never be read as a status, so a local request timeout never looks like a
 * session miss (and is never retried).
 */
function httpStatusOf(err: Record<string, unknown>): number | undefined {
  for (const key of ['code', 'status', 'statusCode'] as const) {
    const value = err[key];
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

/**
 * Does this error's text carry the session-not-found signal?
 *
 * The transport surfaces a failed POST as `Error POSTing to endpoint: <body>`,
 * so the server's JSON-RPC body rides along in the message and is the only
 * place the `-32001` is visible. Both halves of the spec's signal are accepted
 * — the code (structural) and the reserved message — because a server may send
 * either; requiring the 404 alongside is what keeps this from over-matching.
 */
function saysSessionNotFound(message: string): boolean {
  return (
    new RegExp(`"code"\\s*:\\s*${SESSION_NOT_FOUND_CODE}\\b`).test(message) ||
    /\bsession not found\b/i.test(message)
  );
}


/** Does this one error (not its cause) say the server has forgotten the session? */
export function statesSessionLoss(err: Record<string, unknown>): boolean {
  if (httpStatusOf(err) !== 404) return false;
  const message = err.message;
  return typeof message === 'string' && saysSessionNotFound(message);
}

/**
 * What a redacted error that states a session loss says instead of its own
 * words: the reserved message alone, which reads the same as the rule above and
 * carries nothing of the server's text.
 */
export const SESSION_LOST_MESSAGE = 'Session not found';
