import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The reserved key of the REPOSITORY-LEVEL reservation: the one repository
 * every branch workspace is a worktree of (see `workspace/kb-repository.ts`).
 * A fetch, a garbage collection and a worktree add, remove or prune rewrite
 * what every worktree shares — the remote-tracking refs, the object store,
 * the repository's list of worktrees — so they take this key, and it waits
 * for every git operation in flight under a workspace key and holds back
 * every one that arrives after it.
 *
 * A NUL cannot be part of a branch name nor of its encoding as a workspace
 * id, so no workspace key can ever spell this one.
 */
export const REPOSITORY_KEY = '\u0000repository';

/** What the current async context holds of one mutex: a workspace key (as its running token), or the repository. */
type Held = { kind: 'workspace'; token: object } | { kind: 'repository' };

/**
 * Serializes async operations by key. Two `run(k, ...)` calls with the same key
 * execute sequentially in call order; different keys run independently.
 *
 * Prevents interleaved `git` invocations against a single workspace.
 *
 * Every workspace key is also a SHARED hold on the repository-level
 * reservation, {@link REPOSITORY_KEY}, which is exclusive: operations on two
 * worktrees run side by side, and an operation on the repository runs alone.
 * See {@link runRepository}.
 */
export class WorkspaceMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Which reservation the current async context is inside, if any. */
  private readonly held = new AsyncLocalStorage<Held>();

  /** Workspace-key operations that are RUNNING (past the repository gate, and not parked). */
  private readonly running = new Set<object>();
  /** Told whenever an operation leaves the running set — what a repository operation's drain waits on. */
  private runningLeft: Array<() => void> = [];

  private leaveRunning(token: object): void {
    if (!this.running.delete(token)) return;
    const waiters = this.runningLeft;
    this.runningLeft = [];
    for (const wake of waiters) wake();
  }

  /** Repository operations queued or running; while above zero, no workspace-key operation starts. */
  private repositoryWaiting = 0;
  /** Resolves when `repositoryWaiting` next drops to zero. */
  private repositoryIdle: Promise<void> = Promise.resolve();
  private releaseRepositoryIdle: () => void = () => undefined;

  /** The last repository operation, queued or running: repository operations run one at a time. */
  private repositoryTail: Promise<unknown> = Promise.resolve();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (key === REPOSITORY_KEY) return this.runRepository(fn);
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
   * Within one call nothing is ever held while waiting for something else,
   * so callers that do not nest need no ordering discipline and cannot
   * deadlock.
   *
   * NESTING is the one way to reintroduce hold-and-wait, so never nest
   * `run`/`runAll` calls on the same instance. An inner call chains behind
   * everything already queued on its keys, which can include a `runAll` that
   * is itself waiting for the outer call to finish: `run(b, () => run(a, …))`
   * was harmless when every operation took a single key, but against a
   * concurrent `runAll([a, b])` it deadlocks — outer waits inner, inner
   * waits the pair, the pair waits outer. No caller nests today; keep it
   * that way, or hand the full key set to one `runAll` at the top.
   * (The repository reservation is the one exception, and handles its own
   * nesting: see {@link runRepository}.)
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
    if (distinct.includes(REPOSITORY_KEY)) return this.runRepository(fn);
    // Inside a repository operation nothing else is running (it waited for
    // every workspace operation, and held the rest back), so a workspace key
    // it needs is free by construction. Queuing on the key would wait for an
    // operation that is itself held back by this one.
    const holding = this.held.getStore();
    if (holding?.kind === 'repository') return fn();
    const nested = holding?.kind === 'workspace';
    const prev = Promise.all(
      distinct.map((k) => (this.tails.get(k) ?? Promise.resolve()).catch(() => undefined)),
    );
    const next = prev.then(() => this.passRepositoryGate(nested, fn));
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

  /**
   * Run `fn` under the REPOSITORY-LEVEL reservation: after every repository
   * operation before it, after every workspace-key operation already running,
   * and before any workspace-key operation that has not started yet. For a
   * fetch, a garbage collection, and a worktree add, remove or prune — what
   * rewrites state every worktree of the repository shares.
   *
   * Called from INSIDE a workspace-key operation (a pull fetching before it
   * rebases, a merge fetching its two branches), it cannot wait for the
   * workspace operations that are running — the caller is one of them — so it
   * serializes with the other repository operations, and with every
   * workspace operation that has not started yet: it holds the gate as a
   * top-level one does, so nothing new starts beside it. Only the operations
   * already running (its caller among them) carry on. Called from inside a
   * repository operation it runs straight through: that reservation is
   * already this one.
   */
  async runRepository<T>(fn: () => Promise<T>): Promise<T> {
    const holding = this.held.getStore();
    if (holding?.kind === 'repository') return fn();

    this.holdRepositoryGate();
    try {
      if (holding?.kind === 'workspace') return await this.afterRepositoryTail(fn);
      // Drained BEFORE taking a place in the repository queue, never while
      // holding one: a running workspace operation may itself need the queue
      // for a nested fetch, and would wait for this, which waits for it.
      // Nothing joins the running set once the count above went up, except a
      // nested call from an operation already in it, or one coming back from
      // being parked (see `whileParked`), which waits at the gate first.
      while (this.running.size > 0) {
        await new Promise<void>((resolve) => this.runningLeft.push(resolve));
      }
      return await this.afterRepositoryTail(fn);
    } finally {
      if (--this.repositoryWaiting === 0) this.releaseRepositoryIdle();
    }
  }

  /** Count one more repository operation queued or running; the first closes the gate. */
  private holdRepositoryGate(): void {
    if (this.repositoryWaiting++ === 0) {
      this.repositoryIdle = new Promise<void>((resolve) => {
        this.releaseRepositoryIdle = resolve;
      });
    }
  }

  /**
   * Wait for `pending` — something another caller started and this one joins:
   * a branch's first checkout being made, a fetch already in flight — WITHOUT
   * counting as running meanwhile. Inside a workspace operation, the thing
   * joined may be a repository operation that is waiting for every running
   * workspace operation, this one included; counted as running, each would
   * wait for the other forever. Parked, the repository operation goes ahead,
   * and this one comes back through the repository gate before it carries on.
   * Outside a workspace operation it is a plain wait.
   */
  async whileParked<T>(pending: Promise<T>): Promise<T> {
    const holding = this.held.getStore();
    if (holding?.kind !== 'workspace' || !this.running.has(holding.token)) return pending;
    this.leaveRunning(holding.token);
    try {
      return await pending;
    } finally {
      while (this.repositoryWaiting > 0) await this.repositoryIdle;
      this.running.add(holding.token);
    }
  }

  /** Run after every repository operation queued before it, as one of them. */
  private afterRepositoryTail<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.repositoryTail.catch(() => undefined);
    const next = prev.then(() => this.held.run({ kind: 'repository' }, fn));
    this.repositoryTail = next;
    return next;
  }

  /**
   * Start a workspace-key operation once no repository operation is queued or
   * running, and count it as running until it settles. A nested one (an inner
   * call inside an operation that is already running) does not wait: the
   * repository operation it would wait for is waiting for its caller.
   */
  private async passRepositoryGate<T>(nested: boolean, fn: () => Promise<T>): Promise<T> {
    if (!nested) {
      while (this.repositoryWaiting > 0) await this.repositoryIdle;
    }
    // No await between the gate above and joining the running set: a
    // repository operation that queues after this line waits for this one.
    const token = {};
    this.running.add(token);
    try {
      return await this.held.run({ kind: 'workspace', token }, fn);
    } finally {
      this.leaveRunning(token);
    }
  }
}
