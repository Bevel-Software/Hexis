/**
 * The TWO orderings of repository paths, and which consumer takes which:
 *
 * - {@link comparePathComponents} is the platform's own walk order — component
 *   by component, each by `localeCompare`, a shorter path before its
 *   extensions — exactly the order a directory walk that sorts each level's
 *   entries visits them in. A consumer that must agree with THAT walk on
 *   "first by path" (plugin discovery keeps the first of two folders sharing a
 *   slug; principal synthesis must pick the same one) sorts with it and
 *   nothing else.
 * - {@link compareSearchPaths} is ripgrep's walk order (`--sort path`):
 *   component by component, each by its UTF-8 bytes. A `grep` answer is
 *   assembled from several ripgrep runs and a document pass, and it has to
 *   sort as ripgrep itself sorts, or the search could not tell which files a
 *   run has passed. The two orders differ where collation and bytes do
 *   (`B.md` sorts before `a.md` by bytes, after it by collation), which is why
 *   a grep answer and the explorer tree can list two siblings the other way
 *   round. Nothing but the search uses it.
 *
 * Both agree on the shape: a whole-string compare does not — it weighs the
 * separator against the next character (`a-b/x` before `a/b/x`), a walk never
 * does.
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

/**
 * The order every `grep` search answers in — ripgrep's: path component by
 * component, each compared by its UTF-8 bytes, so a folder's files come before
 * a sibling file whose name extends the folder's. See the note above on how it
 * differs from {@link comparePathComponents}, and why the search needs it.
 */
export function compareSearchPaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const c = Buffer.compare(Buffer.from(as[i]!, 'utf8'), Buffer.from(bs[i]!, 'utf8'));
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}
