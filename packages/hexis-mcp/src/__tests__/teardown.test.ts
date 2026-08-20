import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  STARTUP_LETGO_GRACE_MS,
  makeExitAfterShutdown,
  type ShutdownHolder,
} from '../teardown.js';

/**
 * The let-go states, pinned as the unit teardown.ts is. The real wiring —
 * stdin EOF through a genuinely spawned CLI ending genuinely spawned
 * grandchildren — lives in teardown.e2e.test.ts; what only a unit test can
 * reach portably are the two failure-shaped states: a startup that already
 * FAILED must not have its status laundered to 0 by the client's hang-up, and
 * a startup that never finishes must not ignore the hang-up forever (signals
 * cannot be delivered to a live child on Windows, so the e2e cannot pin this).
 */

let exit: MockInstance;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  priorExitCode = process.exitCode;
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  process.exitCode = priorExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeHolder(shutdown: ShutdownHolder['shutdown'] = null): ShutdownHolder {
  return { shutdown, exitRequested: false, exiting: false };
}

describe('makeExitAfterShutdown: startup done', () => {
  it('shuts down once and exits 0 — repeats ("end" then "close", repeated signals) do nothing', async () => {
    const shutdown = vi.fn(async () => {});
    const holder = makeHolder(shutdown);
    const letGo = makeExitAfterShutdown(holder);

    letGo();
    letGo();
    await flush();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('carries a recorded startup failure into the exit status instead of laundering it to 0', async () => {
    // server.connect rejected; main() recorded the failure. The client's
    // eventual hang-up must report that failure, not a clean exit.
    process.exitCode = 1;
    const holder = makeHolder(async () => {});
    makeExitAfterShutdown(holder)();
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stands down when main() already took over the exit', async () => {
    const shutdown = vi.fn(async () => {});
    const holder = makeHolder(shutdown);
    holder.exiting = true; // main() saw exitRequested and runs the orderly path

    makeExitAfterShutdown(holder)();
    await flush();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('makeExitAfterShutdown: startup still creating', () => {
  it('records the request, and force-exits with a failure status when creation never resolves', () => {
    vi.useFakeTimers();
    const holder = makeHolder();
    const letGo = makeExitAfterShutdown(holder);

    letGo();
    expect(holder.exitRequested).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    // A wedged create (a stdio server that never answers initialize) resolves
    // never; the bounded fallback is the only exit there is.
    vi.advanceTimersByTime(STARTUP_LETGO_GRACE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('arms ONE force-exit across repeated let-gos', () => {
    vi.useFakeTimers();
    const holder = makeHolder();
    const letGo = makeExitAfterShutdown(holder);

    letGo();
    vi.advanceTimersByTime(STARTUP_LETGO_GRACE_MS - 1);
    letGo(); // a second signal must not extend (or duplicate) the deadline
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(STARTUP_LETGO_GRACE_MS * 2);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('lets the orderly path win when creation resolves within the grace', async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(async () => {});
    const holder = makeHolder();
    const letGo = makeExitAfterShutdown(holder);

    letGo(); // recorded; force-exit armed
    // …create resolves in time: main() sees exitRequested and tears down,
    // exactly as cli.ts does it.
    holder.shutdown = shutdown;
    expect(holder.exitRequested).toBe(true);
    holder.exiting = true;
    await holder.shutdown();
    // The handler itself stands down for good…
    letGo();
    expect(shutdown).toHaveBeenCalledTimes(1);
    // …and so does the STALE force-exit: an orderly shutdown that outlasts
    // the remaining grace must not be exit-1'd mid-cleanup by a timer armed
    // for a startup that did, in fact, come up.
    vi.advanceTimersByTime(STARTUP_LETGO_GRACE_MS * 2);
    expect(exit).not.toHaveBeenCalled();
  });
});
