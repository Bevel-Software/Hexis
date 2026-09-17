import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import {
  listMyChangeRequests,
  listOpenChangeRequests,
} from '../../change-requests/services/change-requests.api';
import { useWorkspace } from './workspace.context';
import {
  PR_STALE_EVENT,
  SUGGESTIONS_OPTIMISTIC_EVENT,
  SUGGESTIONS_RETRACTED_EVENT,
} from '../../../core/events';
import {
  NO_CHANGE_REQUESTS,
  OpenChangeRequestsContext,
  type OpenChangeRequests,
} from './open-change-requests.context';

/**
 * ONE fetch, shared by the tree, the tab strip and the page banner.
 *
 * Three things about this are easy to get wrong, and none of them fails
 * loudly — a degraded change-request signal renders NOTHING, which looks
 * exactly like "there are no open requests".
 *
 * **1. A different endpoint from the dock.** This fetches
 * `listOpenChangeRequests()` — EVERY open request — not the dock's
 * `listPullRequestsForMe()`, which the backend filters to requests you
 * authored or whose paths you can write. That scoping is right for a QUEUE
 * and wrong for a SIGNAL: a colleague's open request on a file you can read
 * but not write would silently get no dot, and the same file would show a
 * change-request marker in the Library and none in Knowledge. The broad
 * endpoint is already on the wire and already consumed by `useLibraryData`
 * for exactly this purpose, so this is parity, not scope creep.
 *
 * **2. Two path spaces.** `touchedNodePaths` is KB-repo-relative
 * (`Knowledge/Foo.md`) — its own docstring says so, because the backend
 * produces it with `git diff --name-only` inside the KB clone. The tree, the
 * tabs and `openFilePath` are workspace-relative and carry the `kbDirName`
 * prefix (`knowledge-base/Knowledge/Foo.md`). A Set built straight from
 * `touchedNodePaths` and tested against tree paths matches ZERO rows. The
 * conversion happens here, once, on ingest — and while `kbDirName` is null we
 * return an EMPTY set rather than one that silently matches nothing.
 *
 * **3. One request, not one per row.** The tree renders this per row and the
 * strip per tab. A plain hook called from each consumer would give every tree
 * row its own request and its own listener, which is why the fetch lives in a
 * provider mounted once.
 */
export function OpenChangeRequestsProvider({ children }: { children: ReactNode }) {
  const { kbDirName } = useWorkspace();
  const [requests, setRequests] = useState<PullRequestSummary[]>([]);
  /**
   * The caller's OWN open requests, from `/mine` — the identity filter lives
   * server-side (email-hash match), which is the only place it can: the broad
   * list deliberately exposes no email to compare against.
   */
  const [mine, setMine] = useState<PullRequestSummary[]>([]);
  /**
   * Requests the CLIENT just made true — a suggestion-routed upload announces
   * its files here the moment the bytes land, because the server's own
   * touched-path diff can trail the background commit worker by many seconds
   * and the fetched list would show nothing where the user just dropped a
   * folder. Each entry is merged into the derived values below and dropped as
   * soon as a REAL fetch covers all its paths — the server's answer wins the
   * moment it exists.
   */
  const [announced, setAnnounced] = useState<{ cr: PullRequestSummary; at: number }[]>([]);
  /**
   * The other direction: folders whose proposed files the client just took
   * out of every request (a folder delete). Paths under one are hidden until
   * BOTH lists have answered from a fetch that started after the retraction —
   * `answeredFrom` holds each list's latest answered start. Ordered by a
   * counter, not the clock: the retraction and its refetch happen in the same
   * tick, and two equal `Date.now()` stamps would keep the folder hidden
   * after the refetch answered. (The server has finished removing the files
   * before the event fires, so any fetch that starts later is the truth.)
   */
  const [retracted, setRetracted] = useState<{ prefix: string; at: number }[]>([]);
  const [answeredFrom, setAnsweredFrom] = useState({ all: 0, mine: 0 });

  useEffect(() => {
    let cancelled = false;
    /** Strictly increasing order of retractions and fetch starts. */
    let order = 0;
    const load = (opts: { fresh?: boolean } = {}) => {
      const startedOrder = ++order;
      // When THIS fetch left the building — only a fetch that STARTED after
      // an announcement may declare its request gone. The announce and the
      // stale event fire in the same tick, so a same-tick fresh fetch can
      // still race the server's own row; timestamps make "predates the
      // announcement" checkable instead of assumed.
      const startedAt = Date.now();
      listOpenChangeRequests(opts)
        .then((data) => {
          if (cancelled) return;
          setRequests(data);
          setAnsweredFrom((prev) => ({ ...prev, all: Math.max(prev.all, startedOrder) }));
        })
        .catch((err) => {
          // A queue that cannot load is not an error state on a page about a
          // document. The dots and the banner simply do not appear.
          console.warn('[OpenChangeRequests] load failed:', err);
          if (!cancelled) setRequests([]);
        });
      listMyChangeRequests(opts)
        .then((data) => {
          if (cancelled) return;
          const open = data.filter((c) => c.state === 'open');
          setMine(open);
          setAnsweredFrom((prev) => ({ ...prev, mine: Math.max(prev.mine, startedOrder) }));
          // Reconcile: an announced entry whose every path the real list now
          // carries has been overtaken; one whose request is GONE (declined,
          // merged, withdrawn elsewhere) must not haunt the tree either — but
          // only a FRESH fetch that STARTED after the announcement may say
          // "gone": anything earlier predates the request and would drop it
          // by race.
          setAnnounced((prev) =>
            prev.filter((a) => {
              const real = open.find((c) => c.number === a.cr.number);
              if (!real) return !(opts.fresh && startedAt > a.at);
              return !a.cr.touchedNodePaths.every((p) => real.touchedNodePaths.includes(p));
            }),
          );
        })
        .catch((err) => {
          // Same degradation contract: no suggestion rows, not an error page.
          console.warn('[OpenChangeRequests] mine load failed:', err);
          if (!cancelled) setMine([]);
        });
    };
    load();
    // The same signal the dock listens for: something in the app just changed
    // the request list (a proposal sent, a suggestion-routed upload landed,
    // an agent turn finished). FRESH, bypassing the backend's list cache —
    // the event fires because the sender KNOWS the list changed, and a cached
    // answer would hide exactly the change it is announcing (the suggestion
    // rows for a just-uploaded file would sit invisible until the TTL).
    const onStale = () => load({ fresh: true });
    window.addEventListener(PR_STALE_EVENT, onStale);
    const onAnnounce = (e: Event) => {
      const cr = (e as CustomEvent<PullRequestSummary>).detail;
      if (!cr || typeof cr.number !== 'number') return;
      setAnnounced((prev) => [
        ...prev.filter((p) => p.cr.number !== cr.number),
        { cr, at: Date.now() },
      ]);
    };
    window.addEventListener(SUGGESTIONS_OPTIMISTIC_EVENT, onAnnounce);
    const onRetract = (e: Event) => {
      const folder = (e as CustomEvent<{ folder?: unknown }>).detail?.folder;
      if (typeof folder !== 'string' || !folder) return;
      const prefix = `${folder.replace(/\/+$/, '')}/`;
      const at = ++order;
      setRetracted((prev) => [...prev.filter((r) => r.prefix !== prefix), { prefix, at }]);
      // An announced proposal under the folder is gone too.
      setAnnounced((prev) =>
        prev.map((a) => ({
          ...a,
          cr: { ...a.cr, touchedNodePaths: a.cr.touchedNodePaths.filter((p) => !p.startsWith(prefix)) },
        })),
      );
      load({ fresh: true });
    };
    window.addEventListener(SUGGESTIONS_RETRACTED_EVENT, onRetract);
    return () => {
      cancelled = true;
      window.removeEventListener(PR_STALE_EVENT, onStale);
      window.removeEventListener(SUGGESTIONS_OPTIMISTIC_EVENT, onAnnounce);
      window.removeEventListener(SUGGESTIONS_RETRACTED_EVENT, onRetract);
    };
  }, []);

  const value = useMemo<OpenChangeRequests>(() => {
    if (!kbDirName) return NO_CHANGE_REQUESTS;
    // A retraction stays in force until both lists answered from after it.
    const answered = Math.min(answeredFrom.all, answeredFrom.mine);
    const hidden = retracted.filter((r) => r.at > answered).map((r) => r.prefix);
    const touched = (pr: PullRequestSummary) =>
      hidden.length === 0
        ? pr.touchedNodePaths
        : pr.touchedNodePaths.filter((p) => !hidden.some((prefix) => p.startsWith(prefix)));
    const byPath = new Map<string, PullRequestSummary[]>();
    for (const pr of requests) {
      for (const repoRelative of touched(pr)) {
        const workspaceRelative = `${kbDirName}/${repoRelative}`;
        const list = byPath.get(workspaceRelative);
        if (list) list.push(pr);
        else byPath.set(workspaceRelative, [pr]);
      }
    }
    // `/mine` and the announced (optimistic) entries join every derived view,
    // without ever duplicating a request the broad list already shows on a
    // path. `/mine` matters here too: a suggestion row is created from
    // `minePaths`, and its click resolves the request through `forPath` — a
    // request the broad list is missing (touched-path lag, a failed broad
    // fetch) would otherwise produce a row whose click does nothing.
    const announcedCrs = announced.map((a) => a.cr);
    for (const pr of [...mine, ...announcedCrs]) {
      for (const repoRelative of touched(pr)) {
        const workspaceRelative = `${kbDirName}/${repoRelative}`;
        const list = byPath.get(workspaceRelative);
        if (!list) byPath.set(workspaceRelative, [pr]);
        else if (!list.some((c) => c.number === pr.number)) list.push(pr);
      }
    }
    // Same path-space conversion as above — `touchedNodePaths` is
    // KB-repo-relative here too. First open request wins a contested path;
    // one file in two of your own bundles is already a state the UI cannot
    // untangle, so the row just links to the older one.
    const minePaths = new Map<string, number>();
    for (const pr of [...mine, ...announcedCrs]) {
      for (const repoRelative of touched(pr)) {
        const workspaceRelative = `${kbDirName}/${repoRelative}`;
        if (!minePaths.has(workspaceRelative)) minePaths.set(workspaceRelative, pr.number);
      }
    }
    return {
      paths: new Set(byPath.keys()),
      forPath: (path: string) => byPath.get(path) ?? [],
      minePaths,
      mineNumbers: new Set([...mine, ...announcedCrs].map((pr) => pr.number)),
    };
  }, [requests, mine, announced, retracted, answeredFrom, kbDirName]);

  return (
    <OpenChangeRequestsContext.Provider value={value}>
      {children}
    </OpenChangeRequestsContext.Provider>
  );
}
