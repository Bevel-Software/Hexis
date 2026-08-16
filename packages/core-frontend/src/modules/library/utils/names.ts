/**
 * Rendering people's names the way a person says them.
 *
 * Shared by the locked-plugin view (its request toast) and the owner-side
 * access-requests banner: both list requesters, and two copies of this drifted
 * into place once already.
 */

/**
 * `A`, `A and B`, `A, B and C` — the way a person lists people out loud.
 *
 * The run-by lede uses `ownersTextOf`'s plainer comma join instead, because
 * that line is a label the whole Library shares and this is a sentence spoken
 * once.
 */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * First whitespace token of each name — "Olga Ivanova" → "Olga".
 *
 * For confirmations, not records: "Asked Olga" is how the person who just
 * clicked would say it. Role names ("GTM Team" → "GTM") survive this the same
 * way, which reads oddly but never wrongly.
 */
export function firstNames(names: string[]): string[] {
  return names.map((n) => n.trim().split(/\s+/)[0] ?? n).filter((n) => n.length > 0);
}
