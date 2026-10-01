import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { authFetch } from '../../../lib/api';

/** How often the banner asks again, so it goes away soon after an admin fixes the cause. */
const POLL_MS = 60_000;

/**
 * App-wide notice that the deployment is read-only right now (`GET
 * /api/write-access`): everyone can still sign in and read, but every change
 * is refused until the cause is fixed — on a host that sells seats, more
 * people are switched on than the plan allows. Said once, here, with the
 * host's own words, instead of letting each save fail on its own.
 *
 * Renders nothing while the deployment is writable, which on a core
 * deployment is always.
 */
export function ReadOnlyBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      authFetch('/api/write-access')
        .then((res) => (res.ok ? res.json() : { writable: true }))
        .then((body: { writable?: boolean; message?: string }) => {
          if (!cancelled) setMessage(body.writable === false ? (body.message ?? 'This workspace is read-only.') : null);
        })
        // An unanswered check says nothing about the workspace; keep what we knew.
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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
