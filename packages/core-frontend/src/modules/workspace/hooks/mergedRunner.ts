/**
 * Runs `run` for a burst of requests without running it once per request.
 *
 * The first request starts a run. Requests that arrive while a run is under
 * way are answered by ONE more run, started when that one ends: it sees
 * everything that changed during the run before it, so nothing is missed.
 * However many requests arrive, runs never overlap and there is at most one
 * per run's length; a burst that lasts longer than a run costs one run after
 * another for as long as it lasts, not one per request.
 *
 * A run that fails counts as ended. So does one that has not ended after
 * `giveUpAfterMs`: it no longer holds the next run back, so one request that
 * never settles cannot stop every later one. Its answer may still arrive,
 * after a later run's: `run` is handed `isLatest`, which is false once a later
 * run has started or the runner was stopped, and a run that applies what it
 * fetched asks it first, so an old answer never replaces a newer one.
 *
 * `stop()` ends it: no run starts after it, the queued one included. For the
 * caller whose subject changed (another workspace) while a run was under way.
 *
 * Made for the file explorer's tree: every change on a branch used to make
 * every open tab ask the server for the whole tree, one request per event,
 * and a busy branch kept the server building trees for answers nobody read.
 */
export interface MergedRunner {
  request(): void;
  stop(): void;
}

export function mergedRunner(run: (isLatest: () => boolean) => Promise<unknown>, giveUpAfterMs = 60_000): MergedRunner {
  let underWay = false;
  let again = false;
  let stopped = false;
  let latest = 0;
  const start = (): void => {
    underWay = true;
    const mine = ++latest;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(limit);
      underWay = false;
      if (again && !stopped) {
        again = false;
        start();
      }
    };
    const limit = setTimeout(end, giveUpAfterMs);
    void run(() => !stopped && mine === latest)
      .catch(() => undefined)
      .then(end);
  };
  return {
    request() {
      if (stopped) return;
      if (underWay) again = true;
      else start();
    },
    stop() {
      stopped = true;
      again = false;
    },
  };
}
