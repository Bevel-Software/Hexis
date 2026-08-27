import { describe, it, expect } from 'vitest';
import { WorkspaceMutex } from '../mutex.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('WorkspaceMutex', () => {
  describe('runAll', () => {
    /**
     * The property nesting cannot provide: `run(a, () => run(b, fn))` releases
     * nothing, but between taking `a` and taking `b` the second key is free,
     * so a single-key task can slip in, run to completion, and be gone before
     * the pair operation's body starts. `runAll` reserves the set in one
     * synchronous step, so it cannot be interleaved that way.
     */
    it('reserves every key before any of them can be taken by another task', async () => {
      const mtx = new WorkspaceMutex();
      const order: string[] = [];
      const release = deferred();

      // Something already holds 'a', so the pair operation cannot start yet —
      // this is the window a nested acquisition would leave 'b' open in.
      const holder = mtx.run('a', async () => {
        order.push('holder-start');
        await release.promise;
        order.push('holder-end');
      });
      await new Promise((r) => setImmediate(r));

      const pair = mtx.runAll(['a', 'b'], async () => {
        order.push('pair');
      });
      // Submitted while the pair is still waiting on 'a'. If 'b' were taken
      // only after 'a' were granted, this would run first.
      const single = mtx.run('b', async () => {
        order.push('single-b');
      });

      release.resolve();
      await Promise.all([holder, pair, single]);
      expect(order).toEqual(['holder-start', 'holder-end', 'pair', 'single-b']);
    });

    it('lets a task on an unrelated key run in parallel', async () => {
      const mtx = new WorkspaceMutex();
      const order: string[] = [];
      const release = deferred();

      const holder = mtx.run('a', async () => {
        await release.promise;
        order.push('holder');
      });
      await new Promise((r) => setImmediate(r));

      const pair = mtx.runAll(['a', 'b'], async () => void order.push('pair'));
      const other = mtx.run('c', async () => void order.push('other'));

      await other;
      expect(order).toEqual(['other']);
      release.resolve();
      await Promise.all([holder, pair]);
      expect(order).toEqual(['other', 'holder', 'pair']);
    });

    /**
     * A failing task on ONE key must not release the others. `Promise.all`
     * settles on the first rejection rather than waiting for the rest, so
     * combining the predecessors without catching each one first would start
     * this task while another key was still held.
     */
    it('waits for every predecessor even when one of them fails first', async () => {
      const mtx = new WorkspaceMutex();
      const order: string[] = [];
      const failA = deferred();
      const finishB = deferred();

      const failing = mtx.run('a', async () => {
        await failA.promise;
        throw new Error('a-failed');
      });
      failing.catch(() => undefined); // handled below; keep the rejection quiet
      const running = mtx.run('b', async () => {
        await finishB.promise;
        order.push('b-end');
      });

      // Queued while BOTH predecessors are still pending.
      const pair = mtx.runAll(['a', 'b'], async () => void order.push('pair'));

      failA.resolve();
      await expect(failing).rejects.toThrow('a-failed');
      await new Promise((r) => setImmediate(r));
      // 'a' has failed, but 'b' still holds its key — the pair must wait.
      expect(order).toEqual([]);

      finishB.resolve();
      await Promise.all([running, pair]);
      expect(order).toEqual(['b-end', 'pair']);
    });

    it('releases every key when the body throws', async () => {
      const mtx = new WorkspaceMutex();
      await expect(mtx.runAll(['a', 'b'], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      // Both keys must be usable again, or one failure wedges them forever.
      await expect(mtx.run('a', async () => 'a-ok')).resolves.toBe('a-ok');
      await expect(mtx.run('b', async () => 'b-ok')).resolves.toBe('b-ok');
    });

    it('collapses a duplicate key instead of waiting on itself', async () => {
      const mtx = new WorkspaceMutex();
      await expect(mtx.runAll(['a', 'a'], async () => 'done')).resolves.toBe('done');
    });
  });

  it('serializes tasks for the same key in submission order', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = mtx.run('ws-1', async () => {
      order.push('start-1');
      await d1.promise;
      order.push('end-1');
    });
    const p2 = mtx.run('ws-1', async () => {
      order.push('start-2');
      await d2.promise;
      order.push('end-2');
    });

    // Yield so the first task actually starts before we release it.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['start-1']);
    d1.resolve();
    await p1;
    // After 1 finishes, 2 should start.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['start-1', 'end-1', 'start-2']);
    d2.resolve();
    await p2;
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('runs tasks for different keys concurrently', async () => {
    const mtx = new WorkspaceMutex();
    const order: string[] = [];
    const dA = deferred();
    const dB = deferred();

    const pA = mtx.run('ws-a', async () => {
      order.push('start-A');
      await dA.promise;
      order.push('end-A');
    });
    const pB = mtx.run('ws-b', async () => {
      order.push('start-B');
      await dB.promise;
      order.push('end-B');
    });

    await new Promise((r) => setImmediate(r));
    expect(order.sort()).toEqual(['start-A', 'start-B']);
    // Finish B first despite starting A first — possible only because they ran in parallel.
    dB.resolve();
    await pB;
    dA.resolve();
    await pA;
    expect(order).toEqual(['start-A', 'start-B', 'end-B', 'end-A']);
  });

  it('continues serving the queue after a task throws', async () => {
    const mtx = new WorkspaceMutex();
    const failing = mtx.run('ws-1', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    const ok = await mtx.run('ws-1', async () => 42);
    expect(ok).toBe(42);
  });
});
