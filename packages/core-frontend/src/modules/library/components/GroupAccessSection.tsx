import { useMemo, useState } from 'react';
import { Badge, Banner, Button, ListRow, Surface } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import type {
  AccessEligible,
  AccessOverride,
  AccessOverrideEntry,
  AccessOverridePrincipal,
} from '../../access/api';
import { DEFAULT_WORKSPACE_ID } from '../services/library.api';
import { useGroupFolderAccess } from '../hooks/useGroupAccess';
import { groupFoldersFor, type GroupFolder } from '../utils/group-folders';

/**
 * A group's access, said out loud.
 *
 * A group is a folder, and a folder's `access.md` is the thing that decides who
 * can use everything in it — but until now that file was only visible to
 * someone who went looking for it in the file explorer. This section puts it on
 * the group's own page: who can use it, who can change it, who owns it, and the
 * one escalation that edits any of that.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It never invents a resolver. Every rule shown is read back through the
 *    same endpoints the resolver answers from, and every edit goes through the
 *    existing grant/revoke mutation — which fail-closes on `assertCanMutate`,
 *    takes the edit lock, splices `<folder>/access.md`, and commits directly on
 *    the workspace branch. There is no change-request path for access in this
 *    repo, so a non-writer simply never sees the editor.
 *  - It never offers to edit an ITEM's rules. Item-specific rules are listed
 *    because a folder's share list is a half-truth without them, but managing
 *    one belongs on that item's own page.
 */
export interface GroupAccessSectionProps {
  group: string;
  /** Repo-relative paths of the group's items — the folders are derived from these. */
  itemPaths: string[];
}

/** The label a legacy card wears, e.g. `Skills folder — Skills/GTM`. */
function folderLabelOf(folder: GroupFolder): string {
  return `${folder.root} folder — ${folder.folder}`;
}

export function GroupAccessSection({ group, itemPaths }: GroupAccessSectionProps) {
  const folders = useMemo(() => groupFoldersFor(group, itemPaths), [group, itemPaths]);

  // Nothing to describe: a pseudo-row, an ungrouped item, or a group whose
  // items we cannot see. Silence beats an empty "Access" heading that implies
  // the group has no rules.
  if (folders.length === 0) return null;

  const legacySplit = folders.length > 1;

  return (
    <section aria-label={`Access for ${group}`} className="mt-7">
      <h2 className="mb-2.5 text-label uppercase text-ink-faint">Access</h2>

      {legacySplit && (
        <Banner role="note" tone="neutral" className="mb-2.5">
          This group still lives in the legacy Skills/ and Tools/ folders, so its skills and its
          tools have separate access rules. Manage each folder below; they become one when the
          group is migrated to Groups/.
        </Banner>
      )}

      <div className="flex flex-col gap-2.5">
        {folders.map((folder) => (
          <GroupAccessCard
            key={folder.folder}
            group={group}
            folder={folder}
            showFolderLabel={legacySplit}
          />
        ))}
      </div>
    </section>
  );
}

function GroupAccessCard({
  group,
  folder,
  showFolderLabel,
}: {
  group: string;
  folder: GroupFolder;
  showFolderLabel: boolean;
}) {
  const { kbDirName } = useWorkspace();
  const { access, overrides, truncated, loading, error, reload } = useGroupFolderAccess(
    folder.folder,
  );
  const [manageOpen, setManageOpen] = useState(false);

  const label = showFolderLabel ? (
    <p className="mb-2 text-meta text-ink-muted">{folderLabelOf(folder)}</p>
  ) : null;

  if (loading) {
    return (
      <Surface tone="surface" radius="xl" elevation="card" padded>
        {label}
        <p className="text-detail text-ink-muted">Checking access…</p>
      </Surface>
    );
  }

  if (error || !access) {
    return (
      <Surface tone="surface" radius="xl" elevation="card" padded>
        {label}
        <Banner role="alert" tone="danger">
          <span>{"Couldn't load access for this group."}</span>{' '}
          <Button variant="quiet" size="sm" onClick={reload}>
            Try again
          </Button>
        </Banner>
      </Surface>
    );
  }

  const { readers, eligible, owners, canWrite } = access;
  const readersNamed = readers.roles.length > 0 || readers.users.length > 0;
  const writersNamed = eligible.roles.length > 0 || eligible.users.length > 0;
  const ownersNamed = owners.roles.length > 0 || owners.users.length > 0;

  return (
    <Surface tone="surface" radius="xl" elevation="card" padded>
      {label}

      <div className="flex items-start justify-between gap-3">
        <h3 className="text-strong">Who can use this group</h3>
        {/* The gate is the resolved folder verdict, never a client-side admin
            guess — it is the same answer the backend enforces at write time. */}
        {canWrite && (
          <Button
            variant="outline"
            size="sm"
            disabled={!kbDirName}
            title={kbDirName ? undefined : 'Workspace still loading'}
            onClick={() => setManageOpen(true)}
          >
            Manage access
          </Button>
        )}
      </div>

      <div className="mt-1.5">
        {!readers.restricted ? (
          <p className="text-body text-ink">Everyone at the company can use this group.</p>
        ) : readersNamed ? (
          <PrincipalChips roles={readers.roles} users={readers.users} />
        ) : (
          <p className="text-body text-ink-muted">
            Nobody has been given access yet — Admins can always see it.
          </p>
        )}
      </div>

      <div className="mt-3.5">
        <h4 className="text-label uppercase text-ink-faint">Can edit</h4>
        <div className="mt-1">
          {writersNamed ? (
            <PrincipalChips roles={eligible.roles} users={eligible.users} />
          ) : (
            <p className="text-body text-ink-muted">Only Admins can change this group.</p>
          )}
        </div>
      </div>

      {/* No empty "Owners" label: an unowned folder is a real state, and a
          heading above nothing reads as a list that failed to load. */}
      {ownersNamed && (
        <div className="mt-3.5">
          <h4 className="text-label uppercase text-ink-faint">Owners</h4>
          <div className="mt-1">
            <PrincipalChips roles={owners.roles} users={owners.users} />
          </div>
        </div>
      )}

      {!canWrite && (
        <p className="mt-3.5 text-detail text-ink-muted">{managedByLine(owners)}</p>
      )}

      <OverridesList overrides={overrides} truncated={truncated} />

      {manageOpen && kbDirName && (
        <ManageAccessDialog
          entry={{
            name: group,
            relativePath: `${kbDirName}/${folder.folder}`,
            type: 'directory',
          }}
          workspaceId={DEFAULT_WORKSPACE_ID}
          onClose={() => {
            setManageOpen(false);
            reload();
          }}
        />
      )}
    </Surface>
  );
}

/** Who a non-writer should ask. Names, because a role is not someone to ask. */
function managedByLine(owners: AccessEligible): string {
  if (owners.users.length > 0) {
    return `Managed by ${owners.users.map((u) => u.name).join(', ')}. Ask them to change access.`;
  }
  return 'Managed by the Admins. Ask an Admin to change access.';
}

function PrincipalChips({
  roles,
  users,
}: {
  roles: string[];
  users: { name: string; email: string }[];
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5')}>
      {roles.map((role) => (
        <Badge key={role} tone="outline" size="sm">
          {role}
        </Badge>
      ))}
      {users.length > 0 && (
        <span className="text-body text-ink">{users.map((u) => u.name).join(' · ')}</span>
      )}
    </div>
  );
}

/**
 * What a rule names. A role reads as its own name, the built-in everyone as
 * `Everyone`, and a person as `name <email>` — the exact form the rule file
 * uses, so somebody can find the line they need to change.
 */
function principalLabel(principal: AccessOverridePrincipal): string {
  if (principal.kind === 'everyone') return 'Everyone';
  if (principal.kind === 'role') return principal.role;
  return `${principal.name} <${principal.email}>`;
}

function summarizeEntries(entries: AccessOverrideEntry[]): string {
  return entries
    .map((e) => `${e.deny ? 'deny ' : ''}${e.verb}: ${principalLabel(e.principal)}`)
    .join(' · ');
}

/**
 * The name of the thing a rule governs.
 *
 * A skill IS its folder — its rules live in `…/<skill>/SKILL.md`, whose last
 * segment is the literal word "SKILL" for every skill in the KB. Naming the row
 * after that would make every skill's row identical, so a `SKILL.md` is named
 * by its folder. Other `.md` files drop the extension; a `.tool` keeps it,
 * because that suffix is how the product refers to a tool manual.
 */
function governsLabel(governs: string): string {
  const segments = governs.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? governs;
  if (last === 'SKILL.md' && segments.length > 1) return segments[segments.length - 2];
  return last.endsWith('.md') ? last.slice(0, -'.md'.length) : last;
}

function OverridesList({
  overrides,
  truncated,
}: {
  overrides: AccessOverride[];
  truncated: boolean;
}) {
  if (overrides.length === 0) return null;

  return (
    <div className="mt-4 border-t border-line pt-3.5">
      <h4 className="text-label uppercase text-ink-faint">Item-specific rules</h4>
      {/* Closeness-first, stated precisely: an item's rule wins only for the
          principals it names. "Always wins" would be a lie about the resolver. */}
      <p className="mt-1 text-detail text-ink-muted">
        {"Rules on an item override this folder's rules for the people and groups they name."}
      </p>
      <ul aria-label="Item-specific rules" className="mt-2 flex flex-col gap-1.5">
        {overrides.map((override) => (
          <ListRow
            as="li"
            key={override.path}
            density="row"
            label={governsLabel(override.governs)}
            description={override.parseError ?? summarizeEntries(override.entries)}
            meta={
              override.parseError ? (
                <Badge tone="danger" size="xs">
                  Unreadable rules
                </Badge>
              ) : (
                <Badge tone="outline" size="xs">
                  Own rules
                </Badge>
              )
            }
          />
        ))}
      </ul>
      {truncated && (
        <p className="mt-2 text-detail text-ink-muted">
          Showing the first rules found — this group has too many files to scan completely.
        </p>
      )}
    </div>
  );
}
