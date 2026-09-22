/**
 * Decides whether a request's surface-build line is worth a log entry.
 *
 * The stateless endpoint rebuilds the tool surface on EVERY request, and the
 * line that reports how long that took is the measurement the design's
 * per-request overhead is judged by — it has to keep appearing. It must not
 * appear per request: at the measured ~100 ms a request, an active client
 * produces thousands of identical lines a minute, and the log stops carrying
 * the one signal it exists for (a surface that changed, or got slow).
 *
 * So a line is logged for a user when its SHAPE changed since the last
 * logged line (tool or manual count — a manual that appeared, failed, or
 * was fixed), or when a quiet interval has passed since that line, whichever
 * comes first. In between, identical rebuilds are counted, and the next
 * logged line carries the count so nothing is hidden, only compressed.
 *
 * Bounded: an entry per user, dropped once they have been quiet for the
 * interval, so a long-running process never accumulates departed users. The
 * pruning is one sweep per interval, not one per request — a request must
 * not pay for every other active user — which puts the bound at TWO
 * intervals, not one: a user who goes quiet just after a sweep is not yet
 * quiet enough at the next one and goes at the one after. Departed users
 * therefore cost at most the number who were active in the last two
 * intervals, which is the price of the O(1) request.
 */

export const DEFAULT_SURFACE_LOG_INTERVAL_MS = 60_000;

export interface SurfaceShape {
  tools: number;
  manuals: number;
}

export interface SurfaceLogDecision {
  log: boolean;
  /** Rebuilds with the same shape suppressed since the last logged line for this user. */
  suppressed: number;
}

interface LastLogged {
  /** When this user's line was last LOGGED — the interval counts from here. */
  at: number;
  /**
   * When this user last rebuilt at all, logged or suppressed — what pruning
   * counts from. A user rebuilding every second inside the interval is
   * active, and forgetting them on a sweep would discard the suppressed count
   * their next logged line owes.
   */
  seenAt: number;
  shape: string;
  suppressed: number;
}

export class SurfaceLogThrottle {
  private readonly last = new Map<string, LastLogged>();
  /** When the last sweep ran; a sweep is owed once per interval, not per request. */
  private lastPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number = DEFAULT_SURFACE_LOG_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a rebuild for `userId` and say whether to log it. */
  decide(userId: string, shape: SurfaceShape): SurfaceLogDecision {
    const now = this.now();
    // One sweep per interval, amortized over every request in it: a request
    // costs O(1), not a walk of every active user, and an entry that goes
    // quiet is gone by the second sweep after (see the class doc). The sweep
    // skips THIS user: its entry is about to be read, and at exactly the
    // interval it still carries the suppressed count the next line owes.
    //
    // `now` is the wall clock, which can step backwards (an NTP correction, a
    // VM restored from suspend). Waiting for it to climb back past the last
    // sweep would stall pruning for as long as the step was; a clock that
    // went backwards instead resets the cadence, and pruning resumes in the
    // clock's new domain on the next request.
    const clockSteppedBack = now < this.lastPruneAt;
    if (clockSteppedBack || now - this.lastPruneAt >= this.intervalMs) {
      this.prune(now, userId);
      this.lastPruneAt = now;
    }
    const key = `${shape.tools}/${shape.manuals}`;
    const prev = this.last.get(userId);
    if (prev && prev.shape === key && now - prev.at < this.intervalMs) {
      prev.suppressed += 1;
      prev.seenAt = now;
      return { log: false, suppressed: prev.suppressed };
    }
    const suppressed = prev?.suppressed ?? 0;
    this.last.set(userId, { at: now, seenAt: now, shape: key, suppressed: 0 });
    return { log: true, suppressed };
  }

  /** Users currently remembered; diagnostics and tests. */
  size(): number {
    return this.last.size;
  }

  /**
   * Entries for users quiet for the interval or longer carry no information;
   * drop them. Quiet means no rebuild at all, logged or suppressed (`seenAt`):
   * a user whose every rebuild in the interval was suppressed is not quiet,
   * and dropping them would lose the count their next line reports. An entry
   * stamped LATER than now was written before the clock stepped backwards:
   * its age is unknowable across the step, so it is restamped as seen now and
   * ages from here — otherwise a large step would keep every pre-step user
   * for as long as the step, past the stated bound.
   */
  private prune(now: number, except: string): void {
    for (const [userId, entry] of this.last) {
      if (entry.seenAt > now) {
        entry.seenAt = now;
        if (entry.at > now) entry.at = now;
      } else if (userId !== except && now - entry.seenAt >= this.intervalMs) {
        this.last.delete(userId);
      }
    }
  }
}
