/**
 * THE fence rule: a line is a frontmatter fence when, whitespace aside, it is
 * exactly `---`. Forgiving on purpose — an opening fence with a trailing space
 * or an indented fence is still a fence.
 *
 * Every reader in the platform asks this one function. The access model's
 * line scan always judged fences this way while the splitter below demanded
 * `---` at column 0, so a file written with a near-miss fence had access
 * rules that applied while the catalog, the tool manuals and the frontmatter
 * panel saw no frontmatter at all. One rule, asked everywhere, is what keeps
 * a file from meaning two things.
 */
export function isFrontmatterFence(line: string | undefined): boolean {
  return line?.trim() === '---';
}

/**
 * The ONE `---` frontmatter splitter, shared by backend and frontend so no file
 * type grows its own reader. Splits a leading fenced YAML block from the body;
 * null when the first line is not a fence or no later line closes it. Fences
 * are judged by {@link isFrontmatterFence}. Parsing the YAML inside is the
 * caller's concern (the access model keeps its own line scan, on the same
 * fence rule, because a splice must put bytes back exactly as it found them).
 *
 * `frontmatter` is the raw text between the fence lines and `body` the raw
 * text after the closing fence's line break, both byte for byte — line
 * endings included — so a caller that rebuilds the file changes nothing it
 * did not mean to.
 */
export function extractFrontmatter(text: string): { frontmatter: string; body: string } | null {
  // Walk the lines by offset rather than splitting, so both halves can be
  // sliced out of the original text with their own line endings intact.
  let start = 0;
  let lineIndex = 0;
  let openEnd = -1; // offset just past the opening fence's line break
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end).replace(/\r$/, '');
    const next = nl === -1 ? text.length + 1 : nl + 1;
    if (lineIndex === 0) {
      // A lone `---` with nothing after it opens nothing.
      if (!isFrontmatterFence(line) || nl === -1) return null;
      openEnd = next;
    } else if (isFrontmatterFence(line)) {
      // The frontmatter ends before the line break that precedes this fence.
      const fmEnd = start - (start >= 2 && text[start - 2] === '\r' ? 2 : 1);
      return {
        frontmatter: fmEnd > openEnd ? text.slice(openEnd, fmEnd) : '',
        body: next > text.length ? '' : text.slice(next),
      };
    }
    if (nl === -1) return null; // never closed
    start = next;
    lineIndex += 1;
  }
  return null;
}

/**
 * Set a top-level scalar key in a file's `---` frontmatter, LINE-based: replace an
 * existing `<key>:` line's value, else insert `<key>: <value>` at the top of the
 * block (creating a `---` block if the file has none). Deliberately NOT a
 * parse-and-re-serialize — a KB node's `nodeType:` quoted-markdown-link and access
 * lines are read by a hand-rolled regex parser that a full YAML re-emit would
 * corrupt, so every other line is preserved byte-for-byte. `value` is emitted as a
 * bare scalar; callers pass simple id/name strings (no quoting/escaping needed for
 * the `[a-z0-9_-]` id grammar).
 */
export function setFrontmatterField(text: string, key: string, value: string): string {
  const fm = extractFrontmatter(text);
  const line = `${key}: ${value}`;
  // Escape the key before interpolating — callers pass plain `id`/`name`, but a
  // metacharacter must never silently change what the line-matcher matches.
  const keyRe = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*$`);
  // Preserve the file's own line-ending convention: rebuilding a CRLF file with
  // bare `\n` would dirty every frontmatter line, breaking the byte-for-byte
  // guarantee this helper exists for. Judged from the FIRST line ending (the
  // fence line's own), so a stray CRLF deep in the body can't flip the block.
  const firstNl = text.indexOf('\n');
  const eol = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  if (!fm) {
    // No frontmatter — prepend a fresh block, keeping the original body intact.
    return `---${eol}${line}${eol}---${eol}${text}`;
  }
  // An empty block has no lines, not one empty line: splitting '' would give
  // [''], and the inserted key would be followed by a blank line before the
  // closing fence.
  const fmLines = fm.frontmatter === '' ? [] : fm.frontmatter.split(/\r?\n/);
  const idx = fmLines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) fmLines[idx] = line;
  else fmLines.unshift(line);
  return `---${eol}${fmLines.join(eol)}${eol}---${eol}${fm.body}`;
}
