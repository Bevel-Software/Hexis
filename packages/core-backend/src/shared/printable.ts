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
 * That is CR and LF, the other mandatory breaks — vertical tab, form feed
 * and NEL (U+0085) — and the Unicode line separators U+2028/U+2029 with them:
 * `JSON.stringify` leaves the last three raw, so a path that carries one
 * survives being carried — in the `path` field of a not-found body, in a log
 * line — and breaks the line wherever it is finally rendered. {@link printable}
 * escapes them for exactly that reason.
 *
 * Unquoted, unlike {@link printable}: this text is read by a person or an
 * agent inside a sentence that already quotes it, not by an operator scanning
 * a log. THE spelling for that job — `displayPath` in the file readers is this
 * function, and the missing-path refusals use it too, so a path reads the same
 * however it is refused.
 */
const LINE_BREAKING: ReadonlyMap<string, string> = new Map([
  ['\r', '\\r'],
  ['\n', '\\n'],
  ['\v', '\\v'],
  ['\f', '\\f'],
  ['\u0085', '\\u0085'],
  ['\u2028', '\\u2028'],
  ['\u2029', '\\u2029'],
]);

export function sanitizedPath(text: string): string {
  return text.replace(/[\r\n\v\f\u0085\u2028\u2029]/g, (c) => LINE_BREAKING.get(c) ?? c);
}
