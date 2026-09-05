import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useAdmin } from '../../admin/state/admin.context';
import { useAuth } from '../../auth/state/auth.context';
import { fetchUpdateCheck, type UpdateCheckResult } from '../services/update-check.api';

/**
 * The one quiet line admins see when a newer release is published:
 * "Hexis 0.10.0 is available — see what's new". ADMINS ONLY — they are the
 * people who can act on it, and nobody else fetches or renders anything.
 *
 * Checked ONCE per app load (no polling — the server caches the answer for
 * hours anyway). Dismissing remembers the dismissed VERSION, so 0.10.0 stays
 * dismissed until 0.10.1 appears — PER ACCOUNT, like the rest of the
 * persisted admin state: on a shared machine one admin's dismissal must not
 * hide the line from the next admin who signs in.
 */

function dismissedKey(email: string | null): string {
  return `bevel.updateBanner.dismissedVersion.${(email ?? 'anonymous').toLowerCase()}`;
}

export function UpdateBanner() {
  const { isAdmin, isAdminLoading } = useAdmin();
  const { user } = useAuth();
  const storageKey = dismissedKey(user?.email ?? null);
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  // Read at RENDER time, not captured in state: the signed-in email (and with
  // it the storage key) can resolve after the first render, and a captured
  // initial read would keep consulting the anonymous key. A state tick just
  // forces the re-render after a dismissal writes.
  const [, setDismissTick] = useState(0);
  const dismissedVersion = localStorage.getItem(storageKey);

  // Fires once, when the admin verdict settles positive. Non-admins never
  // reach the fetch — the endpoint would 403 them anyway, and a guaranteed
  // 403 per page load is console noise nobody needs.
  useEffect(() => {
    if (isAdminLoading || !isAdmin) return;
    let cancelled = false;
    fetchUpdateCheck().then((result) => {
      if (!cancelled) setInfo(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, isAdminLoading]);

  if (!isAdmin || !info?.updateAvailable || !info.latest) return null;
  const latest = info.latest;
  if (dismissedVersion === latest) return null;

  const dismiss = () => {
    localStorage.setItem(storageKey, latest);
    setDismissTick((t) => t + 1);
  };

  // A calm neutral, deliberately quieter than the demo/danger banners: an
  // available update is information, not a condition.
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2 bg-sunken border-b border-line text-sm text-ink shrink-0"
    >
      <Sparkles size={16} className="shrink-0 text-ink-muted" />
      <span className="flex-1">
        Hexis {latest} is available
        {info.notesUrl && (
          <>
            {' — '}
            <a
              href={info.notesUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              see what&apos;s new
            </a>
          </>
        )}
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 p-1 rounded-sm text-ink-muted hover:text-ink hover:bg-hover"
      >
        <X size={14} />
      </button>
    </div>
  );
}
