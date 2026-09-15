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
 * `enabled: false` never reads — for a host that already knows the answer is
 * not for this viewer.
 */
export function useSetupStatus(enabled = true): SetupStatusRead {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** The latest read; an answer to any earlier one is out of date. */
  const latest = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
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

  useEffect(refresh, [refresh]);

  return { status, failed, loaded, refresh };
}
