import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Surface } from '../../../shared/components';
import { pathForGroupsIndex } from '../routes/library-paths';
import { ownersTextOf, primaryFolderOf } from '../utils/group-summary';
import { AlreadyReadableError, requestGroupAccess, type GroupSummary } from '../services/groups.api';
import { firstNames, joinNames } from '../utils/names';
import { useLibraryToast } from '../state/toast.context';
import { LockGlyph } from './LockGlyph';

/**
 * A group you cannot read, as a place you can still stand in.
 *
 * Reaching this view means the caller could read the group's `access.md`
 * file (the `read: everyone` discovery grant in its frontmatter) but not the
 * folder — the same tier the backend used to include the summary at all. It
 * states four facts and offers one action: the group exists, who runs it,
 * how much is in it, and how to ask. Item names and descriptions stay
 * members-only; asking opens a plain change request that the group's
 * writers approve by merging.
 *
 * It is the SAME frame as the member view — breadcrumb, h1, run-by lede — so
 * the two never read as different products. Only the middle changes.
 *
 * `Manage access` is the escape hatch for a locked-out platform Admin. Admin
 * rescue applies to WRITING `access.md`, not to reading the folder, so an Admin
 * can genuinely be locked out of a group they are nevertheless the right person
 * to unlock. `canWrite` is exactly that verdict, which is why the button hangs
 * off it and not off any role check.
 */

export interface LockedGroupViewProps {
  group: GroupSummary;
  /** A request landed — refetch the index so `hasRequested` comes back true. */
  onRequested(): void;
  /** Access was already granted: reload everything and let the group open. */
  onUnlocked(): void;
  /** Open `ManageAccessDialog` on this repo-relative folder. */
  onManage(folder: string): void;
}

export function LockedGroupView({ group, onRequested, onUnlocked, onManage }: LockedGroupViewProps) {
  const toast = useLibraryToast();
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);

  const admins = adminNamesOf(group);
  // The prose name for the same people, from the SAME helper the member view
  // uses — a group has to describe itself identically on both sides of the lock.
  const adminsText = ownersTextOf(group);
  const primaryFolder = primaryFolderOf(group);
  const pending = group.hasRequested || requested;

  async function request() {
    setRequesting(true);
    try {
      await requestGroupAccess(group.name);
      setRequested(true);
      toast(
        `Asked ${admins.length > 0 ? joinNames(firstNames(admins)) : 'the admins'}. You get its skills and tools if they let you in.`,
      );
      onRequested();
    } catch (err) {
      // Access arrived between the page load and the click. Nothing went
      // wrong — the group is simply open now, so open it.
      if (err instanceof AlreadyReadableError) {
        // Released BEFORE handing off, because `onUnlocked` is not guaranteed
        // to swap this view out synchronously — if it kicks off an async
        // reload, this component renders again in the meantime and the button
        // would be stuck disabled with nothing left to re-enable it.
        setRequesting(false);
        onUnlocked();
        return;
      }
      toast("Couldn't send that — try again.", 'danger');
      setRequesting(false);
    }
  }

  return (
    <div className="pb-14">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-detail text-ink-faint">
        <Link to={pathForGroupsIndex()} className="rounded-xs hover:text-ink">
          All groups
        </Link>
        <span aria-hidden="true">›</span>
        <span aria-current="page" className="truncate text-ink-muted">
          {group.name}
        </span>
      </nav>

      <div className="mt-1.5 flex items-center gap-2.5">
        <h1 className="text-display font-semibold">{group.name}</h1>
        <Badge tone="outline" size="sm">
          <LockGlyph className="size-3 shrink-0" />
          Locked
        </Badge>
      </div>

      <p className="mt-1 text-lede text-ink-muted">{`Run by ${adminsText}.`}</p>

      {/* Volume, never contents. A number tells you whether it is worth asking
          to join; a name would tell you what is inside. */}
      <p className="mt-1 text-ui text-ink-muted">{countsLine(group)}</p>

      <div className="mt-5">
        {pending ? (
          <Surface tone="sunken" radius="lg" elevation="none" padded className="max-w-lg">
            <p className="text-body">
              {`Requested: ${adminsText} ${admins.length === 1 ? 'decides' : 'decide'} who joins.`}
            </p>
          </Surface>
        ) : (
          <Button variant="primary" disabled={requesting} onClick={() => void request()}>
            Subscribe to its skills and tools
          </Button>
        )}
      </div>

      {group.canWrite && primaryFolder && (
        <div className="mt-3">
          <Button variant="quiet" onClick={() => onManage(primaryFolder)}>
            Manage access
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * `{n} skills · {n} tools — visible to members only.`
 *
 * Singular is honoured here (unlike the index rows' fixed-width label) because
 * this is a sentence somebody reads, not a column that has to line up.
 */
function countsLine(group: Pick<GroupSummary, 'skillCount' | 'toolCount'>): string {
  const skills = `${group.skillCount} ${group.skillCount === 1 ? 'skill' : 'skills'}`;
  const tools = `${group.toolCount} ${group.toolCount === 1 ? 'tool' : 'tools'}`;
  return `${skills} · ${tools}. Visible to members only.`;
}

/**
 * The people `ownersTextOf` names, as a list.
 *
 * Mirrors that helper's chain exactly — owners, else writers, else nobody — so
 * the sentence and the count of subjects in it can never disagree. It is a
 * separate function only because the toast needs the NAMES (to take first
 * names) and the verb needs the COUNT, and prose gives back neither.
 */
function adminNamesOf(group: Pick<GroupSummary, 'owners' | 'writers'>): string[] {
  const owners = [...group.owners.users.map((u) => u.name), ...group.owners.roles];
  const named = owners.filter((s) => s.length > 0);
  if (named.length > 0) return named;
  return [...group.writers.users.map((u) => u.name), ...group.writers.roles].filter(
    (s) => s.length > 0,
  );
}

