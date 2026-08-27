/**
 * Serializes async operations by key. Two `run(k, ...)` calls with the same key
 * execute sequentially in call order; different keys run independently.
 *
 * Prevents interleaved `git` invocations against a single workspace.
 */
export class WorkspaceMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.runAll([key], fn);
  }

  /**
   * Reserve SEVERAL keys for one operation, atomically.
   *
   * Nesting `run(a, () => run(b, fn))` does NOT do this: between taking `a`
   * and taking `b` there is a gap in which another operation can take `b`,
   * finish, and release it — so an operation holding both keys can still be
   * interleaved with one holding just the second. For branch lifecycle that
   * gap is the whole bug: a change request being opened `Y -> X` would hold
   * one branch's key while the other was deleted out from under it.
   *
   * This reserves the set in ONE synchronous step. The tails are read and
   * rewritten without an await between, so no other call can observe a
   * half-taken set: a concurrent `run` on any of these keys either already
   * sits in `prev` (it goes first) or chains onto `next` (it goes after).
   * Nothing is ever held while waiting for something else, so no ordering
   * discipline is needed and no deadlock is possible.
   *
   * Duplicate keys collapse; the operation waits on each distinct key once.
   *
   * Each predecessor is caught INDIVIDUALLY, before the `Promise.all`. A bare
   * `Promise.all` settles on the first rejection rather than waiting for the
   * rest, so one key's task failing early would start this one while another
   * key was still held — a failure on any key would punch a hole in the
   * mutual exclusion of every key beside it. Catching first makes the
   * combined promise wait for all of them to settle, however each ends.
   */
  async runAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const distinct = [...new Set(keys)];
    const prev = Promise.all(
      distinct.map((k) => (this.tails.get(k) ?? Promise.resolve()).catch(() => undefined)),
    );
    const next = prev.then(fn);
    for (const k of distinct) this.tails.set(k, next);
    try {
      return await next;
    } finally {
      for (const k of distinct) {
        if (this.tails.get(k) === next) {
          this.tails.delete(k);
        }
      }
    }
  }
}
