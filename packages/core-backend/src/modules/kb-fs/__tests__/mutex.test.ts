import { describe, it, expect } from 'vitest';
import { WorkspaceMutex } from '../mutex.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('WorkspaceMutex', () => {
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
