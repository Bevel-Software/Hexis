import { useState } from 'react';

/**
 * "Only the latest request's answer counts", in one place. A screen that
 * asks the server again whenever something changes (a list re-read after a
 * send, a check re-asked after a page change) can have several requests out
 * at once, and they can answer in any order.
 *
 * `run(start, apply)` starts a request and:
 * - applies its answer only if no newer request was started meanwhile, so a
 *   slow reply to an older question never overwrites a newer one;
 * - resolves with the answer of the LATEST request, waiting through any that
 *   start while it waits, so a caller that asked before a change is handed
 *   the answer for what is on screen now, never the one it started.
 *
 * `start` must not reject: fold a failure into the value it resolves with.
 */
export class LatestRequest<T> {
  private seq = 0;
  private latest: Promise<T> | null = null;

  async run(start: () => Promise<T>, apply: (value: T) => void): Promise<T> {
    const n = ++this.seq;
    const mine = start();
    this.latest = mine;
    let value = await mine;
    if (n === this.seq) {
      apply(value);
      return value;
    }
    // Superseded: the newest request applies its own answer; hand back
    // whichever is newest once each one we waited on has answered.
    let waited: Promise<T> = mine;
    while (this.latest && this.latest !== waited) {
      waited = this.latest;
      value = await waited;
    }
    return value;
  }
}

/** One {@link LatestRequest} for the life of a component. */
export function useLatestRequest<T>(): LatestRequest<T> {
  return useState(() => new LatestRequest<T>())[0];
}
