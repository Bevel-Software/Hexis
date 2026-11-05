/**
 * Name matching for the toolbar's search palette.
 *
 * NAME search, deliberately, and nothing cleverer: a query is matched as one
 * case-insensitive substring of an item's name, and the matches are ordered
 * by WHERE the query landed. No fuzzy matching — a palette that offers
 * "Pricing" for "pcg" teaches people to distrust its first row, and the first
 * row is the one Enter opens.
 *
 * Three tiers, best first:
 *
 *  0. the name STARTS with the query        (`pri` → "Pricing")
 *  1. a WORD of the name starts with it     (`pri` → "Team pricing")
 *  2. the query is anywhere in the name     (`pri` → "Enterprise")
 *
 * Within a tier the shorter name wins (the query is more of it), then the
 * alphabet, then the order the caller listed the items in — so an empty query
 * returns the caller's own order untouched, which is how the palette shows its
 * starting suggestions.
 *
 * Pure, with no React and no DOM: the ranking is the part worth pinning with
 * tests, and it is tested without rendering anything.
 */

/** Lowercased, accents folded, whitespace collapsed — what both sides are compared as. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A letter or digit at the very END of the text — the character just before a
 * match. Tested against the whole prefix rather than `text[at - 1]` because
 * that indexes UTF-16 code units: a letter outside the Basic Multilingual
 * Plane (`𝐀`, the later CJK ideographs) is two of them, and its trailing half alone
 * is no letter, so a mid-word match after one would pass for a word start.
 * The `u` flag reads the prefix by code point.
 */
const ENDS_IN_WORD_CHAR = /[\p{L}\p{N}]$/u;

/**
 * The tier `query` matches `name` at, or null for no match. Both arguments
 * are normalized here; an empty query matches everything at the worst tier,
 * so it never reorders anything.
 */
export function matchTier(name: string, query: string): 0 | 1 | 2 | null {
  const q = normalizeForMatch(query);
  if (!q) return 2;
  const n = normalizeForMatch(name);
  let at = n.indexOf(q);
  if (at === -1) return null;
  if (at === 0) return 0;
  // Any occurrence at a word start counts, not just the first: `an` in
  // "Banana and" first lands mid-word, then again at the start of "and".
  while (at !== -1) {
    if (!ENDS_IN_WORD_CHAR.test(n.slice(0, at))) return 1;
    at = n.indexOf(q, at + 1);
  }
  return 2;
}

/**
 * The items whose name contains `query`, best first, at most `limit` of them.
 * `nameOf` is what is matched — the name a person would type, not the path.
 */
export function rankByName<T>(
  items: readonly T[],
  query: string,
  nameOf: (item: T) => string,
  limit: number,
): T[] {
  return rankByNames(items, query, (item) => [nameOf(item)], limit);
}

/**
 * {@link rankByName} for items known by more than one name — a command's
 * label and the words someone might type for it instead ("Invite people" for
 * `team`). An item ranks at the BEST tier any of its names reaches; ties are
 * broken on the FIRST name, the one on screen, so two rows that matched
 * equally still read in a sensible order.
 */
export function rankByNames<T>(
  items: readonly T[],
  query: string,
  namesOf: (item: T) => readonly string[],
  limit: number,
): T[] {
  if (!normalizeForMatch(query)) return items.slice(0, limit);
  const scored: { item: T; tier: number; name: string; index: number }[] = [];
  items.forEach((item, index) => {
    const names = namesOf(item);
    let tier: number | null = null;
    for (const n of names) {
      const t = matchTier(n, query);
      if (t !== null && (tier === null || t < tier)) tier = t;
    }
    if (tier !== null) scored.push({ item, tier, name: names[0] ?? '', index });
  });
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.index - b.index,
  );
  return scored.slice(0, limit).map((s) => s.item);
}
