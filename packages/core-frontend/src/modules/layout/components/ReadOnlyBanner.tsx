import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { authFetch, WRITE_ACCEPTED_EVENT, WRITE_REFUSED_EVENT } from '../../../lib/api';
import { useLatestRef } from '../../../shared/components/useLatestRef';

/** The least time between two checks made because the tab came back into view. */
const RETURN_CHECK_MS = 60_000;

/**
 * App-wide notice that the deployment is read-only right now (`GET
 * /api/write-access`): everyone can still sign in and read, but every change
 * is refused until the cause is fixed — on a host that sells seats, more
 * people are switched on than the plan allows. Said once, here, with the
 * host's own words, instead of letting each save fail on its own.
 *
 * Renders nothing while the deployment is writable, which on a core
 * deployment is always.
 *
 * ASKED ON ACTIVITY, NEVER ON A TIMER. Once when the app opens; when a
 * change is refused as read-only, which is how an open tab learns the state
 * began; when the tab comes back into view; and, while the banner is up,
 * when a change goes through, which is how it learns the state ended (an
 * admin switching accounts off). An idle tab on a deployment that can never
 * be read-only asks once and never again.
 */
export function ReadOnlyBanner() {
  const [message, setMessage] = useState<string | null>(null);
  const showing = useLatestRef(message !== null);

  useEffect(() => {
    let cancelled = false;
    // Only the latest check may decide: a slow answer to an earlier one must
    // not overwrite what a newer one said.
    let latest = 0;
    let lastAsked = 0;
    const check = () => {
      const mine = ++latest;
      lastAsked = Date.now();
      authFetch('/api/write-access')
        .then((res) => (res.ok ? res.json() : { writable: true }))
        .then((body: { writable?: boolean; message?: string }) => {
          if (cancelled || mine !== latest) return;
          setMessage(body.writable === false ? (body.message ?? 'This workspace is read-only.') : null);
        })
        // An unanswered check says nothing about the workspace; keep what we knew.
        .catch(() => undefined);
    };
    const onReturn = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAsked >= RETURN_CHECK_MS) check();
    };
    const onAccepted = () => {
      if (showing.current) check();
    };
    check();
    window.addEventListener(WRITE_REFUSED_EVENT, check);
    window.addEventListener(WRITE_ACCEPTED_EVENT, onAccepted);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      cancelled = true;
      window.removeEventListener(WRITE_REFUSED_EVENT, check);
      window.removeEventListener(WRITE_ACCEPTED_EVENT, onAccepted);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [showing]);
  // `showing` is a ref with a stable identity: the effect runs once.

  if (message === null) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2 border-b border-line text-sm shrink-0 bg-wait-soft text-ink"
    >
      <Lock size={16} className="shrink-0" />
      <span className="flex-1">
        <span className="font-semibold">Read-only.</span> {message}
      </span>
    </div>
  );
}
