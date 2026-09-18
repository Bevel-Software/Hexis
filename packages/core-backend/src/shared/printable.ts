/**
 * Untrusted text, rendered so it cannot forge or colour a log line.
 *
 * Anything a caller controls — a request header, a URL, a name from an
 * identity provider — may carry newlines or ANSI escapes, and interpolated
 * verbatim it would start a line of its own in the operator log, or paint
 * the terminal. `JSON.stringify` escapes the C0 controls (U+0000–U+001F)
 * plus quote and backslash; the C1 controls (U+007F–U+009F — including
 * U+009B, the one-byte CSI that starts an ANSI sequence on its own) and the
 * JS line separators U+2028/U+2029 pass through raw, so those are escaped
 * here. The result is one quoted token: `"python-httpx/0.28.1"`,
 * `"evil\n[forged]"`.
 *
 * Every log line that carries caller-supplied text goes through this, and
 * only this: the rule "the log is one line per event" is enforced at the
 * one place text enters a line, not by each call site remembering.
 */
export function printable(text: string): string {
  return JSON.stringify(text).replace(
    /[\x7F-\x9F\u{2028}\u{2029}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * A path (or any short text) as it may be interpolated into a ONE-LINE
 * message: every character a caller can put in a filename that RENDERS as a
 * line break is escaped, so a refusal naming the path stays one line and
 * cannot forge a second.
 *
 * That is CR and LF, and the Unicode line separators U+2028/U+2029 with them:
 * `JSON.stringify` leaves those two raw, so a path that carries one survives
 * being carried — in the `path` field of a not-found body, in a log line —
 * and breaks the line wherever it is finally rendered. {@link printable}
 * escapes the pair for exactly that reason.
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
  ['\u2028', '\\u2028'],
  ['\u2029', '\\u2029'],
]);

export function sanitizedPath(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]/g, (c) => LINE_BREAKING.get(c) ?? c);
}
