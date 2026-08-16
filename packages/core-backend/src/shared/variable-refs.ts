/**
 * The ONE variable-reference grammar, shared by every boundary that has to
 * decide "would the substitutor expand this?" — `.tool` parsing, `mcp.json`
 * discovery, the server editor's header split, and the Groups→Plugins
 * migration. The decision has credential stakes on both sides (a reference
 * mis-read as prose is a `${VAR}` written into portable, world-readable
 * `mcp.json`; prose mis-read as a reference is a header that stops working),
 * so the classifiers must not each keep their own approximation of it.
 */

/**
 * The SDK substitutor's reference grammar, exactly: `${VAR}` or `$VAR`, names
 * `[a-zA-Z0-9_]+`. Note a LEADING DIGIT is legal — `$5TOKEN` (and `$5` in
 * prose) is a reference as far as substitution is concerned, and classifying
 * it as anything else here would diverge from what actually expands.
 */
export const VARIABLE_REFERENCE_RE = /\$\{([a-zA-Z0-9_]+)\}|\$([a-zA-Z0-9_]+)/g;

// `.test()` on a global regex is stateful (lastIndex persists across calls) —
// the predicate gets its own non-global compilation of the same source.
const VARIABLE_REFERENCE_ONCE = new RegExp(VARIABLE_REFERENCE_RE.source);

/** True when any substring of `text` is a substitutor reference. */
export function containsVariableReference(text: string): boolean {
  return VARIABLE_REFERENCE_ONCE.test(text);
}

/**
 * Variable names the platform seeds for its own (Bevel-hosted) manuals:
 * `<ns>_API_URL` points a manual at the backend and `<ns>_CONNECTION_KEY`
 * carries the platform bearer. User-declared variables may not take these
 * names, and user content may not reference them (bare or namespaced).
 */
export const RESERVED_VARIABLE_NAMES: readonly string[] = ['API_URL', 'CONNECTION_KEY'];
