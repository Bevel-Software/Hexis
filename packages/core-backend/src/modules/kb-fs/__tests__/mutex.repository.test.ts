import { describe, it, expect } from 'vitest';
import { REPOSITORY_KEY, WorkspaceMutex } from '../mutex.js';

/**
 * The repository-level reservation: every branch workspace is a worktree of
 * one repository, so what rewrites the state they share — a fetch, a garbage
 * collection, a worktree add, remove or prune — runs ALONE, while operations
 * on two different worktrees run side by side.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every queued continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('WorkspaceMutex — the repository reservation', () => {
  it('runs operations on two different worktrees at the same time', async () => {
    const mtx = new WorkspaceMutex();
    const release = deferred();
    const running: string[] = [];
    const a = mtx.run('alice%2Fa', async () => {
      running.push('a');
      await release.promise;
    });
    const b = mtx.run('bob%2Fb', async () => {
      running.push('b');
      await release.promise;
    });
    await settle();
    expect(running).toEqual(['a', 'b']);
    release.resolve();
    await Promise.all([a, b]);
  });

  it('waits for the worktree operations in flight, and holds back the ones that arrive after it', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const releaseA = deferred();
    const a = mtx.run('alice%2Fa', async () => {
      order.push('a-start');
      await releaseA.promise;
      order.push('a-end');
    });
    await settle();
    const fetch = mtx.runRepository(async () => {
      order.push('fetch');
    });
    const b = mtx.run('bob%2Fb', async () => {
      order.push('b');
    });
    await settle();
    // B arrived after the fetch: it waits for it, though its key is free.
    expect(order).toEqual(['a-start']);
    releaseA.resolve();
    await Promise.all([a, fetch, b]);
    expect(order).toEqual(['a-start', 'a-end', 'fetch', 'b']);
  });

  it('serializes repository operations with each other', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const releaseFetch = deferred();
    const fetch = mtx.run(REPOSITORY_KEY, async () => {
      order.push('fetch-start');
      await releaseFetch.promise;
      order.push('fetch-end');
    });
    const add = mtx.runRepository(async () => {
      order.push('worktree-add');
    });
    await settle();
    expect(order).toEqual(['fetch-start']);
    releaseFetch.resolve();
    await Promise.all([fetch, add]);
    expect(order).toEqual(['fetch-start', 'fetch-end', 'worktree-add']);
  });

  it('runs a repository operation called from inside a worktree operation without waiting for its caller, and still one at a time with the others', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const releaseOuter = deferred();
    // A pull: its own worktree held, then a fetch inside it.
    const pull = mtx.run('alice%2Fa', async () => {
      await mtx.runRepository(async () => {
        order.push('pull-fetch-start');
        await releaseOuter.promise;
        order.push('pull-fetch-end');
      });
    });
    await settle();
    // A worktree add queued meanwhile waits for the pull (which it must not
    // overtake) — and the pull's fetch, which is not waiting for it, finishes.
    const add = mtx.runRepository(async () => {
      order.push('worktree-add');
    });
    await settle();
    releaseOuter.resolve();
    await Promise.all([pull, add]);
    expect(order).toEqual(['pull-fetch-start', 'pull-fetch-end', 'worktree-add']);
  });

  it('holds back a worktree operation that arrives while a nested repository operation runs', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const releaseFetch = deferred();
    const fetching = deferred();
    // A pull fetching inside its own worktree's reservation.
    const pull = mtx.run('alice%2Fa', async () => {
      await mtx.runRepository(async () => {
        order.push('pull-fetch-start');
        fetching.resolve();
        await releaseFetch.promise;
        order.push('pull-fetch-end');
      });
      order.push('pull-rebase');
    });
    await fetching.promise;
    // Another worktree's operation, arriving mid-fetch: it must not run
    // beside the fetch, though its own key is free.
    const other = mtx.run('bob%2Fb', async () => {
      order.push('bob');
    });
    await settle();
    expect(order).toEqual(['pull-fetch-start']);
    releaseFetch.resolve();
    await Promise.all([pull, other]);
    expect(order.slice(0, 2)).toEqual(['pull-fetch-start', 'pull-fetch-end']);
    expect(order.slice(2).sort()).toEqual(['bob', 'pull-rebase']);
  });

  it('lets a repository operation reach into a worktree without waiting for itself', async () => {
    const mtx = new WorkspaceMutex();
    const queued = deferred();
    // A worktree operation queued on the key while the repository operation runs.
    const result = await mtx.runRepository(async () => {
      void mtx.run('alice%2Fa', async () => queued.resolve());
      return mtx.run('alice%2Fa', async () => 'inside');
    });
    expect(result).toBe('inside');
    await queued.promise;
  });

  it('lets a worktree operation wait, parked, for a repository operation that is waiting for it', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const running = deferred();
    // Handed over in a box: a promise resolved with a promise adopts it.
    const addMade = deferred<{ add: Promise<void> }>();
    // A git operation on a branch whose first checkout another caller is
    // making: the checkout's worktree add (started outside, as a page load
    // starts it) waits for every running operation, and this operation waits
    // for the checkout.
    const op = mtx.run('bob%2Fb', async () => {
      running.resolve();
      await mtx.whileParked((await addMade.promise).add);
      order.push('op-continues');
    });
    await running.promise;
    const add = mtx.runRepository(async () => {
      order.push('worktree-add');
    });
    addMade.resolve({ add });
    // An operation that arrives after the add stays behind it.
    const later = mtx.run('carol%2Fc', async () => {
      order.push('later');
    });
    await Promise.all([op, add, later]);
    expect(order[0]).toBe('worktree-add');
    expect(order.slice(1).sort()).toEqual(['later', 'op-continues']);
  });

  it('still runs a later operation when a repository operation fails', async () => {
    const mtx = new WorkspaceMutex();
    await expect(mtx.runRepository(async () => Promise.reject(new Error('fetch failed')))).rejects.toThrow('fetch failed');
    await expect(mtx.run('alice%2Fa', async () => 'ok')).resolves.toBe('ok');
    await expect(mtx.runRepository(async () => 'ok')).resolves.toBe('ok');
  });
});
