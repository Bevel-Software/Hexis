import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, UsersRound, X } from 'lucide-react';
import { PageShell } from '../../../shared/components/PageShell';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { useAdmin } from '../state/admin.context';
import {
  addMember,
  assignGroup,
  convertRoleToGroup,
  fetchRoles,
  removeMember,
  RolesApiError,
  unassignGroup,
  type RoleRosterEntry,
} from '../services/roles.api';
import { suggestPrincipals } from '../../access/api';
import { EMAIL_RE, isGroupPrefixed } from '../../../lib/email';
import { useExclusiveRunner, type ExclusiveRunner } from '../hooks/useExclusiveRunner';

/** The default-branch workspace id — roles are managed there (admin status derives from it). */
// A function, not a constant: the branch model arrives from `/api/config`
// during boot, and a module-scope capture would freeze this at the empty
// string that exists before it.
const rolesWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

function initials(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return '?';
  const [name] = cleaned.split('@');
  const parts = name.split(/[.\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

interface SelfRemoveTarget {
  canonical: string;
  email: string;
}

/**
 * App roles (formerly Roles & Members), routed standalone at `/roles-and-members` (below the
 * persistent toolbar). Admin-gated: non-admins get a clear "Admins only"
 * state instead of the roster (the backend enforces the same gate on every
 * roles endpoint — this is presentation, not the security boundary).
 *
 * MEMBERSHIP ONLY. Roles are app-defined capabilities: the product decides
 * which roles exist, so there is deliberately no create / rename / delete
 * here (the backend routes are gone too). What an admin edits is who HOLDS
 * each role — individual emails, and group assignments on roles whose
 * capability allows it. Legacy pre-split people-set roles remain
 * membership-editable, with "Convert to group" as their migration path.
 */
export function AdminRolesPage() {
  const { isAdmin } = useAdmin();
  const [roster, setRoster] = useState<RoleRosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Bump on every load so a stale in-flight response never overwrites the
  // current roster. (The initial fetch does NOT go through the exclusive
  // runner, so — unlike the Groups page — a mutation response can still race
  // it; the bump in applyRoster is what drops the superseded load.)
  const requestId = useRef(0);

  // All roster mutations queue through here — see useExclusiveRunner. The
  // per-card busy/optimistic UX is untouched; only the requests serialize.
  const runExclusive = useExclusiveRunner();

  // Load the roster on mount (and again if admin status resolves later —
  // AdminProvider fetches admin status asynchronously, so `isAdmin` can flip
  // to true after the first render). All setState happens in the async
  // callbacks — never synchronously in the effect body — so this stays clear
  // of react-hooks/set-state-in-effect. `loading` starts true, so the spinner
  // is already showing until the first response lands.
  useEffect(() => {
    if (!isAdmin) return;
    const myReq = ++requestId.current;
    let active = true;
    fetchRoles()
      .then((rows) => {
        if (!active || myReq !== requestId.current) return;
        setRoster(rows);
        setError(null);
      })
      .catch((err) => {
        if (!active || myReq !== requestId.current) return;
        setError(errMessage(err, 'Failed to load roles'));
      })
      .finally(() => {
        if (active && myReq === requestId.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAdmin]);

  // Each mutation returns the fresh roster — set it directly (refetch-only).
  const applyRoster = useCallback((rows: RoleRosterEntry[]) => {
    // Bump so any in-flight load() result is dropped in favour of this fresher
    // mutation response.
    requestId.current++;
    setRoster(rows);
    // The bump above makes the superseded fetch's `.finally` skip its
    // `setLoading(false)` (its req id no longer matches), so clear the page
    // load state here — otherwise a mutation landing mid-load leaves the page
    // stuck spinning, or showing a stale load error under fresh rows.
    setLoading(false);
    setError(null);
  }, []);

  if (!isAdmin) {
    return (
      <PageShell title="App roles">
        <div className="text-sm text-ink-muted">
          Admins only. Ask an admin if you need a membership changed.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="App roles">
      <p className="mb-3 text-xs text-ink-muted leading-snug">
        Roles are defined by the app — what each one unlocks is fixed. Manage
        who holds them: add people by email, or assign a group.
      </p>
      {loading && roster.length === 0 ? (
        <div className="flex items-center gap-2 p-2 text-sm text-ink-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="p-3 text-sm text-danger bg-danger-soft border border-danger/30 rounded-sm">
          {error}
        </div>
      ) : roster.length === 0 ? (
        <div className="p-2 text-sm text-ink-muted">No roles.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {roster.map((role) => (
            <RoleCard
              key={role.canonical}
              role={role}
              onApply={applyRoster}
              runExclusive={runExclusive}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function RoleCard({
  role,
  onApply,
  runExclusive,
}: {
  role: RoleRosterEntry;
  onApply: (rows: RoleRosterEntry[]) => void;
  // Page-level mutation queue — every card's mutations share it.
  runExclusive: ExclusiveRunner;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-member input + people autocomplete (same suggest source as Manage
  // Access, scoped to people/emails — a role's members are emails).
  const [memberEmail, setMemberEmail] = useState('');
  const [suggestions, setSuggestions] = useState<{ name: string; email: string }[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const suggestReq = useRef(0);

  // Optimistic member removal: lowercased emails hidden from the chip list
  // before the server confirms. Reconciled when the authoritative roster lands.
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  // Optimistic member addition: canonicalised emails shown as chips before the
  // server confirms. Reconciled (dropped) once they appear in the authoritative
  // roster, or rolled back on error.
  const [pendingAdds, setPendingAdds] = useState<string[]>([]);

  useEffect(() => {
    const q = memberEmail.trim();
    // Server withholds people until q ≥ 2 chars (harvesting guard); mirror that.
    if (q.length < 2) {
      // Invalidate any in-flight request so a late 2+ char response can't
      // repopulate the dropdown after the user backspaced below the threshold.
      suggestReq.current++;
      setSuggestions([]);
      return;
    }
    const myReq = ++suggestReq.current;
    const t = setTimeout(() => {
      suggestPrincipals(rolesWorkspaceId(), q)
        .then((res) => {
          if (myReq !== suggestReq.current) return;
          // People only; drop anyone already a member (server or optimistic).
          const existing = new Set([
            ...role.members.map((m) => m.toLowerCase()),
            ...pendingAdds.map((e) => e.toLowerCase()),
          ]);
          setSuggestions((res.people ?? []).filter((p) => !existing.has(p.email.toLowerCase())));
        })
        .catch(() => {
          if (myReq === suggestReq.current) setSuggestions([]);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [memberEmail, role.members, pendingAdds]);

  // Dialogs.
  const [selfRemove, setSelfRemove] = useState<SelfRemoveTarget | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);

  // Assign-group input (roles with a group-assignable capability only).
  const [groupName, setGroupName] = useState('');

  // Members shown in the UI = server members minus any optimistically-removed,
  // plus any optimistically-added not yet reflected in the server roster.
  const serverMembers = role.members.filter((m) => !pendingRemovals.has(m.toLowerCase()));
  const serverLower = new Set(role.members.map((m) => m.toLowerCase()));
  const extraAdds = pendingAdds.filter((e) => !serverLower.has(e.toLowerCase()));
  const visibleMembers = [...serverMembers, ...extraAdds];

  // Self-heal the optimistic set against the authoritative roster: once the
  // server confirms (member gone) OR a removal was a no-op (member never there),
  // the email is no longer in role.members, so drop it from pendingRemovals.
  // Without this, a no-op remove would hide a still-present member forever.
  useEffect(() => {
    setPendingRemovals((prev) => {
      if (prev.size === 0) return prev;
      const present = new Set(role.members.map((m) => m.toLowerCase()));
      const next = new Set([...prev].filter((e) => present.has(e)));
      return next.size === prev.size ? prev : next;
    });
    // Once the server roster includes a pending-add, drop it — the real member
    // chip now renders it, so keeping it in pendingAdds would double-list it.
    setPendingAdds((prev) => {
      if (prev.length === 0) return prev;
      const present = new Set(role.members.map((m) => m.toLowerCase()));
      const next = prev.filter((e) => !present.has(e.toLowerCase()));
      return next.length === prev.length ? prev : next;
    });
  }, [role.members]);

  const run = useCallback(
    async (fn: () => Promise<RoleRosterEntry[]>) => {
      setBusy(true);
      setError(null);
      try {
        const rows = await runExclusive(fn);
        onApply(rows);
        return true;
      } catch (err) {
        setError(errMessage(err, 'Operation failed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onApply, runExclusive],
  );

  const submitAddMember = async (override?: string) => {
    const email = (override ?? memberEmail).trim();
    // Mirror the backend's refusal of `group:`-prefixed member values with an
    // inline hint (a `group:lee@x.io` would pass the email regex server-side
    // check order matters — see roles-edit.addMember).
    if (isGroupPrefixed(email)) {
      setError(
        'Members are emails — to give this role to a group, use the group assignment instead.',
      );
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    const lower = email.toLowerCase();
    // Already a member (or already pending) — clear the input and do nothing.
    if (
      role.members.some((m) => m.toLowerCase() === lower) ||
      pendingAdds.some((e) => e.toLowerCase() === lower)
    ) {
      setMemberEmail('');
      setShowSuggest(false);
      setSuggestions([]);
      return;
    }
    // Optimistic: show the chip and clear the input immediately. The add commit
    // runs in the background; the authoritative roster reconciles it (the
    // self-heal effect drops it from pendingAdds), or we roll back on error.
    // Not gated on `busy` — same posture as removal.
    setError(null);
    setPendingAdds((prev) => [...prev, email]);
    setMemberEmail('');
    setShowSuggest(false);
    setSuggestions([]);
    try {
      const rows = await runExclusive(() => addMember(role.canonical, email));
      onApply(rows);
    } catch (err) {
      // Roll back the optimistic chip so it disappears.
      setPendingAdds((prev) => prev.filter((e) => e.toLowerCase() !== lower));
      setError(errMessage(err, 'Failed to add member'));
    }
  };

  const handleRemoveMember = async (email: string) => {
    setError(null);
    const lower = email.toLowerCase();
    // If this chip is an optimistic add not yet on the server, just drop it from
    // pendingAdds — there is nothing committed to remove. (If a prior add commit
    // is still in flight, its self-heal will re-add the real chip; removing it
    // again is then a normal server removal.)
    const isServerMember = role.members.some((m) => m.toLowerCase() === lower);
    if (!isServerMember && pendingAdds.some((e) => e.toLowerCase() === lower)) {
      setPendingAdds((prev) => prev.filter((e) => e.toLowerCase() !== lower));
      return;
    }
    // Optimistic: hide the chip immediately so removal feels instant. The
    // server's authoritative roster reconciles it on response (or it reappears
    // on error). We do NOT set `busy` here — the row stays interactive and the
    // chip just disappears, which is the whole point of optimism.
    setPendingRemovals((s) => new Set(s).add(email.toLowerCase()));
    try {
      const rows = await runExclusive(() => removeMember(role.canonical, email));
      onApply(rows); // authoritative roster replaces local members
    } catch (err) {
      // Roll back the optimistic hide so the chip returns.
      setPendingRemovals((s) => {
        const next = new Set(s);
        next.delete(email.toLowerCase());
        return next;
      });
      if (err instanceof RolesApiError && err.status === 409 && err.kind === 'self-admin-removal') {
        setSelfRemove({ canonical: role.canonical, email });
      } else {
        // The Admin ≥1-direct-email invariant (and any other refusal) arrives
        // as a typed 422 whose message IS the explanation — render it inline
        // on the card, verbatim, never a generic failure.
        setError(errMessage(err, 'Failed to remove member'));
      }
    }
  };

  const confirmSelfRemove = async () => {
    if (!selfRemove) return;
    const ok = await run(() =>
      removeMember(selfRemove.canonical, selfRemove.email, true),
    );
    if (ok) setSelfRemove(null);
  };

  const submitAssignGroup = async () => {
    const group = groupName.trim();
    if (!group) {
      setError('Enter a group name.');
      return;
    }
    // Not optimistic: unlike a member email, a group name may simply not exist
    // and the server's 404/422 is the interesting outcome — a chip that appears
    // then vanishes would just look like a glitch.
    const ok = await run(() => assignGroup(role.canonical, group));
    if (ok) setGroupName('');
  };

  const handleRemoveGroup = async (group: string) => {
    await run(() => unassignGroup(role.canonical, group));
  };

  const confirmConvert = async () => {
    // On success the role leaves the roster (it lives in the groups file now);
    // on refusal `run` records the backend's message, shown on the card.
    await run(() => convertRoleToGroup(role.canonical));
    setConvertOpen(false);
  };

  // Group assignment follows the roster payload: the registry decides which
  // capability roles may be assigned to groups (Admin included — the backend's
  // parse-time invariant keeps at least one direct email member on Admin, so
  // a group can never be its only membership). Legacy people-set roles get
  // "Convert to group" instead of assignments.
  const groupAssignable = role.capability !== null && role.capability.groupAssignable;
  // ...but a role can already CARRY assignments it isn't allowed to receive
  // here (a hand-edited roles.yaml, or grants made before this gating). Those
  // must stay visible — with their remove controls — or there is no UI left to
  // unassign them, and convertRoleToGroup refuses until they're gone.
  const showGroupsSection = groupAssignable || role.groups.length > 0;

  return (
    <div className="border border-line rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-ink truncate">
              {role.displayName}
            </h2>
            {role.isAdmin && (
              <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-line rounded-sm px-1.5 py-0.5">
                Required
              </span>
            )}
          </div>
        </div>

        {role.capability === null && !role.isAdmin && (
          <button
            type="button"
            onClick={() => setConvertOpen(true)}
            disabled={busy}
            className="shrink-0 px-2 py-1 text-xs rounded-sm border border-line hover:bg-hover text-ink-muted disabled:opacity-50"
            title="Convert this people-set role into a group"
          >
            Convert to group
          </button>
        )}
      </div>

      {/* What the role DOES. Absent on legacy people-set roles — those get the
          Convert action instead. */}
      {role.capability && (
        <p className="mt-1 text-xs text-ink-muted">{role.capability.description}</p>
      )}

      {/* Member chips — optimistically hides members pending removal. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {visibleMembers.length === 0 ? (
          <span className="text-xs text-ink-faint">No members.</span>
        ) : (
          visibleMembers.map((email) => {
            const isLastAdminMember = role.isAdmin && visibleMembers.length === 1;
            return (
              <span
                key={email}
                className="inline-flex max-w-full items-center gap-1.5 pl-1 pr-1.5 py-1 bg-sunken border border-line rounded-full text-xs text-ink"
              >
                <span className="w-5 h-5 shrink-0 rounded-full bg-ink-muted text-white text-[9px] font-semibold flex items-center justify-center">
                  {initials(email)}
                </span>
                <span className="min-w-0 truncate max-w-[14rem]">{email}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveMember(email)}
                  disabled={busy || isLastAdminMember}
                  className="shrink-0 rounded-full p-0.5 text-ink-faint hover:text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:hover:text-ink-faint disabled:hover:bg-transparent"
                  title={
                    isLastAdminMember
                      ? 'Admin must keep at least one direct email member'
                      : 'Remove member'
                  }
                  aria-label={`Remove ${email}`}
                >
                  <X size={12} />
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* Add member — with people autocomplete (Manage Access suggest source). */}
      {/* The input is capped rather than fixed-width, and its wrapper may shrink,
          so the row fits the card on a narrow viewport instead of pushing the
          Add button past the card border. */}
      <div className="mt-3 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0 max-w-[16rem]">
          <input
            type="email"
            value={memberEmail}
            onChange={(e) => {
              setMemberEmail(e.target.value);
              setShowSuggest(true);
            }}
            onFocus={() => setShowSuggest(true)}
            // Delay so a click on a suggestion lands before the list unmounts.
            onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAddMember();
              if (e.key === 'Escape') setShowSuggest(false);
            }}
            placeholder="Add member by email"
            disabled={busy}
            className="text-xs px-2 py-1 border border-line rounded-sm focus:outline-none focus:border-accent w-full min-w-0"
            aria-label="Member email"
            autoComplete="off"
          />
          {showSuggest && suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full sm:w-72 max-w-full max-h-56 overflow-auto bg-white border border-line rounded-lg shadow-lg py-1">
              {suggestions.map((p) => (
                <li key={p.email}>
                  <button
                    type="button"
                    // onMouseDown (not onClick) so it fires before the input's blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      submitAddMember(p.email);
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-hover flex items-center gap-2"
                  >
                    <span className="w-5 h-5 rounded-full bg-ink-muted text-white text-[9px] font-semibold flex items-center justify-center shrink-0">
                      {initials(p.email)}
                    </span>
                    <span className="flex-1 truncate text-xs text-ink">{p.name || p.email}</span>
                    <span className="text-[10px] text-ink-faint truncate">{p.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={() => submitAddMember()}
          disabled={busy}
          className="shrink-0 px-3 py-1 text-xs rounded-sm border border-line hover:bg-hover disabled:opacity-50 flex items-center gap-1"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          Add
        </button>
      </div>

      {/* Group assignments — everyone in an assigned group holds the role.
          The section shows whenever there is something to see: assignments the
          role already carries (even a legacy/opted-out role — hiding them
          would leave no way to unassign, dead-ending Convert), or a
          group-assignable capability. The ADD control is stricter: only
          group-assignable capability roles may gain assignments here. */}
      {showGroupsSection && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="text-label uppercase text-ink-faint mb-1.5">
            Assigned groups
          </div>
          <div className="flex flex-wrap gap-2">
            {role.groups.length === 0 ? (
              <span className="text-xs text-ink-faint">No groups assigned.</span>
            ) : (
              role.groups.map((group) => (
                <span
                  key={group}
                  className="inline-flex max-w-full items-center gap-1.5 px-1.5 py-1 bg-sunken border border-line rounded-full text-xs text-ink"
                >
                  <UsersRound size={12} className="shrink-0 text-ink-muted" />
                  <span className="min-w-0 truncate max-w-[14rem]">{group}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveGroup(group)}
                    disabled={busy}
                    className="shrink-0 rounded-full p-0.5 text-ink-faint hover:text-danger hover:bg-danger-soft disabled:opacity-50"
                    title="Unassign group"
                    aria-label={`Remove group ${group}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))
            )}
          </div>
          {groupAssignable && (
            <div className="mt-2 flex items-center gap-1.5">
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAssignGroup();
                }}
                placeholder="Assign group by name"
                disabled={busy}
                className="text-xs px-2 py-1 border border-line rounded-sm focus:outline-none focus:border-accent flex-1 min-w-0 max-w-[16rem]"
                aria-label="Assign group"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={submitAssignGroup}
                disabled={busy}
                className="shrink-0 px-3 py-1 text-xs rounded-sm border border-line hover:bg-hover disabled:opacity-50"
              >
                Assign
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-danger bg-danger-soft border border-danger/30 rounded-sm px-3 py-2">
          {error}
        </div>
      )}

      {convertOpen && (
        <ConfirmDialog
          title={`Convert "${role.displayName}" to a group?`}
          confirmLabel="Convert"
          busy={busy}
          onCancel={() => setConvertOpen(false)}
          onConfirm={confirmConvert}
        >
          <p className="text-sm text-ink">
            Grants keep working — the name stays; it just becomes a group. Manage its
            members on the Groups & Members page afterwards.
          </p>
        </ConfirmDialog>
      )}

      {selfRemove && (
        <ConfirmDialog
          title="Remove your own admin access?"
          confirmLabel="Remove"
          danger
          busy={busy}
          onCancel={() => setSelfRemove(null)}
          onConfirm={confirmSelfRemove}
        >
          <p className="text-sm text-ink">
            You are removing your own last Admin membership. You may lose access
            to admin tools.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  confirmLabel,
  danger,
  busy,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Latest onCancel without re-running the mount effect on every parent render
  // (the parent passes a fresh closure each time, e.g. when `busy` flips).
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  // Real modal behaviour: hand focus to the dialog on open, restore it to the
  // trigger on close, close on Escape, and trap Tab/Shift+Tab inside the panel
  // so keyboard and screen-reader users can't reach the obscured page behind it.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    (focusable()[0] ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => {
        // Backdrop click (outside the panel) dismisses, like a native modal.
        if (e.target === e.currentTarget && !busy) onCancelRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-white rounded-lg shadow-lg w-full max-w-md p-5 outline-none"
      >
        <h3 id={titleId} className="text-sm font-semibold text-ink">{title}</h3>
        <div className="mt-3">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-sm border border-line hover:bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-3 py-1.5 text-xs rounded-sm text-white disabled:opacity-50 flex items-center gap-1 ${
              danger ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
