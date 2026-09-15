import { describe, it, expect } from 'vitest';
import {
  createShutdown,
  holdCommitWorkerLease,
  leasedWorkers,
  periodicTask,
  type LeasedWorker,
} from '../lifecycle.js';
import type { AdvisoryLease } from '../../modules/database/advisory-lock.js';

/** A lease the suite scripts: what each `tryAcquire` answers, and a way to lose it. */
function fakeLease(answers: boolean[]) {
  let held = false;
  let lost: (() => void) | null = null;
  const record = { asked: 0, released: 0 };
  const lease = {
    get held() {
      return held;
    },
    onLost(cb: () => void) {
      lost = cb;
    },
    async tryAcquire() {
      if (held) return true;
      record.asked += 1;
      held = answers.shift() ?? false;
      return held;
    },
    async release() {
      record.released += 1;
      held = false;
    },
  } as unknown as AdvisoryLease;
  return {
    lease,
    record,
    lose() {
      held = false;
      lost?.();
    },
  };
}

/** A worker that records its transitions, and can hold its stop open. */
function fakeWorker() {
  const events: string[] = [];
  let releaseStop: (() => void) | null = null;
  const worker: LeasedWorker = {
    start() {
      events.push('start');
    },
    stop() {
      events.push('stop');
      return new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    },
  };
  return { worker, events, finishStop: () => releaseStop?.() };
}

/** A sleep the suite steps by hand, so nothing here waits on a clock. */
function manualSleep() {
  const pending: Array<() => void> = [];
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
    // Resolves EVERY sleep started so far: a loop woken early leaves its
    // sleep's resolver behind, and a tick that only served the oldest one
    // would wake that stale sleep and leave the live one waiting.
    tick: async () => {
      for (const wake of pending.splice(0)) wake();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('holdCommitWorkerLease', () => {
  it('starts the worker only once the lease is held, and not before', async () => {
    const { lease, record } = fakeLease([false, false, true]);
    const { worker, events, finishStop } = fakeWorker();
    const clock = manualSleep();

    const handle = holdCommitWorkerLease(lease, worker, { sleep: clock.sleep, log: () => undefined });
    await settle();
    expect(events).toEqual([]);
    expect(handle.held).toBe(false);

    await clock.tick();
    await settle();
    expect(events).toEqual([]);

    await clock.tick();
    await settle();
    expect(events).toEqual(['start']);
    expect(handle.held).toBe(true);
    expect(record.asked).toBe(3);

    // The handle's stop waits for the worker's, which this fake holds open.
    const stopping = handle.stop();
    await settle();
    finishStop();
    await stopping;
  });

  it('stops the worker when the lease is lost, and starts it again once re-held', async () => {
    const { lease, lose } = fakeLease([true, true]);
    const { worker, events, finishStop } = fakeWorker();
    const clock = manualSleep();

    const handle = holdCommitWorkerLease(lease, worker, { sleep: clock.sleep, log: () => undefined });
    await settle();
    expect(events).toEqual(['start']);

    lose();
    await settle();
    expect(events).toEqual(['start', 'stop']);
    expect(handle.held).toBe(false);

    // Re-acquired while the old stop is still in flight: no second start yet.
    await clock.tick();
    await settle();
    expect(events).toEqual(['start', 'stop']);

    // Once the stop finishes, the next pass re-takes the lease and restarts.
    finishStop();
    await settle();
    await clock.tick();
    await settle();
    expect(events).toEqual(['start', 'stop', 'start']);

    // Same as above: release the worker's stop only once the handle has asked for it.
    const stopping = handle.stop();
    await settle();
    finishStop();
    await stopping;
  });

  it('stop() ends the worker, then releases the lease, and is idempotent', async () => {
    const { lease, record } = fakeLease([true]);
    const { worker, events, finishStop } = fakeWorker();
    const clock = manualSleep();

    const handle = holdCommitWorkerLease(lease, worker, { sleep: clock.sleep, log: () => undefined });
    await settle();

    const stopping = handle.stop();
    await settle();
    // The lease is still held while the in-flight commit finishes: releasing
    // first would let the replacement start draining the same clone.
    expect(events).toEqual(['start', 'stop']);
    expect(record.released).toBe(0);

    finishStop();
    await stopping;
    expect(record.released).toBe(1);

    await handle.stop();
    expect(record.released).toBe(1);
  });
});

describe('periodicTask', () => {
  it('runs after the initial delay, then once per interval, and a failure does not end the schedule', async () => {
    const clock = manualSleep();
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return clock.sleep();
    };
    let runs = 0;
    const logged: string[] = [];
    const task = periodicTask(
      async () => {
        runs += 1;
        if (runs === 1) throw new Error('first sweep broke');
      },
      { label: 'sweep', intervalMs: 1000, initialDelayMs: 10, sleep, log: (m) => logged.push(m) },
    );

    task.start();
    await settle();
    expect(runs).toBe(0);
    expect(waits).toEqual([10]);

    await clock.tick();
    await settle();
    expect(runs).toBe(1);
    expect(logged).toEqual(['sweep failed: Error: first sweep broke']);
    expect(waits).toEqual([10, 1000]);

    await clock.tick();
    await settle();
    expect(runs).toBe(2);

    await task.stop();
    await clock.tick();
    await settle();
    expect(runs).toBe(2);
  });

  it('stop() during the wait returns at once, and during a run waits for it', async () => {
    const clock = manualSleep();
    let finishRun: () => void = () => undefined;
    const task = periodicTask(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
      { label: 'sweep', intervalMs: 1000, initialDelayMs: 10, sleep: clock.sleep, log: () => undefined },
    );

    task.start();
    await settle();
    // Waiting on the initial delay: stop must not need the clock to advance.
    await task.stop();

    task.start();
    await settle();
    await clock.tick();
    await settle();
    // Mid-run: stop resolves only once the run does.
    let stopped = false;
    const stopping = task.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    finishRun();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('leasedWorkers', () => {
  it('starts every member, stops every member even when one fails, and reports the failure', async () => {
    const events: string[] = [];
    const member = (name: string, failStop = false): LeasedWorker => ({
      start() {
        events.push(`${name}:start`);
      },
      async stop() {
        events.push(`${name}:stop`);
        if (failStop) throw new Error(`${name} would not stop`);
      },
    });
    const all = leasedWorkers(member('a', true), member('b'));

    all.start();
    expect(events).toEqual(['a:start', 'b:start']);
    await expect(all.stop()).rejects.toThrow('a would not stop');
    expect(events).toEqual(['a:start', 'b:start', 'a:stop', 'b:stop']);
  });
});

describe('createShutdown', () => {
  function deps() {
    const order: string[] = [];
    let closeCallback: (() => void) | null = null;
    return {
      order,
      finishClose: () => closeCallback?.(),
      deps: {
        server: {
          close(cb?: () => void) {
            order.push('server.close');
            closeCallback = cb ?? null;
            return this as never;
          },
          closeAllConnections() {
            order.push('server.closeAllConnections');
          },
        },
        commitWorker: {
          async stop() {
            order.push('commitWorker.stop');
          },
        },
        db: {
          $client: {
            async end() {
              order.push('db.end');
            },
          },
        },
        log: () => undefined,
      },
    };
  }

  it('lets go in order: stop accepting, drop connections, finish the worker, end the pool', async () => {
    const d = deps();
    const shutdown = createShutdown(d.deps as never);

    const done = shutdown('SIGTERM');
    await settle();
    // The server's close waits for its callback; nothing further has run.
    expect(d.order).toEqual(['server.close', 'server.closeAllConnections']);

    d.finishClose();
    await done;
    expect(d.order).toEqual([
      'server.close',
      'server.closeAllConnections',
      'commitWorker.stop',
      'db.end',
    ]);
  });

  it('does not hang on a step that never finishes, and still runs the rest', async () => {
    const d = deps();
    // A server whose close callback never comes — a connection that will not drain.
    const shutdown = createShutdown(d.deps as never, { deadlineMs: 60 });

    await shutdown('SIGTERM');
    expect(d.order).toEqual([
      'server.close',
      'server.closeAllConnections',
      'commitWorker.stop',
      'db.end',
    ]);
  });

  it('runs once: a second signal joins the sequence already under way', async () => {
    const d = deps();
    const shutdown = createShutdown(d.deps as never);

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    d.finishClose();
    await Promise.all([first, second]);
    expect(d.order.filter((step) => step === 'db.end')).toHaveLength(1);
  });
});
