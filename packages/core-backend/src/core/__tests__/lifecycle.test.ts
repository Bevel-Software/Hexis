import { describe, it, expect } from 'vitest';
import { createShutdown, holdCommitWorkerLease, stopCore, withStartupTask, type LeasedWorker } from '../lifecycle.js';
import { BevelSecretsVariableLoader, registerBevelSecretsVariableLoader } from '../../modules/secrets-vault/secrets-variable-loader.js';
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

describe('withStartupTask', () => {
  it('runs the task to completion before the worker starts, and a stop meanwhile waits for both', async () => {
    const events: string[] = [];
    let finishTask: () => void = () => undefined;
    const worker: LeasedWorker = {
      start: () => void events.push('start'),
      stop: async () => void events.push('stop'),
    };
    const leased = withStartupTask(
      worker,
      () =>
        new Promise<void>((resolve) => {
          events.push('task');
          finishTask = resolve;
        }),
    );

    leased.start();
    await settle();
    expect(events).toEqual(['task']);

    const stopping = leased.stop();
    await settle();
    expect(events).toEqual(['task']);
    finishTask();
    await stopping;
    expect(events).toEqual(['task', 'start', 'stop']);
  });

  it('starts the worker even when the task fails, and says so', async () => {
    const events: string[] = [];
    const logged: string[] = [];
    const leased = withStartupTask(
      { start: () => void events.push('start'), stop: async () => undefined },
      async () => {
        throw new Error('reconcile broke');
      },
      (m) => logged.push(m),
    );
    leased.start();
    await settle();
    expect(events).toEqual(['start']);
    expect(logged).toEqual(['startup task failed; the worker starts regardless: Error: reconcile broke']);
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
        backgroundJobs: {
          stopSweeping() {
            order.push('backgroundJobs.stopSweeping');
          },
          async drain() {
            order.push('backgroundJobs.drain');
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
      'backgroundJobs.stopSweeping',
      'backgroundJobs.drain',
      'commitWorker.stop',
      'db.end',
    ]);
  });

  it('waits for the jobs a tick already started before the pool goes, within the budget', async () => {
    const d = deps();
    let release: () => void = () => undefined;
    d.deps.backgroundJobs!.drain = () => {
      d.order.push('backgroundJobs.drain');
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const shutdown = createShutdown(d.deps as never);
    const done = shutdown('SIGTERM');
    await settle();
    d.finishClose();
    await settle();
    // The jobs are still running: nothing after them has run.
    expect(d.order).toEqual(['server.close', 'server.closeAllConnections', 'backgroundJobs.stopSweeping', 'backgroundJobs.drain']);
    release();
    await done;
    expect(d.order.slice(-2)).toEqual(['commitWorker.stop', 'db.end']);
  });

  it('stops the background sweep before anything it could outlive', async () => {
    const d = deps();
    const shutdown = createShutdown(d.deps as never);
    const done = shutdown('SIGTERM');
    await settle();
    d.finishClose();
    await done;

    // Order is the point, not just presence, in BOTH directions. A tick that
    // fired after `db.end` would query a client that is gone; a tick during
    // `commitWorker.stop` — which awaits an in-flight commit and can take
    // most of the shutdown budget — would start fresh clone/commit/push work
    // that the process exit immediately after kills mid-git.
    const stopped = d.order.indexOf('backgroundJobs.stopSweeping');
    expect(stopped).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeLessThan(d.order.indexOf('commitWorker.stop'));
    expect(stopped).toBeLessThan(d.order.indexOf('db.end'));
  });

  it('shuts down cleanly when no background jobs were built yet', async () => {
    const d = deps();
    // A stop that lands mid-boot: the services exist, the jobs do not.
    delete (d.deps as { backgroundJobs?: unknown }).backgroundJobs;
    const shutdown = createShutdown(d.deps as never);
    const done = shutdown('SIGTERM');
    await settle();
    d.finishClose();
    await expect(done).resolves.toBeUndefined();
    expect(d.order).toEqual([
      'server.close',
      'server.closeAllConnections',
      'commitWorker.stop',
      'db.end',
    ]);
  });

  it('does not wait past the budget for jobs that never finish, and still ends the pool', async () => {
    const d = deps();
    d.deps.backgroundJobs!.drain = () => {
      d.order.push('backgroundJobs.drain');
      return new Promise<void>(() => undefined); // a clone that never returns
    };
    const shutdown = createShutdown(d.deps as never, { deadlineMs: 60 });
    const done = shutdown('SIGTERM');
    await settle();
    d.finishClose();
    await done;
    expect(d.order.slice(-3)).toEqual(['backgroundJobs.drain', 'commitWorker.stop', 'db.end']);
  });

  it('does not hang on a step that never finishes, and still runs the rest', async () => {
    const d = deps();
    // A server whose close callback never comes — a connection that will not drain.
    const shutdown = createShutdown(d.deps as never, { deadlineMs: 60 });

    await shutdown('SIGTERM');
    expect(d.order).toEqual([
      'server.close',
      'server.closeAllConnections',
      'backgroundJobs.stopSweeping',
      'backgroundJobs.drain',
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

describe('stopCore', () => {
  function graph() {
    const order: string[] = [];
    return {
      order,
      core: {
        commitWorker: {
          async stop() {
            order.push('commitWorker.stop');
          },
        },
        backgroundJobs: {
          stopSweeping() {
            order.push('backgroundJobs.stopSweeping');
          },
          async drain() {
            order.push('backgroundJobs.drain');
          },
        },
        startupRetry: {
          stop() {
            order.push('startupRetry.stop');
          },
        },
        db: {
          $client: {
            async end() {
              order.push('db.end');
            },
          },
        },
        secretsScope: 'acme/t_acme',
        log: () => undefined,
      },
    };
  }

  it('stops a graph without a server: sweeps and the retry first, the worker, then the pool', async () => {
    const g = graph();
    await stopCore(g.core as never);
    expect(g.order).toEqual([
      'backgroundJobs.stopSweeping',
      'startupRetry.stop',
      'backgroundJobs.drain',
      'commitWorker.stop',
      'db.end',
    ]);
  });

  it('forgets the graph\'s secrets scope, so a descriptor that outlives it resolves nothing', async () => {
    const g = graph();
    registerBevelSecretsVariableLoader(
      { resolve: async () => 'sk-live' } as never,
      g.core.secretsScope,
    );
    const loader = new BevelSecretsVariableLoader('user-1', g.core.secretsScope);
    expect(await loader.get('weather_KEY')).toBe('sk-live');
    await stopCore(g.core as never);
    expect(await loader.get('weather_KEY')).toBeNull();
  });

  it('stops a graph that never left a retry asking and never registered a scope', async () => {
    const g = graph();
    const core = { ...g.core, startupRetry: null, secretsScope: undefined };
    await stopCore(core as never);
    expect(g.order).toEqual(['backgroundJobs.stopSweeping', 'backgroundJobs.drain', 'commitWorker.stop', 'db.end']);
  });

  it('does not wait past the budget for a worker that never stops, and still ends the pool', async () => {
    const g = graph();
    const core = { ...g.core, commitWorker: { stop: () => new Promise<void>(() => undefined) } };
    await stopCore(core as never, { deadlineMs: 50 });
    expect(g.order).toEqual(['backgroundJobs.stopSweeping', 'startupRetry.stop', 'backgroundJobs.drain', 'db.end']);
  });
});
