import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageShell } from '../../../shared/components/PageShell';
import { Dialog } from '../../../shared/components/Dialog';
import { formatRelativeTime } from '../../../lib/utils';
import { GITHUB_LINK_KIND } from '../../../shared/marketplace-url';
import { useAdmin } from '../state/admin.context';
import {
  listConnectionKeys,
  revokeConnectionKey,
  type AdminConnectionKey,
} from '../services/connection-keys.api';
import { groupByAccount } from './connection-keys-grouping';

/**
 * The shared formatter, plus the one word it deliberately leaves to the caller:
 * a key that has never been used has no instant to describe.
 */
function formatRelative(ts: number | null): string {
  return formatRelativeTime(ts) || 'never';
}

/** The exact instant, for a hover — the row shows the relative form. */
function formatAbsolute(ts: number | null): string | undefined {
  return ts === null ? undefined : new Date(ts).toLocaleString();
}

/**
 * The Connection keys page (`/connection-keys`, admins only): every
 * connection key on the deployment, grouped per account, with when it was
 * created, when it was last used, and a revoke. It exists so a leaked or
 * forgotten key can be cut off without signing in as its owner. Revoking
 * keeps the row (dimmed, "Disconnected") so its last use stays visible;
 * only the owner can delete it for good, from their own External agent
 * access page. Disconnected keys are hidden by default — on a busy
 * deployment they outnumber the live ones — and a toggle brings them back.
 */
export function ConnectionKeysPage() {
  const { isAdmin } = useAdmin();
  const [keys, setKeys] = useState<AdminConnectionKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  // The key awaiting revoke confirmation; non-null drives the confirm
  // Dialog. `revoking` keeps the confirm open while the request is in flight.
  const [pendingRevoke, setPendingRevoke] = useState<AdminConnectionKey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = useCallback(() => {
    listConnectionKeys()
      .then((rows) => {
        setKeys(rows);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't load connection keys.");
        // `keys` is deliberately left alone: a reload that fails keeps the
        // rows it had, and a first load that fails stays `null` rather than
        // rendering "No connection keys" for a deployment we cannot reach.
      });
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  const groups = useMemo(() => (keys ? groupByAccount(keys, showRevoked) : []), [keys, showRevoked]);
  const liveCount = keys?.filter((k) => k.revokedAt === null).length ?? 0;
  const revokedCount = (keys?.length ?? 0) - liveCount;

  async function confirmRevoke() {
    if (!pendingRevoke || revoking) return;
    setRevoking(true);
    setError(null);
    try {
      await revokeConnectionKey(pendingRevoke.id);
      setPendingRevoke(null);
      refresh();
    } catch (err) {
      setPendingRevoke(null);
      setError(err instanceof Error ? err.message : "Couldn't revoke this key.");
    } finally {
      setRevoking(false);
    }
  }

  if (!isAdmin) {
    return (
      <PageShell title="Connection keys">
        <div className="text-sm text-ink-muted">
          Admins only. Your own keys are on the External agent access page.
        </div>
      </PageShell>
    );
  }

  return (
    <>
      <PageShell title="Connection keys">
        <div className="space-y-4">
          <p className="text-xs text-ink-muted leading-snug">
            Every connection key on this deployment, per account. Revoking a key cuts off the
            external agent using it immediately; the key stays listed as disconnected so you can
            still see when it was last used. Only its owner can delete it for good.
          </p>

          {error && (
            <div
              className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-sm px-2 py-1.5"
              role="alert"
            >
              {error}
            </div>
          )}

          {keys !== null && (
            <div className="flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span>
                {liveCount} live {liveCount === 1 ? 'key' : 'keys'}
                {revokedCount > 0 && ` · ${revokedCount} disconnected`}
              </span>
              {revokedCount > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showRevoked}
                    onChange={(e) => setShowRevoked(e.target.checked)}
                  />
                  Show disconnected keys
                </label>
              )}
            </div>
          )}

          {keys === null ? (
            error ? null : <div className="text-xs text-ink-muted">Loading…</div>
          ) : groups.length === 0 ? (
            <div className="text-xs text-ink-muted">
              {keys.length === 0 ? 'No connection keys on this deployment.' : 'No live connection keys.'}
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const live = group.keys.filter((k) => k.revokedAt === null).length;
                return (
                  <section key={group.user.id} aria-label={`Keys for ${group.user.email}`}>
                    <div className="flex items-baseline gap-2 px-1 pb-1.5">
                      <span className="text-sm font-medium truncate">{group.user.name}</span>
                      <span className="text-meta text-ink-muted truncate">{group.user.email}</span>
                      <span className="ml-auto text-meta text-ink-muted whitespace-nowrap">
                        {live} live
                      </span>
                    </div>
                    <ul className="divide-y divide-line border border-line rounded-sm">
                      {group.keys.map((k) => {
                        const revoked = k.revokedAt !== null;
                        return (
                          <li
                            key={k.id}
                            className={`flex items-center gap-3 px-3 py-2 text-sm ${
                              revoked ? 'opacity-60' : ''
                            }`}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">
                                {k.label}
                                {k.kind === GITHUB_LINK_KIND && (
                                  <span className="ml-1.5 text-meta font-normal text-ink-muted">
                                    Claude link
                                  </span>
                                )}
                              </div>
                              <div className="text-meta text-ink-muted">
                                <span title={formatAbsolute(k.createdAt)}>
                                  Created {formatRelative(k.createdAt)}
                                </span>
                                {' · '}
                                <span title={formatAbsolute(k.lastUsedAt)}>
                                  Last used {formatRelative(k.lastUsedAt)}
                                </span>
                                {revoked && (
                                  <>
                                    {' · '}
                                    <span title={formatAbsolute(k.revokedAt)}>
                                      Disconnected {formatRelative(k.revokedAt)}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                            {!revoked && (
                              <button
                                onClick={() => setPendingRevoke(k)}
                                className="text-xs px-2 py-1 rounded-sm text-red-700 hover:bg-red-50 border border-red-200"
                                title="Revoke this key. The external agent using it will lose access."
                                aria-label={`Revoke ${k.label} for ${group.user.email}`}
                              >
                                Revoke
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </PageShell>

      <Dialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title="Revoke connection key"
        size="sm"
        busy={revoking}
        footer={
          <>
            <button
              onClick={() => setPendingRevoke(null)}
              disabled={revoking}
              className="px-3 py-1.5 text-sm rounded-sm text-ink hover:bg-hover border border-line disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmRevoke}
              disabled={revoking}
              className="px-3 py-1.5 text-sm rounded-sm bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:hover:bg-red-600"
            >
              {revoking ? 'Revoking…' : 'Revoke key'}
            </button>
          </>
        }
      >
        <p className="text-xs text-ink leading-snug">
          Revoke <span className="font-medium">{pendingRevoke?.label}</span> belonging to{' '}
          <span className="font-medium">
            {pendingRevoke?.user.name} ({pendingRevoke?.user.email})
          </span>
          ? Whatever is using it loses access immediately. The key stays listed as disconnected
          so its last use remains visible; its owner can delete it for good from their External
          agent access page.
        </p>
      </Dialog>
    </>
  );
}
