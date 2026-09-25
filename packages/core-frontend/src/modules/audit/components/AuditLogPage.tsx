import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, KeyRound } from 'lucide-react';
import { PageShell } from '../../../shared/components/PageShell';
import { Dialog } from '../../../shared/components/Dialog';
import { Badge, Banner, Button } from '../../../shared/components';
import { cn, formatRelativeTime } from '../../../lib/utils';
import { GITHUB_LINK_KIND } from '../../../shared/marketplace-url';
import { useAdmin } from '../../admin/state/admin.context';
import { useAuth } from '../../auth/state/auth.context';
import { listPrincipals, revokeAgent, revokeKey, type AuditPrincipal } from '../services/audit.api';
import { groupByAccount, principalKey } from './principal-grouping';
import { AuditEventsPanel } from './AuditEventsPanel';

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

/** What a row is, in the words the page uses: an OAuth agent, a Claude link, or a hand-made key. */
function kindLabel(p: AuditPrincipal): string {
  if (p.kind === 'agent') return 'Agent · OAuth';
  return p.keyKind === GITHUB_LINK_KIND ? 'Claude link' : 'Connection key';
}

function eventsLabel(n: number): string {
  if (n === 0) return 'No events yet';
  return `${n.toLocaleString()} ${n === 1 ? 'event' : 'events'}`;
}

/**
 * The Audit log (`/audit-log`): every agent and connection key connected to
 * your account — or, for admins, to every account — with when it connected,
 * when it was last used and how much it has called; a revoke for each; and,
 * under each row when opened, the list of what it called, newest first.
 *
 * It replaced the admin-only Connection keys overview. Keys are still minted
 * and deleted for good on External agent access; here they are listed,
 * watched and revoked beside the OAuth agents, which had no page at all.
 *
 * Revoking keeps the row (dimmed, marked with who revoked it) so its history
 * stays readable. Revoked rows are hidden by default — on a busy deployment
 * they outnumber the live ones — and a toggle brings them back.
 */
export function AuditLogPage() {
  const { user } = useAuth();
  const { isAdmin, isAdminLoading } = useAdmin();
  // The admin verdict decides which scope to ask for; asking before it has
  // settled would fetch a member's list and then an admin's a moment later.
  const settled = isAdminLoading !== true;

  const [principals, setPrincipals] = useState<AuditPrincipal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [query, setQuery] = useState('');
  // Which rows are open, and which have EVER been opened: a panel stays
  // mounted after its first open (hidden when collapsed), so re-expanding
  // costs no request and keeps its filters and loaded pages.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // The row awaiting revoke confirmation; non-null drives the confirm
  // Dialog. `revoking` keeps the confirm open while the request is in flight.
  const [pendingRevoke, setPendingRevoke] = useState<AuditPrincipal | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Generation of the newest load. Two revokes in quick succession start two
  // reloads, and the older one can land last — carrying a row the newer one
  // already saw revoked. Only the latest load may write `principals`.
  const loadGen = useRef(0);
  const refresh = useCallback(() => {
    const gen = ++loadGen.current;
    listPrincipals(isAdmin ? 'all' : 'me')
      .then((rows) => {
        if (gen !== loadGen.current) return;
        setPrincipals(rows);
        setError(null);
      })
      .catch((err) => {
        if (gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : "Couldn't load the audit log.");
        // `principals` is deliberately left alone: a reload that fails keeps
        // the rows it had, and a first load that fails stays `null` rather
        // than rendering "nothing connected" for a deployment we cannot reach.
      });
  }, [isAdmin]);

  useEffect(() => {
    if (settled) refresh();
  }, [settled, refresh]);

  const groups = useMemo(
    () => (principals ? groupByAccount(principals, { includeRevoked: showRevoked, query: isAdmin ? query : '' }) : []),
    [principals, showRevoked, query, isAdmin],
  );
  const liveCount = principals?.filter((p) => p.revokedAt === null).length ?? 0;
  const revokedCount = (principals?.length ?? 0) - liveCount;
  const accountCount = useMemo(() => new Set(principals?.map((p) => p.user.id)).size, [principals]);

  const toggle = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
    setOpened((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };

  async function confirmRevoke() {
    if (!pendingRevoke || revoking) return;
    setRevoking(true);
    setError(null);
    try {
      const target = pendingRevoke;
      if (target.kind === 'agent') await revokeAgent(target.id);
      else await revokeKey(target.id);
      // The server has revoked it; say so at once rather than waiting on the
      // reload. If that reload fails, the row must not sit there looking live
      // with a Revoke button — the agent holding it is already cut off.
      const by: AuditPrincipal['revokedBy'] = user && target.user.id === user.id ? 'owner' : 'admin';
      setPrincipals((prev) =>
        prev
          ? prev.map((p) =>
              p.kind === target.kind && p.id === target.id && p.revokedAt === null
                ? { ...p, revokedAt: Date.now(), revokedBy: by }
                : p,
            )
          : prev,
      );
      setPendingRevoke(null);
      refresh();
    } catch (err) {
      setPendingRevoke(null);
      setError(err instanceof Error ? err.message : "Couldn't revoke this.");
    } finally {
      setRevoking(false);
    }
  }

  const revokeVerb = (p: AuditPrincipal) => (p.kind === 'agent' ? 'Revoke access' : 'Revoke key');

  return (
    <>
      <PageShell title="Audit log" width="4xl" card={false}>
        <div className="space-y-4">
          <p className="text-xs text-ink-muted leading-snug max-w-[65ch]">
            {isAdmin
              ? 'Every agent and connection key on this deployment, per account. Open one to see what it called and when. Revoking cuts the agent off immediately; the row stays so its history remains visible.'
              : 'The agents and connection keys connected to your account. Open one to see what it called and when. Revoking cuts the agent off immediately; it can reconnect by signing in again.'}
          </p>

          {error && (
            <Banner tone="danger" role="alert" className="text-detail">
              {error}
            </Banner>
          )}

          {principals !== null && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-ink-muted">
              <span>
                {isAdmin && `${accountCount} ${accountCount === 1 ? 'account' : 'accounts'} · `}
                {liveCount} live
                {revokedCount > 0 && ` · ${revokedCount} revoked`}
              </span>
              <div className="flex flex-wrap items-center gap-3">
                {isAdmin && (
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter by person or agent"
                    aria-label="Filter by person or agent"
                    className="bg-white border border-line rounded-sm px-2 py-1 text-detail text-ink focus:outline-none focus:border-accent min-w-[200px]"
                  />
                )}
                {revokedCount > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showRevoked}
                      onChange={(e) => setShowRevoked(e.target.checked)}
                    />
                    Show revoked
                  </label>
                )}
              </div>
            </div>
          )}

          {principals === null ? (
            error ? null : <div className="text-xs text-ink-muted">Loading…</div>
          ) : groups.length === 0 ? (
            <div className="text-xs text-ink-muted">
              {principals.length === 0
                ? isAdmin
                  ? 'No agents or connection keys on this deployment.'
                  : 'Nothing connected to your account yet. Connect an agent from External agent access.'
                : query.trim()
                  ? 'Nothing matches that filter.'
                  : 'No live agents or connection keys.'}
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map((group) => {
                const live = group.principals.filter((p) => p.revokedAt === null).length;
                return (
                  <section key={group.user.id} aria-label={`Agents and keys for ${group.user.email}`}>
                    {isAdmin && (
                      <div className="flex items-baseline gap-2 px-1 pb-1.5">
                        <span className="text-sm font-medium truncate">{group.user.name}</span>
                        <span className="text-meta text-ink-muted truncate">{group.user.email}</span>
                        <span className="ml-auto text-meta text-ink-muted whitespace-nowrap">{live} live</span>
                      </div>
                    )}
                    <ul className="divide-y divide-line border border-line rounded-md bg-white shadow-card overflow-hidden">
                      {group.principals.map((p) => {
                        const key = principalKey(p);
                        const revoked = p.revokedAt !== null;
                        const open = !!expanded[key];
                        const panelId = `audit-events-${p.kind}-${p.id}`;
                        const Icon = p.kind === 'agent' ? Bot : KeyRound;
                        return (
                          <li key={key}>
                            {/* The WHOLE row opens the events, chevron at its far edge, the
                                way a disclosure row reads. A button cannot nest the Revoke
                                button, so the expand button is stretched over the row by
                                its ::after pseudo-element instead (padding, chevron and all)
                                and Revoke is raised above that overlay. `relative` stays on
                                THIS row div, not the <li>: the overlay must never cover the
                                events panel below. */}
                            <div
                              className={cn(
                                'relative flex items-center gap-3 px-3 py-2 text-sm hover:bg-surface-hover',
                                open && 'bg-surface-hover',
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => toggle(key)}
                                aria-expanded={open}
                                // Only once the panel exists: a reference to an id that is
                                // not in the document is an invalid one, and the panel is
                                // mounted on the row's first open.
                                aria-controls={opened[key] ? panelId : undefined}
                                className={cn(
                                  'flex flex-1 min-w-0 items-center gap-3 text-left',
                                  "after:absolute after:inset-0 after:content-['']",
                                  'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent',
                                  revoked && 'opacity-60',
                                )}
                              >
                                <span
                                  aria-hidden
                                  className="flex-none size-7 rounded-sm bg-sunken inline-flex items-center justify-center text-ink-muted"
                                >
                                  <Icon size={15} />
                                </span>
                                <span className="flex-1 min-w-0">
                                  <span className="flex items-center gap-2 font-medium">
                                    <span className="truncate">{p.label}</span>
                                    <Badge tone="outline">{kindLabel(p)}</Badge>
                                    {revoked && (
                                      <Badge tone={p.revokedBy === 'admin' ? 'danger' : 'neutral'}>
                                        {p.revokedBy === 'admin' ? 'Revoked by an admin' : 'Disconnected by owner'}
                                      </Badge>
                                    )}
                                    {/* The owner deleted it from their own pages; the row and its
                                        events stay here, for admins, until retention prunes them. */}
                                    {p.deletedAt != null && <Badge tone="outline">Deleted by owner</Badge>}
                                  </span>
                                  <span className="block text-meta text-ink-muted">
                                    <span title={formatAbsolute(p.createdAt)}>
                                      {p.kind === 'agent' ? 'Connected' : 'Created'} {formatRelative(p.createdAt)}
                                    </span>
                                    {' · '}
                                    <span title={formatAbsolute(p.lastUsedAt)}>Last used {formatRelative(p.lastUsedAt)}</span>
                                    {revoked && (
                                      <>
                                        {' · '}
                                        <span title={formatAbsolute(p.revokedAt)}>Revoked {formatRelative(p.revokedAt)}</span>
                                      </>
                                    )}
                                    {' · '}
                                    {eventsLabel(p.eventCount)}
                                  </span>
                                </span>
                              </button>
                              {!revoked && (
                                <Button
                                  variant="danger"
                                  size="sm"
                                  className="relative z-10"
                                  onClick={() => setPendingRevoke(p)}
                                  title={
                                    p.kind === 'agent'
                                      ? 'Revoke this agent’s access. It will have to sign in again to reconnect.'
                                      : 'Revoke this key. The external agent using it will lose access.'
                                  }
                                  aria-label={`${revokeVerb(p)} for ${p.label} (${group.user.email})`}
                                >
                                  {revokeVerb(p)}
                                </Button>
                              )}
                              <ChevronRight
                                aria-hidden
                                size={14}
                                className={cn('flex-none text-ink-faint transition-transform', open && 'rotate-90')}
                              />
                            </div>
                            {opened[key] && (
                              <div
                                id={panelId}
                                hidden={!open}
                                className="border-t border-line bg-sunken px-3 py-3"
                              >
                                <AuditEventsPanel kind={p.kind} id={p.id} label={p.label} />
                              </div>
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
        title={pendingRevoke?.kind === 'agent' ? 'Revoke agent access' : 'Revoke connection key'}
        size="sm"
        busy={revoking}
        footer={
          <>
            <Button variant="outline" onClick={() => setPendingRevoke(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRevoke} disabled={revoking}>
              {revoking ? 'Revoking…' : pendingRevoke ? revokeVerb(pendingRevoke) : 'Revoke'}
            </Button>
          </>
        }
      >
        <p className="text-xs text-ink leading-snug">
          {pendingRevoke?.kind === 'agent' ? (
            <>
              Revoke <span className="font-medium">{pendingRevoke.label}</span>&rsquo;s access for{' '}
              <span className="font-medium">
                {pendingRevoke.user.name} ({pendingRevoke.user.email})
              </span>
              ? Every token it holds stops working now. It can reconnect only by signing in again through the
              browser. Its history stays visible here.
            </>
          ) : (
            <>
              Revoke <span className="font-medium">{pendingRevoke?.label}</span> belonging to{' '}
              <span className="font-medium">
                {pendingRevoke?.user.name} ({pendingRevoke?.user.email})
              </span>
              ? Whatever is using it loses access immediately. The key stays listed so its history remains
              visible; its owner can delete it for good from External agent access.
            </>
          )}
        </p>
      </Dialog>
    </>
  );
}
