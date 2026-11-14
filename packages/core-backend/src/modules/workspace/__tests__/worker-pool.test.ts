import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../worker-pool.js';

/** A stand-in worker: what the pool calls on one, and whether it was terminated. */
class FakeWorker extends EventEmitter {
  terminated = false;
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    if (!this.terminated) {
      this.terminated = true;
      queueMicrotask(() => this.emit('exit', 1));
    }
    return Promise.resolve(1);
  }
}

/** A pool of fake workers, and every worker it started that is still running. */
function fakePool(poolMax: number, maxWaiting = 10) {
  const spawned: FakeWorker[] = [];
  const pool = new WorkerPool(
    () => {
      const w = new FakeWorker();
      spawned.push(w);
      return w as unknown as Worker;
    },
    { poolMax, maxWaiting },
    () => new Error('busy'),
  );
  const running = () => spawned.filter((w) => !w.terminated).length;
  return { pool, spawned, running };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('WorkerPool.acquireFresh', () => {
  it('swaps the worker freed by another job in its own place, with jobs queued behind it', async () => {
    const { pool, running } = fakePool(1);
    const held = await pool.acquire();
    const fresh = pool.acquireFresh();
    const queued = pool.acquire();
    await tick();

    // The holder's job ends with a worker that must not be reused; its place
    // goes to the next waiting job, the fresh request.
    pool.discard(held);
    const freshWorker = await fresh;
    expect(freshWorker).not.toBe(held);
    expect(running()).toBe(1);

    // The queued job waits for that worker, not for a second one.
    let settled = false;
    void queued.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(running()).toBe(1);

    pool.release(freshWorker);
    expect(await queued).toBe(freshWorker);
    expect(running()).toBe(1);
    await pool.close();
  });

  it('swaps a released worker for a new one without passing a second one to the queue', async () => {
    const { pool, running } = fakePool(1);
    const held = await pool.acquire();
    const fresh = pool.acquireFresh();
    const queued = pool.acquire();
    await tick();

    pool.release(held);
    const freshWorker = await fresh;
    expect(freshWorker).not.toBe(held);
    expect((held as unknown as FakeWorker).terminated).toBe(true);
    await tick();
    expect(running()).toBe(1);

    pool.release(freshWorker);
    expect(await queued).toBe(freshWorker);
    expect(running()).toBe(1);
    await pool.close();
  });

  it('swaps an idle worker that has run a job when the pool is full', async () => {
    const { pool, running } = fakePool(2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    pool.release(a);
    const fresh = await pool.acquireFresh();
    expect(fresh).not.toBe(a);
    expect(fresh).not.toBe(b);
    expect((a as unknown as FakeWorker).terminated).toBe(true);
    await tick();
    expect(running()).toBe(2);
    await pool.close();
  });

  it('starts a new worker when the pool has room', async () => {
    const { pool, spawned } = fakePool(2);
    const a = await pool.acquire();
    pool.release(a);
    const fresh = await pool.acquireFresh();
    expect(fresh).not.toBe(a);
    expect(spawned).toHaveLength(2);
    await pool.close();
  });

  it('answers busy after close, for a fresh request waiting in the queue too', async () => {
    const { pool } = fakePool(1);
    await pool.acquire();
    const fresh = pool.acquireFresh();
    await pool.close();
    await expect(fresh).rejects.toThrow('busy');
    await expect(pool.acquireFresh()).rejects.toThrow('busy');
  });
});
