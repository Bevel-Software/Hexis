import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Knowledge holds the design system, not a second one.
 *
 * The repo-wide `ds:check` ratchet is a COUNTER with slack — it would happily
 * accept a raw `bg-amber-50` reappearing here as long as something else
 * elsewhere went down. This is the module-scoped version of the same rule, and
 * it is a hard zero: the slate palette taught us that an off-system colour
 * fails SILENTLY (Tailwind emits no rule, the text renders at the inherited
 * colour, nothing errors), so counting is the only thing that catches it.
 *
 * If a genuinely new status colour is ever needed, it goes in
 * `shared/theme/tokens.css` and gets a name — it does not come back as a
 * number.
 */

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const RAW_PALETTE =
  /\b(?:bg|text|border|ring|divide|from|via|to|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|amber|yellow|green|emerald|teal|cyan|blue|indigo|violet|purple|fuchsia|pink|rose|orange|lime|sky)-\d{2,3}\b/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The module, walked and read ONCE. Three checks over the same few dozen files
 * is three walks and three reads of every one of them otherwise, for an answer
 * that cannot have changed between them.
 */
const FILES = sourceFiles(MODULE_DIR).map((file) => ({
  name: relative(MODULE_DIR, file),
  source: readFileSync(file, 'utf8'),
}));

/**
 * The string literals in a file, comments excluded.
 *
 * `rounded` is also an ordinary English word, and these files carry more prose
 * than code — matching the raw source flags every sentence that uses it. Class
 * names only ever live inside a string, so that is the only place worth
 * looking. It is a scanner rather than a regex because a regex cannot skip
 * comments, and one apostrophe in one of them ("doesn't") opens a quote that
 * swallows the rest of the file.
 *
 * What it does NOT do is tell a class list from an English sentence that
 * happens to be a string literal. Deliberate: the failure it would trade for
 * is a MISSED bare `rounded`, and this check exists because that one fails
 * silently. A false positive costs one glance — which is why the failure
 * prints the literal it matched.
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      if (eol === -1) break;
      i = eol;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let value = '';
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        value += source[i];
        i++;
      }
      out.push(value);
    }
  }
  return out;
}

/** Every distinct match of `re` in `source`, or null when there are none. */
function offendersIn(source: string, re: RegExp): string[] | null {
  const matches = source.match(re);
  return matches ? [...new Set(matches)] : null;
}

describe('modules/workspace design-system parity', () => {
  it('uses no raw Tailwind palette colours anywhere', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      const matches = offendersIn(source, RAW_PALETTE);
      if (matches) offenders.push(`${name}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses no off-scale font sizes', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      const matches = offendersIn(source, /\btext-\[[0-9.]+px\]/g);
      if (matches) offenders.push(`${name}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('uses no bare `rounded`', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      // Anchored on a class-list boundary rather than `\b`, so `rounded` as a
      // standalone utility is caught and `rounded-lg` is not.
      const hits = stringLiterals(source).filter((literal) =>
        /(?:^|\s)rounded(?=\s|$)/.test(literal),
      );
      // Report WHAT matched, like the other two — a bare filename leaves you
      // grepping a 900-line component for a word that is also in its prose.
      if (hits.length) offenders.push(`${name}: ${[...new Set(hits)].join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
