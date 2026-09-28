import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { useLatestRef } from '../../../shared/components';
import { grantAccess } from '../api';
import { cancelPullRequest } from '../../pr/services/pr-cancel.api';
import type { AccessProposal, AccessRequestRow } from '../requests.api';

/**
 * The access requests one item's editors can answer, and the two ways to
 * answer them.
 *
 * ACCEPTING IS A GRANT, NOT A MERGE. A proposal is "give this principal this
 * verb on this item", so accepting it calls the ordinary access-grant API —
 * the same endpoint the Manage access dialog's own rows use, with the same
 * gate, lock and commit, and the same answer for a person the rules explicitly
 * deny. The request's branch is never merged, so nothing else it carries can
 * ride in on an approval, and a request naming five people can be answered
 * with two yeses and three ignores.
 *
 * The request then retires ITSELF: it is open exactly while it proposes
 * something the person does not already hold, so once the accepted grant lands
 * the server closes it and deletes the branch. `reconcile` just asks for that
 * check immediately instead of waiting for the next listing (which does it
 * too).
 *
 * Fetching is unconditional and degrades to `[]` — the endpoints answer `[]`
 * to non-editors rather than 403, so "am I an editor here" stays a question
 * only the server answers.
 */
export interface AccessRequestsState {
  requests: AccessRequestRow[];
  /** Grant one proposal, then settle the request if that was the last one. */
  accept(request: AccessRequestRow, proposal: AccessProposal): Promise<void>;
  /** Decline the whole request — reject the change request. */
  decline(request: AccessRequestRow): Promise<void>;
  /** Why answering a request failed, by request number. Cleared by a retry. */
  errors: Readonly<Record<number, string>>;
  /** Request numbers being answered right now. */
  busy: Readonly<Record<number, boolean>>;
  reload(): void;
}

/** Where the requests come from — one item's listing and its settle call. */
export interface AccessRequestsSource {
  list(): Promise<AccessRequestRow[]>;
  reconcile(number: number): Promise<boolean>;
}

export interface UseAccessRequestsOptions {
  /**
   * What identifies the item. Requests are shown only while the key they
   * arrived for is still the one being asked about: a page that moves from
   * skill A to skill B without unmounting must not show A's requests until
   * B's arrive — a banner that lets an editor grant A's proposal against B's
   * rules.
   */
  itemKey: string | null;
  source: AccessRequestsSource;
  /** What an Accept grants on. Null ⇒ Accept does nothing. */
  grantOn: { path: string; kind: 'folder' | 'file' } | null;
  /** Run after a grant lands — where the caller re-reads what it shows. */
  onGranted?(): void | Promise<void>;
  /** Told what went wrong, on top of the per-request `errors` map. */
  onError?(message: string): void;
  /** Told what landed, for surfaces that announce it. */
  onAccepted?(message: string): void;
}

export function useAccessRequests(opts: UseAccessRequestsOptions): AccessRequestsState {
  const { itemKey, source, grantOn, onGranted, onError, onAccepted } = opts;
  // Keyed by the item they came from — see `itemKey`.
  const [loaded, setLoaded] = useState<{ key: string; rows: AccessRequestRow[] } | null>(null);
  const requests = loaded && itemKey !== null && loaded.key === itemKey ? loaded.rows : [];
  const [revision, setRevision] = useState(0);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  // Held in a ref rather than in the effect's deps: these are values the
  // caller rebuilds on every render, and depending on them would refetch the
  // listing on every render — including the re-render the listing's own answer
  // causes. Read only from effects and event handlers, never during render.
  const live = useLatestRef({ source, grantOn, onGranted, onError, onAccepted });

  useEffect(() => {
    if (itemKey === null) return;
    let cancelled = false;
    live.current.source
      .list()
      .then((rows) => {
        if (!cancelled) setLoaded({ key: itemKey, rows });
      })
      .catch(() => {
        // Silent: an editor surface that fails must not put an error banner in
        // front of somebody who came to read the item.
      });
    return () => {
      cancelled = true;
    };
  // `live` is a stable ref object; it is listed only to satisfy the rule.
  }, [itemKey, revision, live]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  const mark = (number: number, running: boolean) =>
    setBusy((b) => ({ ...b, [number]: running }));

  const accept = useCallback(async (request: AccessRequestRow, proposal: AccessProposal) => {
    const { grantOn: target, onGranted: granted, onError: fail, onAccepted: ok } = live.current;
    if (!target) return;
    setErrors((e) => {
      if (!(request.number in e)) return e;
      const next = { ...e };
      delete next[request.number];
      return next;
    });
    mark(request.number, true);
    try {
      await grantAccess(encodeURIComponent(DEFAULT_BRANCH), {
        path: target.path,
        kind: target.kind,
        verb: proposal.verb,
        principal: proposal.principal,
      });
    } catch (err) {
      // The request STAYS OPEN: nothing was granted, so there is nothing to
      // settle, and hiding the line would lose the only place the refusal is
      // visible.
      const message = err instanceof Error ? err.message : "Couldn't grant that: try again.";
      setErrors((e) => ({ ...e, [request.number]: message }));
      fail?.(message);
      mark(request.number, false);
      setRevision((r) => r + 1);
      return;
    }
    // Drop the accepted proposal locally so the row goes immediately; the
    // refetch below is what makes it true.
    setLoaded((cur) =>
      cur && itemKey !== null && cur.key === itemKey
        ? {
            ...cur,
            rows: cur.rows.map((r) =>
              r.number === request.number
                ? {
                    ...r,
                    proposals: r.proposals.filter(
                      (p) => !(p.id === proposal.id && p.verb === proposal.verb),
                    ),
                  }
                : r,
            ),
          }
        : cur,
    );
    ok?.(`${proposal.label} now has ${proposal.verb} access.`);
    // The caller re-reads FIRST: the new row has to be on screen by the time
    // the request's line goes, or accepting looks like it did nothing.
    await Promise.resolve(granted?.()).catch(() => undefined);
    await live.current.source.reconcile(request.number).catch(() => false);
    mark(request.number, false);
    setRevision((r) => r + 1);
  }, [itemKey, live]);

  const decline = useCallback(async (request: AccessRequestRow) => {
    mark(request.number, true);
    try {
      await cancelPullRequest(request.number);
      setErrors((e) => {
        if (!(request.number in e)) return e;
        const next = { ...e };
        delete next[request.number];
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't dismiss that: try again.";
      setErrors((e) => ({ ...e, [request.number]: message }));
      live.current.onError?.(message);
    }
    mark(request.number, false);
    setRevision((r) => r + 1);
  }, [live]);

  return { requests, accept, decline, errors, busy, reload };
}
