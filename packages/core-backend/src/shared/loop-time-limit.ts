/**
 * A limit on work this process awaits from itself that a held event loop
 * cannot use up. It is spent in ticks, and a stretch the loop is held for
 * spends one tick, however long the stretch. While the loop keeps turning it
 * runs on the clock, like any limit.
 *
 * A plain `setTimeout` limit measures the clock. When the loop is held busy,
 * the clock runs and the work cannot: its callbacks wait behind whatever holds
 * the loop. Once the loop is free the timers run first, the limit has "passed",
 * and work that needed a few milliseconds is given up on. That is how a busy
 * server failed its own requests to itself.
 *
 * This limit is spent one tick at a time, and a tick is spent only when its
 * timer fires. A loop held for twenty seconds fires one late timer, so it
 * spends one tick, and the work then gets the loop like everything else. It
 * is not a promise about every kind of load: while the loop keeps turning, the
 * ticks fire on time and the limit runs on the clock. What it guarantees is
 * that the work gets a turn of the loop for every tick the limit spends. Work
 * that never settles (a read waiting on something that will not answer) spends
 * every tick and is given up on after `limitMs` of time the loop could have
 * used to finish it.
 *
 * The work is not cancelled when the limit passes: it has no handle to cancel
 * by. Its result is dropped.
 */
export class LoopTimeLimitError extends Error {
  constructor(readonly limitMs: number) {
    super(`not finished within its ${limitMs}ms limit`);
    this.name = 'LoopTimeLimitError';
  }
}

/** The longest tick a limit is spent in. Short enough to end near the limit, long enough to cost nothing. */
const TICK_MS = 250;

/**
 * The fewest ticks a limit is spent in, however short it is. A held loop
 * spends one tick, so a limit of one tick would be a clock limit again.
 */
const MIN_TICKS = 4;

/**
 * `work`'s outcome, or a {@link LoopTimeLimitError} once the limit of
 * `limitMs` is spent without one (see the top of this file for how it is spent). `tickMs` is for tests; by default a
 * limit is spent in ticks of {@link TICK_MS}, and in at least {@link MIN_TICKS}.
 */
export function withinLoopTime<T>(
  work: Promise<T>,
  limitMs: number,
  tickMs: number = Math.max(1, Math.min(TICK_MS, Math.floor(limitMs / MIN_TICKS))),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let ticksLeft = Math.max(1, Math.ceil(limitMs / tickMs));
    let timer: NodeJS.Timeout;
    const arm = () => {
      timer = setTimeout(() => {
        ticksLeft -= 1;
        if (ticksLeft <= 0) reject(new LoopTimeLimitError(limitMs));
        else arm();
      }, tickMs);
      // A limit alone must not keep a stopping process alive.
      timer.unref();
    };
    arm();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
