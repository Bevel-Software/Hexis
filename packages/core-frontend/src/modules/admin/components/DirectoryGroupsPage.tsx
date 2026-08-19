import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { PageShell } from '../../../shared/components/PageShell';
import { Dialog } from '../../../shared/components/Dialog';
import { useAdmin } from '../state/admin.context';
import { useAppRegistry } from '../../../core/registry';
import { useExclusiveRunner, type ExclusiveRunner } from '../hooks/useExclusiveRunner';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupsRoster,
  GroupsApiError,
  removeGroupMember,
  type GroupRosterEntry,
  type GroupsRoster,
} from '../services/groups.api';
import { EMAIL_RE, isGroupPrefixed } from '../../../lib/email';

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * The Groups page (still routed at `/directory-groups` — the component and
 * route name stayed to avoid churn). Groups are people-sets for access
 * management, with ONE source per deployment:
 *
 *   - MANUAL mode: groups are created and edited right here.
 *   - IDP mode: an identity provider owns the groups — the roster renders
 *     read-only (membership is managed in the IdP).
 *
 * HOW an identity provider gets connected is not core's business: an overlay
 * contributes that UI through the registry's `groupsDirectoryPanel` slot,
 * rendered below the list in both modes. A core-only deployment simply never
 * mentions a directory connection.
 */
export function DirectoryGroupsPage() {
  const { isAdmin } = useAdmin();
  const { groupsDirectoryPanel: DirectoryPanel } = useAppRegistry();
  const [roster, setRoster] = useState<GroupsRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The broken-MANUAL-groups.yaml state: the roster answers 422
  // (`kind: 'broken-groups'`) with the parse message instead of a group list.
  // Held separately from `error` so the page can render the same loud
  // repair banner the in-roster `groupsHealth` marker gets — a broken groups
  // file means groups are NOT applying, which is worse than a failed fetch.
  const [brokenGroups, setBrokenGroups] = useState<{ file?: string; reason: string } | null>(null);
  const [working, setWorking] = useState(false);
  // Group pending delete confirmation (manual mode).
  const [deleteTarget, setDeleteTarget] = useState<GroupRosterEntry | null>(null);
  // The overlay panel's "a directory connection exists" signal — true between
  // connecting and the first push, when the roster still reads 'manual' but
  // manual edits would go dormant. See GroupsDirectoryPanelProps.
  const [directoryConnected, setDirectoryConnected] = useState(false);
  // All roster mutations queue through here — see useExclusiveRunner.
  const runExclusive = useExclusiveRunner();

  // Refreshes queue through the SAME exclusive runner as the mutations, so a
  // refresh and a mutation can never interleave OR apply out of order:
  // whichever queued first runs — and settles, and applies its roster — first.
  // (That total order is also why there is no request-id stale-response guard
  // here: the queue's tail only starts the next task after the previous one's
  // handlers ran, so a superseded response can never land after a newer one.)
  const refresh = useCallback(() => {
    runExclusive(getGroupsRoster)
      .then((r) => {
        setRoster(r);
        setError(null);
        setBrokenGroups(null);
      })
      .catch((err) => {
        if (err instanceof GroupsApiError && err.kind === 'broken-groups') {
          // Manual groups.yaml is unreadable: surface the repair banner with
          // the parse message. Not a generic error — groups are not applying.
          setBrokenGroups({ file: err.file, reason: err.reason ?? err.message });
          setError(null);
          // A roster rendered from an EARLIER healthy load no longer describes
          // the file: clear the stale rows (and any pending delete confirm) so
          // no CRUD control can operate on a file that can't be parsed. The
          // banner above is the whole page until the file is repaired.
          setRoster(null);
          setDeleteTarget(null);
          return;
        }
        setError(errMessage(err, "Couldn't load groups."));
        // Keep whatever was already on screen — a failed reload is a banner,
        // not an empty page.
      });
  }, [runExclusive]);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  // Any mutation on the groups roster returns the authoritative roster — set
  // it directly rather than refetching. No requestId bump needed: mutations
  // share the exclusive queue with refresh(), so their responses already apply
  // in a strict total order.
  const applyRoster = useCallback((r: GroupsRoster) => {
    setRoster(r);
    // A stale banner from an earlier failed reload no longer describes what's
    // on screen.
    setError(null);
    setBrokenGroups(null);
  }, []);

  async function handleDeleteGroup() {
    if (!deleteTarget || working) return;
    setWorking(true);
    setError(null);
    try {
      const target = deleteTarget;
      applyRoster(await runExclusive(() => deleteGroup(target.canonical)));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteTarget(null);
      setError(errMessage(err, "Couldn't delete the group."));
    } finally {
      setWorking(false);
    }
  }

  if (!isAdmin) {
    return (
      <PageShell title="Groups">
        <div className="text-sm text-ink-muted">Admins only.</div>
      </PageShell>
    );
  }

  const idpMode = roster?.mode === 'idp';

  // The broken-source banner has TWO triggers describing the same fact — the
  // groups file cannot be read, so groups are NOT being applied:
  //   - a 200 roster whose `groupsHealth` marker is not ok (broken IdP-synced
  //     file: mode stays 'idp', roster is empty, resolution degrades), and
  //   - the roster 422 `broken-groups` (broken MANUAL file: no roster at all).
  const health = roster?.groupsHealth;
  const broken =
    brokenGroups ?? (health && !health.ok ? { file: health.file, reason: health.reason } : null);

  return (
    <>
      <PageShell title="Groups">
        <div className="space-y-4">
          {broken && (
            <div
              className="text-xs text-danger bg-danger-soft border border-danger/30 rounded-sm px-2 py-1.5 space-y-0.5"
              role="alert"
            >
              <div className="font-semibold">
                The groups file{broken.file ? ` (${broken.file})` : ''} is broken — groups are
                not being applied.
              </div>
              <div>
                No one gets access through groups until the file is repaired.
                {broken.reason ? <> Reason: {broken.reason}</> : null}
              </div>
            </div>
          )}

          {error && (
            <div
              className="text-xs text-danger bg-danger-soft border border-danger/30 rounded-sm px-2 py-1.5"
              role="alert"
            >
              {error}
            </div>
          )}

          {roster === null ? (
            error || broken ? null : <div className="text-xs text-ink-muted">Loading…</div>
          ) : idpMode ? (
            <IdpModeView roster={roster} />
          ) : directoryConnected ? (
            // Connected, but the first provisioning push hasn't landed: the
            // IdP already owns groups, so no manual CRUD — creating one now
            // would go dormant the moment the first push materializes.
            <p className="text-xs text-ink-muted leading-snug">
              An identity provider is connected. Groups appear here after its
              first provisioning push — membership is managed there from now on.
            </p>
          ) : (
            <ManualModeView
              roster={roster}
              onApply={applyRoster}
              onDeleteRequest={setDeleteTarget}
              runExclusive={runExclusive}
            />
          )}

          {roster !== null && DirectoryPanel && (
            <DirectoryPanel
              mode={roster.mode}
              onDirectoryChanged={refresh}
              onConnectedChange={setDirectoryConnected}
            />
          )}
        </div>
      </PageShell>

      {/* Delete-group confirm (manual mode), warning on grants that reference it. */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete "${deleteTarget.displayName}"?` : 'Delete group'}
        size="sm"
        busy={working}
        footer={
          <>
            <button
              onClick={() => setDeleteTarget(null)}
              disabled={working}
              className="px-3 py-1.5 text-sm rounded-sm text-ink hover:bg-hover border border-line disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleDeleteGroup}
              disabled={working}
              className="px-3 py-1.5 text-sm rounded-sm bg-danger hover:bg-danger/90 text-white disabled:opacity-50"
            >
              {working ? 'Working…' : 'Delete group'}
            </button>
          </>
        }
      >
        {deleteTarget && (
          <div className="space-y-2">
            {deleteTarget.referencedBy.length > 0 ? (
              <>
                <p className="text-xs text-ink leading-snug">
                  {deleteTarget.referencedBy.length} access rule
                  {deleteTarget.referencedBy.length === 1 ? '' : 's'} reference
                  {deleteTarget.referencedBy.length === 1 ? 's' : ''} this group and will stop
                  matching anyone after deletion:
                </p>
                <ul className="max-h-40 overflow-auto text-xs text-ink-muted space-y-0.5">
                  {deleteTarget.referencedBy.map((ref, i) => (
                    <li key={`${ref.path}:${ref.verb}:${i}`} className="truncate">
                      {ref.verb} · {ref.path}
                    </li>
                  ))}
                </ul>
              </>
            ) : (deleteTarget.assignedToRoles?.length ?? 0) === 0 ? (
              <p className="text-xs text-ink leading-snug">
                Nothing is shared with this group. Its members lose nothing else.
              </p>
            ) : null}
            {/* Role assignments are unassigned atomically with the delete —
                each named role loses the members it inherits through this
                group, which the admin must hear BEFORE confirming. */}
            {(deleteTarget.assignedToRoles?.length ?? 0) > 0 && (
              <p className="text-xs text-ink leading-snug">
                Deleting also unassigns this group from the{' '}
                {deleteTarget.assignedToRoles!.length === 1 ? 'role' : 'roles'}{' '}
                <span className="font-semibold">{deleteTarget.assignedToRoles!.join(', ')}</span>
                {' '}— this group's members no longer hold{' '}
                {deleteTarget.assignedToRoles!.length === 1 ? 'that role' : 'those roles'} through it.
              </p>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

/** Manual mode: in-app group CRUD. */
function ManualModeView({
  roster,
  onApply,
  onDeleteRequest,
  runExclusive,
}: {
  roster: GroupsRoster;
  onApply: (roster: GroupsRoster) => void;
  onDeleteRequest: (group: GroupRosterEntry) => void;
  runExclusive: ExclusiveRunner;
}) {
  return (
    <>
      <p className="text-xs text-ink-muted leading-snug">
        Groups are sets of people you can share with and assign roles to.
      </p>

      <CreateGroupForm onApply={onApply} runExclusive={runExclusive} />

      {roster.groups.length === 0 ? (
        <div className="text-xs text-ink-muted">No groups yet.</div>
      ) : (
        <div className="flex flex-col gap-3 max-w-xl">
          {roster.groups.map((group) => (
            <ManualGroupCard
              key={group.canonical}
              group={group}
              onApply={onApply}
              onDeleteRequest={onDeleteRequest}
              runExclusive={runExclusive}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CreateGroupForm({
  onApply,
  runExclusive,
}: {
  onApply: (roster: GroupsRoster) => void;
  runExclusive: ExclusiveRunner;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a group name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onApply(await runExclusive(() => createGroup(trimmed)));
      setName('');
    } catch (err) {
      setError(errMessage(err, 'Failed to create group'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1 max-w-xl">
      <div className="flex items-center gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="New group name"
          disabled={busy}
          className="text-xs px-2 py-1 border border-line rounded-sm focus:outline-none focus:border-accent w-56 max-w-full min-w-0"
          aria-label="New group name"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="px-2 py-1 text-xs rounded-sm bg-accent hover:bg-accent-hover text-white disabled:opacity-50 flex items-center gap-1"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Create group
        </button>
      </div>
      {error && (
        <div className="text-xs text-danger bg-danger-soft border border-danger/30 rounded-sm px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

function ManualGroupCard({
  group,
  onApply,
  onDeleteRequest,
  runExclusive,
}: {
  group: GroupRosterEntry;
  onApply: (roster: GroupsRoster) => void;
  onDeleteRequest: (group: GroupRosterEntry) => void;
  runExclusive: ExclusiveRunner;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitAdd = async () => {
    const trimmed = email.trim();
    // Mirror the backend's refusal of `group:`-prefixed member values with an
    // inline hint — group members are emails; groups don't contain groups.
    if (isGroupPrefixed(trimmed)) {
      setError("Group members are emails — 'group:' references aren't allowed here.");
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onApply(await runExclusive(() => addGroupMember(group.canonical, trimmed)));
      setEmail('');
    } catch (err) {
      setError(errMessage(err, 'Failed to add member'));
    } finally {
      setBusy(false);
    }
  };

  const submitRemove = async (member: string) => {
    setBusy(true);
    setError(null);
    try {
      onApply(await runExclusive(() => removeGroupMember(group.canonical, member)));
    } catch (err) {
      setError(errMessage(err, 'Failed to remove member'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-line rounded-lg p-3">
      <div className="flex items-start gap-3">
        <h2 className="flex-1 min-w-0 text-sm font-semibold text-ink truncate">
          {group.displayName}
        </h2>
        <button
          type="button"
          onClick={() => onDeleteRequest(group)}
          disabled={busy}
          className="p-1.5 rounded-sm hover:bg-danger-soft text-danger disabled:opacity-50 shrink-0"
          title="Delete group"
          aria-label={`Delete ${group.displayName}`}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {group.members.length === 0 ? (
          <span className="text-xs text-ink-faint">No members.</span>
        ) : (
          group.members.map((member) => (
            <span
              key={member}
              className="inline-flex max-w-full items-center gap-1.5 px-1.5 py-1 bg-sunken border border-line rounded-full text-xs text-ink"
            >
              <span className="min-w-0 truncate max-w-[14rem]">{member}</span>
              <button
                type="button"
                onClick={() => submitRemove(member)}
                disabled={busy}
                className="shrink-0 rounded-full p-0.5 text-ink-faint hover:text-danger hover:bg-danger-soft disabled:opacity-50"
                title="Remove member"
                aria-label={`Remove ${member}`}
              >
                <X size={12} />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAdd();
          }}
          placeholder="Add member by email"
          disabled={busy}
          className="text-xs px-2 py-1 border border-line rounded-sm focus:outline-none focus:border-accent flex-1 min-w-0 max-w-[16rem]"
          aria-label={`Add member to ${group.displayName}`}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={submitAdd}
          disabled={busy}
          className="shrink-0 px-3 py-1 text-xs rounded-sm border border-line hover:bg-hover disabled:opacity-50 flex items-center gap-1"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          Add
        </button>
      </div>

      {error && (
        <div className="mt-2 text-xs text-danger bg-danger-soft border border-danger/30 rounded-sm px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

/** IdP mode: the synced roster, read-only — membership is managed in the IdP. */
function IdpModeView({ roster }: { roster: GroupsRoster }) {
  return (
    <>
      <p className="text-xs text-ink-muted leading-snug">
        Groups are synced from your identity provider and are read-only here —
        membership is managed there.
      </p>

      {roster.groups.length === 0 ? (
        <div className="text-xs text-ink-muted">No groups synced yet.</div>
      ) : (
        <div className="max-w-xl space-y-1">
          <ul className="divide-y divide-line border border-line rounded-sm">
            {roster.groups.map((group) => (
              <li key={group.canonical} className="px-3 py-2 text-sm">
                <div className="font-medium truncate">{group.displayName}</div>
                <div className="text-meta text-ink-muted truncate">
                  {group.members.length} {group.members.length === 1 ? 'member' : 'members'}
                </div>
              </li>
            ))}
          </ul>
          <div className="text-meta text-ink-muted">
            Membership is managed in your identity provider.
          </div>
        </div>
      )}
    </>
  );
}
