import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSetupStatus, type SetupStatus } from '../services/setup.api';

export interface SetupStatusRead {
  /** The latest status that arrived. A failed read does not clear it. */
  status: SetupStatus | null;
  /** The latest read failed. */
  failed: boolean;
  /** A read has settled at least once. */
  loaded: boolean;
  /** Read the status again — after a save, a sync, or a "Try again". */
  refresh(): void;
}

/**
 * Every mounted reader, so a refresh asked for by one reaches them all. The
 * setup gate stays mounted for the app's whole life while the Deployment page
 * comes and goes; a save on the page that leaves the deployment incomplete
 * has to reach the gate, or the gate keeps showing the app over a server that
 * has shut its setup gate. One status, read by several screens: a refresh is
 * a fact about the deployment, not about the screen that asked.
 */
const readers = new Set<() => void>();

/**
 * The deployment's setup status, read the one way every screen that shows it
 * reads it: the setup gate and the Deployment page.
 *
 * LATEST READ WINS. Reads overlap — the refresh after a failed save can still
 * be out when a retry succeeds and asks again — and answers arrive in any
 * order. An answer to an EARLIER read describes a deployment that has since
 * moved on (it would put back the knowledge-base failure the retry just
 * cleared), so only the latest read's answer, success or failure, lands.
 *
 * A FAILED READ KEEPS THE LAST STATUS and says it failed, so each host decides
 * what that means: the gate lets the app through (the check is a guard, not an
 * authorisation boundary), the Deployment page keeps the form and offers a
 * retry.
 *
 * ONE REFRESH REACHES EVERY READER. `refresh()` re-reads on every mounted
 * instance of this hook, not only the one it was called on, so a screen that
 * changed the deployment cannot leave another showing the state before it.
 *
 * `enabled: false` never reads, and drops a read that was still out when it
 * turned false — for a host that already knows the answer is not for this
 * viewer.
 */
export function useSetupStatus(enabled = true): SetupStatusRead {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** The latest read; an answer to any earlier one is out of date. */
  const latest = useRef(0);

  const read = useCallback(() => {
    if (!enabled) {
      // Disabling outdates any read still out, exactly as a newer read would:
      // its answer is for a viewer this hook no longer serves, and landing it
      // would leave that status waiting for whenever reading is enabled again.
      latest.current += 1;
      return;
    }
    const request = ++latest.current;
    const current = () => request === latest.current;
    fetchSetupStatus()
      .then((s) => {
        if (!current()) return;
        setStatus(s);
        setFailed(false);
      })
      .catch(() => {
        if (current()) setFailed(true);
      })
      .finally(() => {
        if (current()) setLoaded(true);
      });
  }, [enabled]);

  // Registered for as long as this instance is mounted; the mount reads once.
  useEffect(() => {
    readers.add(read);
    read();
    return () => {
      readers.delete(read);
    };
  }, [read]);

  const refresh = useCallback(() => {
    for (const reader of readers) reader();
  }, []);

  return { status, failed, loaded, refresh };
}
