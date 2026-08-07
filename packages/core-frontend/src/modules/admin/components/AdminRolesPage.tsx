import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { PageShell } from '../../../shared/components/PageShell';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { useAdmin } from '../state/admin.context';
import {
  addMember,
  createRole,
  deleteRole,
  fetchRoles,
  removeMember,
  renameRole,
  RolesApiError,
  type RoleRosterEntry,
} from '../services/roles.api';
import { suggestPrincipals } from '../../access/api';

/** The default-branch workspace id — roles are managed there (admin status derives from it). */
// A function, not a constant: the branch model arrives from `/api/config`
// during boot, and a module-scope capture would freeze this at the empty
// string that exists before it.
const rolesWorkspaceId = () => encodeURIComponent(DEFAULT_BRANCH);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirror of the backend's canonicalRoleName (access-control.service.ts) so an
// optimistic create can compute the same canonical the server will assign,
// keeping the placeholder card's identity stable until the roster reconciles.
function canonicalRoleName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Advisory client-side validation for a new role name. Mirrors the backend
// invariants so the user gets instant feedback; the server still has final say.
function validateNewRoleName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a role name.';
  const lower = trimmed.toLowerCase();
  if (lower === 'deny' || lower === 'everyone') {
    return `"${trimmed}" is a reserved name.`;
  }
  if (/[:#<>]/.test(trimmed)) return 'A role name can’t contain : # < >.';
  if (trimmed.startsWith('-')) return 'A role name can’t start with "-".';
  return null;
}

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

interface DeleteTarget {
  role: RoleRosterEntry;
}

interface SelfRemoveTarget {
  canonical: string;
  email: string;
}

/**
 * Roles & Members, routed standalone at `/roles-and-members` (below the
 * persistent toolbar). Admin-gated: non-admins get a clear "Admins only"
 * state instead of the roster (the backend enforces the same gate on every
 * roles endpoint — this is presentation, not the security boundary).
 */
export function AdminRolesPage() {
  const { isAdmin } = useAdmin();
  const [roster, setRoster] = useState<RoleRosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Optimistic list reshaping. A pending create appends a placeholder card; a
  // pending delete hides the card by canonical. Both reconcile against the
  // authoritative roster each mutation returns (or roll back on error).
  const [pendingCreates, setPendingCreates] = useState<RoleRosterEntry[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  // Delete errors, keyed by canonical. Owned here (not on the card) because a
  // delete optimistically unmounts the card before the commit settles; on
  // failure the card is restored as a NEW instance, so a card-local setError
  // would land on the unmounted one and vanish. Parent-owned, it survives the
  // hide→restore cycle and reaches the restored card by canonical.
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  // Bump on every load so a stale in-flight response never overwrites the
  // current roster.
  const requestId = useRef(0);

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

  // Each mutation returns the fresh roster — set it directly (refetch-only) and
  // reconcile the optimistic sets in the same update, while the authoritative
  // rows are in hand: drop a pending create once its real card appears, and a
  // pending delete once the card is actually gone. Doing this here (rather than
  // in a roster-watching effect) avoids effect-driven cascading setState — and
  // a placeholder double-listing, or a no-op/failed delete hiding a card.
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
    const present = new Set(rows.map((r) => r.canonical));
    setPendingCreates((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((c) => !present.has(c.canonical));
      return next.length === prev.length ? prev : next;
    });
    setPendingDeletes((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((c) => present.has(c)));
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // Optimistic create: show a placeholder card immediately, fire the commit in
  // the background, reconcile (or roll back the placeholder on error).
  const createOptimistic = useCallback(
    async (displayName: string): Promise<string | null> => {
      const canonical = canonicalRoleName(displayName);
      // No client-side duplicate guard: a reserved/duplicate name is left to the
      // server, which rolls the placeholder back and surfaces its precise error.
      const placeholder: RoleRosterEntry = {
        canonical,
        displayName: displayName.trim(),
        members: [],
        isAdmin: false,
        referencedBy: [],
      };
      setPendingCreates((prev) => [...prev, placeholder]);
      try {
        const rows = await createRole(displayName.trim());
        applyRoster(rows);
        return null;
      } catch (err) {
        setPendingCreates((prev) => prev.filter((c) => c.canonical !== canonical));
        return errMessage(err, 'Failed to create role');
      }
    },
    [applyRoster],
  );

  // Optimistic delete: hide the card immediately, fire the commit, reconcile
  // (or roll back the hide on error).
  const deleteOptimistic = useCallback(
    async (canonical: string): Promise<void> => {
      setPendingDeletes((prev) => new Set(prev).add(canonical));
      // Clear any stale error from a previous failed attempt on this role.
      setDeleteErrors((prev) => {
        if (!(canonical in prev)) return prev;
        const rest = { ...prev };
        delete rest[canonical];
        return rest;
      });
      try {
        const rows = await deleteRole(canonical);
        applyRoster(rows);
      } catch (err) {
        // Roll back the optimistic hide and record the error against the
        // restored card by canonical (it may be a fresh instance by now).
        setPendingDeletes((prev) => {
          const next = new Set(prev);
          next.delete(canonical);
          return next;
        });
        setDeleteErrors((prev) => ({ ...prev, [canonical]: errMessage(err, 'Failed to delete role') }));
      }
    },
    [applyRoster],
  );

  // The list the user sees = authoritative roster minus optimistically-deleted,
  // plus optimistically-created placeholders not yet reflected by the server.
  const rosterCanonicals = new Set(roster.map((r) => r.canonical));
  const visibleRoster = [
    ...roster.filter((r) => !pendingDeletes.has(r.canonical)),
    ...pendingCreates.filter((c) => !rosterCanonicals.has(c.canonical)),
  ];

  if (!isAdmin) {
    return (
      <PageShell title="Roles & Members">
        <div className="text-sm text-ink-muted">
          Admins only. Ask an admin if you need a role or membership changed.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Roles & Members"
     
      actions={<NewRoleControl onCreate={createOptimistic} />}
    >
      {loading && roster.length === 0 ? (
        <div className="flex items-center gap-2 p-2 text-sm text-ink-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
          {error}
        </div>
      ) : visibleRoster.length === 0 ? (
        <div className="p-2 text-sm text-ink-muted">No roles yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleRoster.map((role) => (
            <RoleCard
              key={role.canonical}
              role={role}
              onApply={applyRoster}
              onDelete={deleteOptimistic}
              deleteError={deleteErrors[role.canonical] ?? null}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function NewRoleControl({
  onCreate,
}: {
  onCreate: (displayName: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOpen(false);
    setName('');
    setError(null);
  };

  const submit = async () => {
    const clientError = validateNewRoleName(name);
    if (clientError) {
      setError(clientError);
      return;
    }
    // Optimistic: the placeholder card appears immediately, so close the form
    // right away. The commit runs in the background; a server rejection surfaces
    // as an inline error (re-opening the form with the typed name preserved).
    const typed = name.trim();
    reset();
    const err = await onCreate(typed);
    if (err) {
      setOpen(true);
      setName(typed);
      setError(err);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs rounded border border-line hover:bg-hover flex items-center gap-1.5"
      >
        <Plus size={12} /> New role
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') reset();
          }}
          placeholder="Role name"
          className="text-xs px-2 py-1 border border-line rounded focus:outline-none focus:border-accent w-48 max-w-full min-w-0"
          aria-label="New role name"
        />
        <button
          type="button"
          onClick={submit}
          className="px-2 py-1 text-xs rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50 flex items-center gap-1"
        >
          Add
        </button>
        <button
          type="button"
          onClick={reset}
          className="p-1 rounded hover:bg-hover text-ink-muted"
          aria-label="Cancel"
        >
          <X size={14} />
        </button>
      </div>
      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

function RoleCard({
  role,
  onApply,
  onDelete,
  deleteError,
}: {
  role: RoleRosterEntry;
  onApply: (rows: RoleRosterEntry[]) => void;
  onDelete: (canonical: string) => Promise<void>;
  // Delete error for this role, owned by the parent so it survives the
  // optimistic hide→restore cycle (the card may remount in between).
  deleteError: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Rename inline-edit state.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(role.displayName);
  // A rename commit is in flight. Other row mutations capture `role.canonical`,
  // which changes once an identity-changing rename reconciles, so we block them
  // until the rename settles to avoid requests against the stale canonical.
  const [renamePending, setRenamePending] = useState(false);

  // Add-member input + people autocomplete (same suggest source as Manage
  // Access, scoped to people/emails — a role's members are emails, not groups).
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
  // Optimistic rename: the new display name shown immediately while the rename
  // commit is in flight. Cleared once the authoritative roster reflects it (or
  // rolled back on error).
  const [optimisticName, setOptimisticName] = useState<string | null>(null);

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
          setSuggestions(res.people.filter((p) => !existing.has(p.email.toLowerCase())));
        })
        .catch(() => {
          if (myReq === suggestReq.current) setSuggestions([]);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [memberEmail, role.members, pendingAdds]);

  // Dialogs.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [selfRemove, setSelfRemove] = useState<SelfRemoveTarget | null>(null);

  // Name shown in the UI = optimistic rename target while a rename is in flight,
  // else the authoritative display name.
  const displayName = optimisticName ?? role.displayName;
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

  // Clear the optimistic rename once the authoritative roster reflects it.
  useEffect(() => {
    if (optimisticName !== null && role.displayName === optimisticName) {
      setOptimisticName(null);
    }
  }, [role.displayName, optimisticName]);

  const run = useCallback(
    async (fn: () => Promise<RoleRosterEntry[]>) => {
      setBusy(true);
      setError(null);
      try {
        const rows = await fn();
        onApply(rows);
        return true;
      } catch (err) {
        setError(errMessage(err, 'Operation failed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onApply],
  );

  const submitRename = async () => {
    const next = renameValue.trim();
    if (next === role.displayName) {
      setRenaming(false);
      return;
    }
    // Optimistic: show the new name and close the editor immediately. The rename
    // commit runs in the background; the authoritative roster reconciles it (or
    // we roll back on error). Not gated on `busy` — same posture as removal.
    setError(null);
    setOptimisticName(next);
    setRenaming(false);
    setRenamePending(true);
    try {
      const rows = await renameRole(role.canonical, next);
      onApply(rows);
    } catch (err) {
      setOptimisticName(null); // roll back the optimistic label
      setError(errMessage(err, 'Failed to rename role'));
    } finally {
      setRenamePending(false);
    }
  };

  const submitAddMember = async (override?: string) => {
    // A rename is reconciling — `role.canonical` is about to change, so don't
    // fire mutations against the stale one.
    if (renamePending) return;
    const email = (override ?? memberEmail).trim();
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
      const rows = await addMember(role.canonical, email);
      onApply(rows);
    } catch (err) {
      // Roll back the optimistic chip so it disappears.
      setPendingAdds((prev) => prev.filter((e) => e.toLowerCase() !== lower));
      setError(errMessage(err, 'Failed to add member'));
    }
  };

  const handleRemoveMember = async (email: string) => {
    if (renamePending) return;
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
      const rows = await removeMember(role.canonical, email);
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

  const confirmDelete = async () => {
    if (renamePending) return;
    // Optimistic: close the dialog and let the card vanish immediately. The
    // commit runs in the background; on failure the parent rolls back the hide
    // and records the error (keyed by canonical), which arrives via deleteError
    // — so it survives even if this card instance was unmounted in between.
    setDeleteTarget(null);
    await onDelete(role.canonical);
  };

  return (
    <div className="border border-line rounded-lg p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename();
                  if (e.key === 'Escape') {
                    setRenameValue(role.displayName);
                    setRenaming(false);
                  }
                }}
                disabled={busy}
                className="text-base font-semibold px-2 py-1 border border-line rounded focus:outline-none focus:border-accent min-w-0"
                aria-label="Role name"
              />
              <button
                type="button"
                onClick={submitRename}
                disabled={busy}
                className="p-1 rounded hover:bg-hover text-ink-muted disabled:opacity-50 shrink-0"
                aria-label="Save name"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenameValue(role.displayName);
                  setRenaming(false);
                }}
                disabled={busy}
                className="p-1 rounded hover:bg-hover text-ink-muted shrink-0"
                aria-label="Cancel rename"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-ink truncate">
                {displayName}
              </h2>
              {role.isAdmin && (
                <span className="text-[10px] uppercase tracking-wide text-ink-muted border border-line rounded px-1.5 py-0.5">
                  Required
                </span>
              )}
            </div>
          )}
        </div>

        {!renaming && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                setRenameValue(role.displayName);
                setRenaming(true);
              }}
              disabled={busy || renamePending}
              className="p-1.5 rounded hover:bg-hover text-ink-muted disabled:opacity-50"
              title="Rename"
              aria-label="Rename role"
            >
              <Pencil size={14} />
            </button>
            {!role.isAdmin && (
              <button
                type="button"
                onClick={() => setDeleteTarget({ role })}
                disabled={busy || renamePending}
                className="p-1.5 rounded hover:bg-red-50 text-red-600 disabled:opacity-50"
                title="Delete role"
                aria-label="Delete role"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>

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
                  disabled={busy || renamePending || isLastAdminMember}
                  className="shrink-0 rounded-full p-0.5 text-ink-faint hover:text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:hover:text-ink-faint disabled:hover:bg-transparent"
                  title={
                    isLastAdminMember
                      ? 'Admin must keep at least one member'
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
            disabled={busy || renamePending}
            className="text-xs px-2 py-1 border border-line rounded focus:outline-none focus:border-accent w-full min-w-0"
            aria-label="Member email"
            autoComplete="off"
          />
          {showSuggest && suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full sm:w-72 max-h-56 overflow-auto bg-white border border-line rounded shadow-lg py-1">
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
          disabled={busy || renamePending}
          className="shrink-0 px-3 py-1 text-xs rounded border border-line hover:bg-hover disabled:opacity-50 flex items-center gap-1"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          Add
        </button>
      </div>

      {(error ?? deleteError) && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error ?? deleteError}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.role.displayName}"?`}
          confirmLabel="Delete role"
          danger
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        >
          {deleteTarget.role.referencedBy.length > 0 ? (
            <>
              <p className="text-sm text-ink">
                {deleteTarget.role.referencedBy.length} access rule
                {deleteTarget.role.referencedBy.length === 1 ? '' : 's'} will be
                ignored after deletion:
              </p>
              <ul className="mt-2 max-h-40 overflow-auto text-xs text-ink-muted space-y-0.5">
                {deleteTarget.role.referencedBy.map((ref, i) => (
                  <li key={`${ref.path}:${ref.verb}:${i}`} className="truncate">
                    {ref.verb} · {ref.path}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-ink">This role has no access rules.</p>
          )}
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
            className="px-3 py-1.5 text-xs rounded border border-line hover:bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-3 py-1.5 text-xs rounded text-white disabled:opacity-50 flex items-center gap-1 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-hover'
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
