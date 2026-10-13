import { describe, expect, it } from 'vitest';
import { LatestRequest } from '../latest-request';

/** A request that answers when told to. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('LatestRequest', () => {
  it('applies and returns the answer of a request nothing overtook', async () => {
    const applied: string[] = [];
    const latest = new LatestRequest<string>();
    expect(await latest.run(async () => 'a', (v) => applied.push(v))).toBe('a');
    expect(applied).toEqual(['a']);
  });

  it('never applies an overtaken answer, and hands its caller the newest one, whatever order they answer in', async () => {
    const applied: string[] = [];
    const latest = new LatestRequest<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    const a = latest.run(() => first.promise, (v) => applied.push(v));
    const b = latest.run(() => second.promise, (v) => applied.push(v));
    // The older answers first: it is not applied, and its caller waits on.
    first.resolve('old');
    second.resolve('new');
    expect(await a).toBe('new');
    expect(await b).toBe('new');
    expect(applied).toEqual(['new']);
  });

  it('waits through a request started while it was already waiting on a newer one', async () => {
    const applied: string[] = [];
    const latest = new LatestRequest<string>();
    const [one, two, three] = [deferred<string>(), deferred<string>(), deferred<string>()];
    const a = latest.run(() => one.promise, (v) => applied.push(v));
    latest.run(() => two.promise, (v) => applied.push(v));
    one.resolve('1');
    await Promise.resolve();
    latest.run(() => three.promise, (v) => applied.push(v));
    two.resolve('2');
    three.resolve('3');
    expect(await a).toBe('3');
    expect(applied).toEqual(['3']);
  });
});
