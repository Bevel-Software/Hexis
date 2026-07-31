/**
 * The ONE `---` frontmatter splitter, shared by backend and frontend so no file
 * type grows its own regex. Splits a leading `---`-fenced YAML block from the
 * body; null when the text doesn't open with a fence. Parsing the YAML inside is
 * the caller's concern (the access-control resolver deliberately keeps its own
 * hardened line-based reader — see `modules/access/access-splice.ts`).
 */
export function extractFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { frontmatter: m[1], body: m[2] };
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
  const fmLines = fm.frontmatter.split(/\r?\n/);
  const idx = fmLines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) fmLines[idx] = line;
  else fmLines.unshift(line);
  return `---${eol}${fmLines.join(eol)}${eol}---${eol}${fm.body}`;
}
