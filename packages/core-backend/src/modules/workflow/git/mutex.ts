/**
 * Serializes async operations by key. Two `run(k, ...)` calls with the same key
 * execute sequentially in call order; different keys run independently.
 *
 * Prevents interleaved `git` invocations against a single workspace.
 */
export class WorkspaceMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) {
        this.tails.delete(key);
      }
    }
  }
}
