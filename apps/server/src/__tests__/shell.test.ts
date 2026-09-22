import { describe, it, expect, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { runShell, type ShellCore, type ShellProcess } from '../shell.js';

/** A process that records its handlers and its exit, and can be signalled. */
function fakeProcess() {
  const handlers = new Map<string, (arg: unknown) => void>();
  const exit = vi.fn<(code: number) => void>();
  const process: ShellProcess = {
    on: (event, handler) => void handlers.set(event, handler),
    exit,
  };
  return { process, exit, signal: (event: string, arg?: unknown) => handlers.get(event)?.(arg) };
}

/** Services as the shutdown sees them, every step a spy. */
function fakeCore(): ShellCore & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    commitWorker: { stop: async () => void order.push('commitWorker.stop') },
    db: { $client: { end: async () => void order.push('db.end') } } as unknown as ShellCore['db'],
    pluginJoinRequestJobs: {
      stopSweeping: () => void order.push('jobs.stopSweeping'),
      drain: async () => void order.push('jobs.drain'),
    },
  };
}

function fakeServer(order: string[]): HttpServer {
  return {
    close: (cb?: (err?: Error) => void) => {
      order.push('server.close');
      cb?.();
    },
    closeAllConnections: () => void order.push('server.closeAllConnections'),
  } as unknown as HttpServer;
}

const exited = (exit: ReturnType<typeof vi.fn>) => vi.waitFor(() => expect(exit).toHaveBeenCalled());

/**
 * The shell owns how the process stops: on a signal, and on a boot that
 * failed partway. What it can release is what the services builder returned.
 */
describe('runShell', () => {
  it('a boot that fails after the services are built releases them, then exits 1', async () => {
    const core = fakeCore();
    const p = fakeProcess();
    await runShell({
      services: async () => core,
      listen: async () => {
        throw new Error('port in use');
      },
      process: p.process,
    });
    await exited(p.exit);
    expect(core.order).toEqual(['jobs.stopSweeping', 'jobs.drain', 'commitWorker.stop', 'db.end']);
    expect(p.exit).toHaveBeenCalledWith(1);
  });

  it('a boot that fails inside the services builder exits 1 with nothing to release', async () => {
    const p = fakeProcess();
    const listen = vi.fn();
    await runShell({
      services: async () => {
        throw new Error('migrations: could not take the lock');
      },
      listen,
      process: p.process,
    });
    await exited(p.exit);
    expect(listen).not.toHaveBeenCalled();
    expect(p.exit).toHaveBeenCalledWith(1);
  });

  it('a signal after boot runs the whole sequence — server first, pool last — and exits 0', async () => {
    const core = fakeCore();
    const p = fakeProcess();
    await runShell({
      services: async () => core,
      listen: async () => fakeServer(core.order),
      process: p.process,
    });
    p.signal('SIGTERM');
    await exited(p.exit);
    expect(core.order).toEqual([
      'server.close',
      'server.closeAllConnections',
      'jobs.stopSweeping',
      'jobs.drain',
      'commitWorker.stop',
      'db.end',
    ]);
    expect(p.exit).toHaveBeenCalledWith(0);
  });

  it('a crash — an unhandled rejection or an uncaught exception — runs the sequence and exits 1', async () => {
    for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
      const core = fakeCore();
      const p = fakeProcess();
      await runShell({ services: async () => core, listen: async () => fakeServer(core.order), process: p.process });
      p.signal(event, new Error('a bug'));
      await exited(p.exit);
      expect(core.order.at(-1)).toBe('db.end');
      expect(p.exit).toHaveBeenCalledWith(1);
    }
  });

  it('a signal that lands while the services are still being built lets go of nothing and exits 0', async () => {
    const p = fakeProcess();
    const listen = vi.fn();
    let finishServices!: (core: ShellCore) => void;
    const booting = runShell({
      services: () =>
        new Promise<ShellCore>((resolve) => {
          finishServices = resolve;
        }),
      listen,
      process: p.process,
    });
    p.signal('SIGTERM');
    await exited(p.exit);
    expect(p.exit).toHaveBeenCalledWith(0);
    expect(listen).not.toHaveBeenCalled();
    // The services arriving afterwards start nothing: the process has
    // already been told to exit, and nothing begins listening on its way out.
    finishServices(fakeCore());
    await booting;
    expect(listen).not.toHaveBeenCalled();
    expect(p.exit).toHaveBeenCalledTimes(1);
  });

  it('a second way of ending joins the sequence already under way', async () => {
    const core = fakeCore();
    const p = fakeProcess();
    await runShell({ services: async () => core, listen: async () => fakeServer(core.order), process: p.process });
    p.signal('SIGTERM');
    p.signal('SIGINT');
    await exited(p.exit);
    expect(core.order.filter((s) => s === 'db.end')).toHaveLength(1);
    expect(p.exit).toHaveBeenCalledTimes(1);
  });
});
