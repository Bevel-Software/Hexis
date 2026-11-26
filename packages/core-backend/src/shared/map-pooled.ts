/**
 * `items.map(fn)` with at most `limit` calls in flight, results in input
 * order: the one way the server runs many reads or requests without starting
 * them all at once (an unbounded `Promise.all` over a knowledge base's
 * thousands of files trips EMFILE). At least one call is in flight, whatever
 * `limit` says, so a limit of 0 still answers every item. At
 * `limit >= items.length` every call starts in the same tick. The first call
 * that fails rejects the map, and no call starts after it; those already
 * under way finish, unheard.
 */
export async function mapPooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  // Once a call fails the whole map has failed: no worker starts another.
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
