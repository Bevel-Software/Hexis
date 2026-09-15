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
 * Bounded: an entry per user, pruned as they go quiet for longer than the
 * interval, so a long-running process never accumulates departed users.
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
  at: number;
  shape: string;
  suppressed: number;
}

export class SurfaceLogThrottle {
  private readonly last = new Map<string, LastLogged>();

  constructor(
    private readonly intervalMs: number = DEFAULT_SURFACE_LOG_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a rebuild for `userId` and say whether to log it. */
  decide(userId: string, shape: SurfaceShape): SurfaceLogDecision {
    const now = this.now();
    // Prune the OTHERS: this user's entry is about to be read, and at exactly
    // the interval it still carries the suppressed count the next line owes.
    this.prune(now, userId);
    const key = `${shape.tools}/${shape.manuals}`;
    const prev = this.last.get(userId);
    if (prev && prev.shape === key && now - prev.at < this.intervalMs) {
      prev.suppressed += 1;
      return { log: false, suppressed: prev.suppressed };
    }
    const suppressed = prev?.suppressed ?? 0;
    this.last.set(userId, { at: now, shape: key, suppressed: 0 });
    return { log: true, suppressed };
  }

  /** Entries for users quiet for the interval or longer carry no information; drop them. */
  private prune(now: number, except: string): void {
    for (const [userId, entry] of this.last) {
      if (userId !== except && now - entry.at >= this.intervalMs) this.last.delete(userId);
    }
  }
}
