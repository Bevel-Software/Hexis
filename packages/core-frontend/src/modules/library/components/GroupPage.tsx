import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import {
  decodeGroupSegment,
  pathForGroupsIndex,
  pathForPropose,
} from '../routes/library-paths';
import { ownersTextOf, primaryFolderOf, readersTextOf } from '../utils/group-summary';
import { useGroupAccessRequests } from '../hooks/useGroupAccessRequests';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { useLibraryToast } from '../state/toast';
import { LibraryCard } from './LibraryCard';
import { DetailDialog, type DetailTarget } from './DetailDialog';
import { AddToGroupDialog } from './AddToGroupDialog';
import { AccessRequestsBanner } from './AccessRequestsBanner';
import { LockedGroupView } from './LockedGroupView';

/**
 * One group, as a place: `/skills-and-tools/groups/:group`.
 *
 * A group is a KB folder, so this page is the folder made legible — its skills
 * and the tools those skills need, side by side, with who runs it and who it is
 * shared with in one line above them. The sidebar and the gallery could already
 * FILTER to a group; what they could not do is be linked to, bookmarked, or
 * handed to somebody. That is the whole difference this page makes.
 *
 * WHICH VIEW: the page decides member-vs-locked, not the router and not the
 * sidebar. The rule is deliberately generous — the member view renders when the
 * folder verdict says `canRead`, OR when the caller's catalog already contains
 * an item in the group. Access resolution is closeness-first, so a per-file
 * grant can hand somebody one skill inside a folder they cannot read; hiding an
 * item the platform already returned would be a lie in the other direction.
 * Locked therefore means: the summary says no AND the catalog agrees.
 */
export function GroupPage() {
  const params = useParams();
  const group = decodeGroupSegment(params.group ?? '');
  const data = useLibrary();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { kbDirName } = useWorkspace();
  const requests = useGroupAccessRequests();
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);

  const summary = useMemo(
    () => data.groupSummaries.find((g) => g.name === group) ?? null,
    [data.groupSummaries, group],
  );
  const groupItems = useMemo(
    () => data.items.filter((i) => i.group === group),
    [data.items, group],
  );

  const skillItems = groupItems.filter((i) => i.kind === 'skill');
  const toolItems = groupItems.filter((i) => i.kind === 'integration');
  const attention = attentionOf(data.items, group);

  function openDetail(item: LibraryItem) {
    // CONTRACT (Ali): when the item routes land (`skills/:name`, `tools/:slug`)
    // this becomes `navigate(pathForSkill(item.id))` / `pathForTool(item.id)`
    // and the dialog below goes away. One line per kind, nothing else moves.
    if (item.kind === 'skill') {
      const skill = data.skills.find((s) => s.name === item.id);
      if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
    } else {
      const tool = data.tools.find((t) => t.slug === item.id);
      if (tool) setDetail({ kind: 'integration', tool });
    }
  }

  /**
   * The access editor, hoisted out of both branches because both open it: the
   * locked view's `Manage access` (a locked-out Admin unlocking themselves) and
   * the member view's request banner (an owner letting somebody else in). Only
   * one of those views is ever on screen, so one dialog is enough.
   *
   * `kbDirName` gates it because the resolver addresses files repo-relative and
   * the dialog strips that prefix — without it the path we would hand over is
   * not the path we mean. Same guard the skill dialog uses.
   */
  const manageDialog =
    manageFolder && kbDirName ? (
      <ManageAccessDialog
        entry={{
          name: manageFolder.split('/').pop() ?? manageFolder,
          relativePath: `${kbDirName}/${manageFolder}`,
          type: 'directory',
        }}
        onClose={() => {
          setManageFolder(null);
          // Granting IS approving: the request retires itself server-side once
          // the requester can read, so closing the dialog is the moment to ask
          // again rather than a moment to mark anything approved here.
          data.reloadGroups();
          requests.reload();
        }}
      />
    ) : null;

  async function dismiss(id: string) {
    try {
      await requests.dismiss(id);
    } catch {
      toast("Couldn't dismiss that — try again.");
      requests.reload();
    }
  }

  // Nothing has spoken yet: the catalog is still loading, the group index is
  // still loading, and no item has proven the group exists. Deciding now would
  // flash "doesn't exist" (or a locked splash) at somebody who is simply early.
  if (groupItems.length === 0 && (data.loading || data.groupsLoading)) {
    return <PageNote>Loading the library…</PageNote>;
  }

  if (summary && !summary.canRead && groupItems.length === 0) {
    return (
      <>
        <LockedGroupView
          group={summary}
          onRequested={data.reloadGroups}
          onUnlocked={() => {
            data.reload();
            data.reloadGroups();
          }}
          onManage={setManageFolder}
        />
        {manageDialog}
      </>
    );
  }

  // No summary, no items, and the endpoint did NOT fail — the group really is
  // not there. With a failed endpoint the honest answer is the degraded member
  // view below, because "we couldn't ask" is not "it doesn't exist".
  if (!summary && groupItems.length === 0 && !data.groupsError) {
    return (
      <div className="py-16 text-center">
        <p className="text-ui text-ink-faint">{"This group doesn't exist yet."}</p>
        <Link
          to={pathForGroupsIndex()}
          className="mt-2 inline-block rounded-xs text-ui font-semibold text-ink underline"
        >
          All groups
        </Link>
      </div>
    );
  }

  const ownersText = summary ? ownersTextOf(summary) : null;
  const readersText = summary ? readersTextOf(summary) : null;
  const primaryFolder = summary ? primaryFolderOf(summary) : null;

  return (
    <div className="pb-14">
      <GroupBreadcrumb group={group} />

      <h1 className="mt-1.5 text-display font-semibold">{group}</h1>

      {/* No lede at all when the summary is missing. The alternative — printing
          "Run by the workspace admins" from a fallback we never resolved — is a
          claim about access we have not verified. */}
      {ownersText && (
        <p className="mt-1 text-ui text-ink-muted">
          {readersText
            ? `Run by ${ownersText} · shared with ${readersText}`
            : `Run by ${ownersText}`}
        </p>
      )}

      {/* Somebody is waiting on the person reading this. It goes ABOVE the
          setup banner because a request is about a human, and the folder's
          owners are the only people who can answer it. */}
      <AccessRequestsBanner
        group={group}
        folders={summary?.folders ?? []}
        requests={requests.requests.filter((r) => r.group === group)}
        onManage={setManageFolder}
        onDismiss={(id) => void dismiss(id)}
        className="mt-4"
      />

      {attention > 0 && (
        <Banner role="status" tone="wait" className="mt-4">
          <span>
            {`${attention} ${
              attention === 1 ? 'integration needs' : 'integrations need'
            } setup — connect them to unblock this group's skills.`}
          </span>{' '}
          <Button variant="outline" size="tiny" onClick={() => navigate('/connect')}>
            Finish setup
          </Button>
        </Banner>
      )}

      {/* Exactly one action, and it is the honest one. `canWrite` unknown (no
          summary) falls to Propose: claiming write access we could not verify
          would send somebody into a dialog whose button 403s. */}
      <div className="mt-4">
        {summary?.canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            Add skills or tools
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => navigate(pathForPropose(group))}>
            Propose a skill or tool
          </Button>
        )}
      </div>

      <GroupSection title="Skills" count={skillItems.length}>
        {skillItems.length === 0 ? (
          <p className="text-ui text-ink-faint">
            {`No skills yet. Add one, or ask your agent to write one for ${group}.`}
          </p>
        ) : (
          <CardGrid items={skillItems} onOpen={openDetail} />
        )}
      </GroupSection>

      <GroupSection title="Tools" count={toolItems.length}>
        {toolItems.length === 0 ? (
          <p className="text-ui text-ink-faint">No tools yet.</p>
        ) : (
          <CardGrid items={toolItems} onOpen={openDetail} />
        )}
      </GroupSection>

      {/* WP6 (group access): `<GroupAccessSection group={group} itemPaths={…} />`
          mounts HERE — the last child of the page body, after the Tools grid.
          `itemPaths` is `groupItems.map(i => i.path)`; `LibraryItem.path` exists
          for exactly that. Its `Manage access` button IS this page's access
          escalation, which is why there is no second Share button above: the
          dialog has to be opened with the `workspaceId` prop WP6 adds, or the
          edit targets whatever branch the ambient workspace last had open. */}

      {addOpen && summary && primaryFolder && (
        <AddToGroupDialog
          name={group}
          primaryPath={primaryFolder}
          onClose={() => setAddOpen(false)}
        />
      )}

      {detail && (
        <DetailDialog
          target={detail}
          tools={data.tools}
          skills={data.skills}
          allowedToolsBySkill={data.allowedToolsBySkill}
          crs={data.crs}
          myCrNumbers={data.myCrNumbers}
          onClose={() => setDetail(null)}
          onDataChanged={data.reload}
        />
      )}

      {manageDialog}
    </div>
  );
}

/** `All groups › {group}` — the page's place in the Library, and the way back. */
function GroupBreadcrumb({ group }: { group: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-detail text-ink-faint">
      <Link to={pathForGroupsIndex()} className="rounded-xs hover:text-ink">
        All groups
      </Link>
      <span aria-hidden="true">›</span>
      <span aria-current="page" className="truncate text-ink-muted">
        {group}
      </span>
    </nav>
  );
}

/** A titled band with the count beside — not inside — the heading, so the
 *  heading's accessible name stays exactly "Skills" / "Tools". */
function GroupSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-label uppercase text-ink-faint">{title}</h2>
        <span className="text-meta tabular-nums text-ink-faint">{count}</span>
      </div>
      {children}
    </section>
  );
}

function CardGrid({ items, onOpen }: { items: LibraryItem[]; onOpen(item: LibraryItem): void }) {
  return (
    <div className={cn('grid gap-2.5', 'grid-cols-[repeat(auto-fill,minmax(248px,1fr))]')}>
      {items.map((item) => (
        <LibraryCard
          key={`${item.kind}:${item.id}`}
          kind={item.kind}
          id={item.id}
          name={item.name}
          description={item.description}
          owned={item.owned}
          status={item.status}
          onOpen={() => onOpen(item)}
        />
      ))}
    </div>
  );
}

function PageNote({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-ui text-ink-faint">{children}</div>;
}
