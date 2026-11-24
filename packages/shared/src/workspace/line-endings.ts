/**
 * Which line ending a file's rewritten lines get, and putting a file's own
 * endings back on text that lost them. Shared by the server (the access
 * model's splice) and the browser (the editors), so the two never answer
 * "which ending?" differently.
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

/** `text` cut after each LF, so every line keeps its own ending; the last may have none. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A line without its ending. */
function bodyOf(line: string): string {
  return line.replace(/\r?\n$/, '');
}

/** The same line, endings aside: the same text, and both end or neither does. */
function sameLine(a: string, b: string): boolean {
  return bodyOf(a) === bodyOf(b) && a.endsWith('\n') === b.endsWith('\n');
}

/**
 * `edited` with `original`'s line endings put back.
 *
 * An editor built on a `<textarea>` hands its text back with LF endings
 * whatever it was given (the HTML standard normalises a textarea's value), so
 * a CRLF file saved from it would come back rewritten on every line. Given the
 * text the editor was opened on and the text it hands back:
 *
 *  - the lines before the first changed line and after the last one keep the
 *    ending they had in `original`, byte for byte;
 *  - the lines from the first changed line to the last take
 *    {@link dominantEol} of `original` as their ending (a last line with no
 *    ending keeps none).
 *
 * So text nobody changed comes back exactly as `original`, an all-CRLF or
 * all-LF file keeps its ending on every line, and one edit to a mixed file
 * changes only the lines it touched. Only CRLF and LF are line endings here.
 */
export function restoreLineEndings(original: string, edited: string): string {
  const before = linesOf(original);
  const after = linesOf(edited);
  let head = 0;
  while (head < before.length && head < after.length && sameLine(before[head], after[head])) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    sameLine(before[before.length - 1 - tail], after[after.length - 1 - tail])
  ) {
    tail++;
  }
  const eol = dominantEol(original);
  let out = before.slice(0, head).join('');
  for (const line of after.slice(head, after.length - tail)) {
    out += line.endsWith('\n') ? bodyOf(line) + eol : line;
  }
  return out + before.slice(before.length - tail).join('');
}
