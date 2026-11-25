/**
 * Runs `run` for a burst of requests without running it once per request.
 *
 * The first request starts a run. Requests that arrive while it is under way
 * are answered by ONE more run, started when the first ends: that run sees
 * everything that changed during the first, so nothing is missed, and a burst
 * of any length costs two runs at most. A run that fails counts as ended.
 *
 * Made for the file explorer's tree: every change on a branch used to make
 * every open tab ask the server for the whole tree, one request per event,
 * and a busy branch kept the server building trees for answers nobody read.
 */
export function mergedRunner(run: () => Promise<unknown>): () => void {
  let underWay = false;
  let again = false;
  const start = (): void => {
    underWay = true;
    void run()
      .catch(() => undefined)
      .then(() => {
        underWay = false;
        if (again) {
          again = false;
          start();
        }
      });
  };
  return () => {
    if (underWay) again = true;
    else start();
  };
}
