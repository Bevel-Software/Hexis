/** Decode a URL hash (`#some%20slug`) to its bare slug, tolerating bad escapes. */
function safeDecodeHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Escape a slug for safe interpolation into an attribute-selector string. */
function escapeForSelector(value: string): string {
  return (
    value
      .replace(/["\\]/g, '\\$&')
      // CSS-hex-escape control characters (newline, CR, …): a raw control char in
      // a CSS string is a syntax error that would make querySelector throw. The
      // trailing space terminates the hex escape.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)
  );
}

/**
 * Scroll the heading a fragment names (`#goal`, the id rehype-slug gave it)
 * into view inside `container` — the one way a rendered markdown file goes
 * to one of its own sections: the file page on its address's fragment, the
 * skill page on a section link's. A fragment naming nothing does nothing.
 */
export function scrollToHeading(container: ParentNode | null, hash: string): void {
  const slug = hash ? safeDecodeHash(hash) : '';
  if (!slug || !container) return;
  const target = container.querySelector(`[id="${escapeForSelector(slug)}"]`);
  target?.scrollIntoView({ block: 'start' });
}
