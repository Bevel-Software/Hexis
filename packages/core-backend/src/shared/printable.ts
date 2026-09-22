/**
 * Re-export, so this backend's ~20 call sites keep their short import while
 * the function itself lives where BOTH MCP surfaces can reach it.
 *
 * The local server (`@bevel-software/hexis-mcp`) is published standalone and
 * cannot import this package, but it logs the same kind of text — a reason
 * string that came off the network — to the same kind of operator log. Two
 * copies of an escaper is two escapers that drift, so it moved to the one
 * package both already depend on. See `printable` there for what it escapes
 * and why.
 */
export { printable } from '@bevel-software/platform-mcp-core';

/**
 * A path (or any short text) as it may be interpolated into a ONE-LINE
 * message: every character a caller can put in a filename that RENDERS as a
 * line break is escaped, so a refusal naming the path stays one line and
 * cannot forge a second.
 *
 * That is every C0 and C1 control character — CR and LF, the other mandatory
 * breaks (vertical tab, form feed, NEL), and the one-byte escapes a terminal
 * obeys (U+009B starts an ANSI sequence on its own) — and the Unicode line
 * separators U+2028/U+2029 with them: `JSON.stringify` leaves the C1 range
 * and the separators raw, so a path that carries one survives being carried
 * — in the `path` field of a not-found body, in a log line — and breaks or
 * steers the line wherever it is finally rendered. {@link printable} escapes
 * the same set for exactly that reason; the spelling is the same too (`\n`,
 * `\t`, else `\uXXXX`), so a path reads alike in a refusal and in a log.
 *
 * Unquoted, unlike {@link printable}: this text is read by a person or an
 * agent inside a sentence that already quotes it, not by an operator scanning
 * a log. THE spelling for that job — `displayPath` in the file readers is this
 * function, and the missing-path refusals use it too, so a path reads the same
 * however it is refused.
 */
const NAMED_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\r', '\\r'],
  ['\n', '\\n'],
  ['\t', '\\t'],
  ['\v', '\\v'],
  ['\f', '\\f'],
]);
// Built rather than written: the lint rule against control characters in a
// regex literal guards against accidental ones, and these are the point.
const CONTROL_OR_SEPARATOR = new RegExp(`[\\x00-\\x1F\\x7F-\\x9F${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

export function sanitizedPath(text: string): string {
  return text.replace(
    CONTROL_OR_SEPARATOR,
    (c) => NAMED_ESCAPES.get(c) ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
