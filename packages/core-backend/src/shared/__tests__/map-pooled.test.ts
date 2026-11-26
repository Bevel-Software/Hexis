import { describe, it, expect } from 'vitest';
import { mapPooled } from '../map-pooled.js';

describe('mapPooled', () => {
  it('answers in input order, even when later calls finish first', async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await mapPooled(delays, 2, (ms) => new Promise<number>((resolve) => setTimeout(() => resolve(ms * 10), ms)));
    expect(out).toEqual([300, 50, 200, 10, 100]);
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let most = 0;
    await mapPooled(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
    });
    expect(most).toBe(3);
  });

  it('rejects with the first failure and starts no call after it', async () => {
    const started: number[] = [];
    const run = mapPooled([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 1 : 20));
      if (i === 0) throw new Error('read failed');
      return i;
    });
    await expect(run).rejects.toThrow('read failed');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(started).toEqual([0, 1]);
  });

  it('answers every item even at a limit below one', async () => {
    expect(await mapPooled([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
  });

  it('answers nothing for nothing', async () => {
    expect(await mapPooled([], 4, async () => 1)).toEqual([]);
  });
});
