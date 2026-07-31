import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API_UNREACHABLE_EVENT } from '../../../lib/api';

/** How often to re-probe `/api/health` while the backend is down. */
const HEALTH_POLL_MS = 3_000;

/** Abort a probe that hangs (black-holed connection) — the probe loop gates
    on each probe finishing, so a stuck fetch would freeze the overlay. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe the backend. Bypasses `authFetch` on purpose: the health route is
 * unauthenticated, and a probe must never itself dispatch the
 * unreachable event this overlay listens for. A timed-out probe counts as
 * unhealthy.
 */
async function backendHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full-screen "we're updating" screen for backend downtime (Coolify rebuild /
 * container restart). Flow:
 *
 *   1. `authFetch` dispatches API_UNREACHABLE_EVENT when a request fails at
 *      the transport level (network error, or a 502/503/504 from the proxy
 *      in front of a dead upstream).
 *   2. On that signal we confirm via `/api/health` — a single flaky request
 *      must not take over the whole screen. Only a failed probe shows the
 *      overlay.
 *   3. While down, re-probe every HEALTH_POLL_MS. When health comes back the
 *      page reloads so the browser picks up the freshly deployed frontend
 *      bundle instead of running the old one against the new backend. If the
 *      user has unsaved work, FileViewer's `beforeunload` guard makes the
 *      browser ask before the reload discards it.
 *
 * This only covers users with the app already open. A fresh page load during
 * the rebuild is answered by the proxy before our code runs — that error page
 * is Coolify/Traefik configuration, not frontend code (see docs/deploy.md).
 */
export function MaintenanceOverlay() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Collapse overlapping signals: many in-flight requests fail at once
    // when the backend goes away, but one probe loop is enough.
    let probing = false;

    const onUnreachable = async () => {
      if (probing || cancelled) return;
      probing = true;
      try {
        if (await backendHealthy()) return; // isolated failure, not downtime
        if (cancelled) return;
        setDown(true);
        while (!cancelled) {
          await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
          if (await backendHealthy()) {
            window.location.reload();
            return;
          }
        }
      } finally {
        probing = false;
      }
    };

    window.addEventListener(API_UNREACHABLE_EVENT, onUnreachable);
    return () => {
      cancelled = true;
      window.removeEventListener(API_UNREACHABLE_EVENT, onUnreachable);
    };
  }, []);

  if (!down) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-white/95 backdrop-blur-sm text-center px-6">
      <Loader2 size={32} className="animate-spin text-bevel" />
      <div>
        <p className="text-lg font-medium text-slate-800">
          We&rsquo;re installing an update
        </p>
        <p className="mt-1 text-sm text-slate-600">
          This usually takes a minute or two. The page will refresh
          automatically as soon as everything is back.
        </p>
      </div>
    </div>
  );
}
