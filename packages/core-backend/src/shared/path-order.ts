/**
 * The ONE ordering of repository paths: component by component, each
 * component by `localeCompare`, a shorter path before its extensions. It is
 * exactly the order a directory walk that sorts each level's entries visits
 * them in — so a consumer that must agree with the walk on "first by path"
 * (plugin discovery keeps the first of two folders sharing a slug; principal
 * synthesis must pick the same one) sorts with this and nothing else. A
 * whole-string `localeCompare` does not agree: it weighs the separator
 * against the next character (`a-b/x` before `a/b/x`), the walk never does.
 *
 * TOTAL over distinct paths: two components the collation cannot tell apart
 * (a precomposed `é` and its decomposed spelling) fall through to code-unit
 * order, so no pair of distinct paths ever compares equal — an equal pair
 * would leave "first" to whichever enumeration happened to run, and the two
 * consumers could then pick different folders for one slug.
 */
export function comparePathComponents(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const order = compareComponent(as[i]!, bs[i]!);
    if (order !== 0) return order;
  }
  return as.length - bs.length;
}

/** One component against another: collation first, code units to break a tie. */
function compareComponent(a: string, b: string): number {
  const order = a.localeCompare(b);
  if (order !== 0) return order;
  return a < b ? -1 : a > b ? 1 : 0;
}
