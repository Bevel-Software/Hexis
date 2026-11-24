/**
 * Which line ending a file's rewritten lines get. Shared by the server and the
 * browser, so the two never answer "which ending?" differently.
 */

/**
 * The line ending a rewrite of `text` should use: the one MOST of its lines
 * already use.
 *
 * A consistent file (all LF, or all CRLF, which is every file git checks out)
 * gets its own ending, and a MIXED file the one it mostly already has, so the
 * fewest lines change. The rule this replaced was "CRLF if the text contains
 * one anywhere", which let a single stray CRLF (in the body, in a comment)
 * rewrite every line of a knowledge base's access rules as churn in somebody's
 * change request. Ties (and a file with no line breaks at all) go to the
 * file's FIRST ending, so the answer is always the file's own.
 */
export function dominantEol(text: string): string {
  let crlf = 0;
  let lf = 0;
  let firstIsCrlf = false;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    const isCrlf = i > 0 && text[i - 1] === '\r';
    if (crlf + lf === 0) firstIsCrlf = isCrlf;
    if (isCrlf) crlf++;
    else lf++;
  }
  if (crlf > lf) return '\r\n';
  if (lf > crlf) return '\n';
  return firstIsCrlf ? '\r\n' : '\n';
}
