import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button } from '../../../shared/components';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import {
  decodeGroupSegment,
  pathForGroupsIndex,
  pathForSkill,
  pathForTool,
} from '../routes/library-paths';
import { primaryFolderOf } from '../utils/group-summary';
import { GroupJoinRequests } from './GroupJoinRequests';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { AddToGroupDialog } from './AddToGroupDialog';
import { BandControls, GroupBreadcrumb, GroupItemSections, PageNote } from './group-page-parts';
import { PageActions } from './PageActions';
import { copyToClipboard } from '../utils/clipboard';
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
 * sidebar. The member view renders when the folder verdict says `canRead`, OR
 * when the caller's catalog already contains an item in the group (a per-file
 * grant can hand somebody one skill inside a folder they cannot read). Locked
 * means: the summary says no AND the catalog agrees — which can only happen
 * for a DISCOVERABLE group, because an undiscoverable one never reaches this
 * page's data at all and renders like one that does not exist.
 */
export function GroupPage() {
  const params = useParams();
  const group = decodeGroupSegment(params.group ?? '');
  const data = useLibrary();
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const [addOpen, setAddOpen] = useState(false);
  // The Skills band's two controls. `filterOn` narrows the band to what is
  // waiting on the reader; `refresh` re-reads the catalog and then says when it
  // last did, because "nothing changed" and "nothing was checked" otherwise
  // look identical. Both are page state — neither belongs in the URL, since
  // neither is a place you would link someone to.
  const [filterOn, setFilterOn] = useState(false);
  const [refreshState, setRefreshState] = useState<'idle' | 'spin' | 'done'>('idle');
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);
  /** Bumped when an access edit lands, so the join-request surface refetches. */
  const [accessRevision, setAccessRevision] = useState(0);

  /**
   * "Last updated just now" has to be TRUE.
   *
   * Both refetches behind the refresh button are revision bumps that return
   * `void` — there is no promise to await, so a timer was standing in for
   * completion and would claim success while the catalog was still in flight,
   * or after it had failed outright. The loads report themselves instead:
   * `spin` ends the moment both have settled, and a failure returns the button
   * rather than printing a freshness claim the page cannot back up (the error
   * itself is surfaced by the gallery banner, which owns it).
   *
   * `sawLoading` is the part that is easy to leave out and wrong without: "both
   * loads are settled" is also true of the instant BEFORE the refetch starts,
   * and of an unrelated load that was already in flight settling first. So the
   * spin only ends on a settle that FOLLOWS a loading phase this click caused.
   * `reloadGroups()` raises `groupsLoading` synchronously, so that phase is
   * guaranteed to be observed — and if it somehow were not, the button keeps
   * spinning, which is the failure worth having.
   */
  const sawLoading = useRef(false);
  const spinning = refreshState === 'spin';
  const loadsSettled = !data.loading && !data.groupsLoading;
  useEffect(() => {
    if (!spinning) return;
    if (!loadsSettled) {
      sawLoading.current = true;
      return;
    }
    if (!sawLoading.current) return;
    sawLoading.current = false;
    setRefreshState(data.error || data.groupsError ? 'idle' : 'done');
  }, [spinning, loadsSettled, data.error, data.groupsError]);

  // The freshness line decays on its own — that one IS a clock, and it is the
  // only timer left. Cleared on unmount rather than left to fire into a
  // component that is gone.
  useEffect(() => {
    if (refreshState !== 'done') return;
    const timer = window.setTimeout(() => setRefreshState('idle'), 4000);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  const summary = useMemo(
    () => data.groupSummaries.find((g) => g.name === group) ?? null,
    [data.groupSummaries, group],
  );
  const groupItems = useMemo(
    () => data.items.filter((i) => i.group === group),
    [data.items, group],
  );
  /** For the add dialog's name check — global, because a skill's id is global. */
  const allSkillNames = useMemo(
    () => data.items.filter((i) => i.kind === 'skill').map((i) => i.name),
    [data.items],
  );

  const skillItems = groupItems.filter((i) => i.kind === 'skill');
  const toolItems = groupItems.filter((i) => i.kind === 'integration');
  const attention = attentionOf(data.items, group);
  // What the Skills band actually renders. The filter is a VIEW over the band,
  // not a different query — flipping it back must show exactly what was there.
  const shownSkills = filterOn ? skillItems.filter((i) => i.status.state !== 'ok') : skillItems;

  /**
   * Both kinds open a PAGE — `skills/:name` has landed, so the contract this
   * function used to carry is discharged and the dialog is gone. Kept identical
   * to `LibraryPage.openItem` on purpose: a card must do the same thing
   * wherever you clicked it.
   */
  function openItem(item: LibraryItem) {
    navigate(item.kind === 'integration' ? pathForTool(item.id) : pathForSkill(item.id));
  }

  /**
   * THE access surface — one dialog, two openers: the title row's `Share` and
   * the Manage-access affordances. There is deliberately no read-only sibling:
   * the dialog itself degrades to read-only when the resolved verdict says the
   * caller cannot write, so a second "view access" panel would be the same
   * information twice.
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
          // Granting through the dialog can settle a pending join request —
          // refresh the roster, the catalog and the request surface together.
          data.reloadGroups();
          data.reload();
          setAccessRevision((r) => r + 1);
        }}
      />
    ) : null;

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

  const primaryFolder = summary ? primaryFolderOf(summary) : null;

  return (
    <div className="pb-14">
      <GroupBreadcrumb name={group} />

      {/* The title row carries the page's one persistent action. `Share` IS
          the manage-access dialog — not a doorway to it. It stays un-gated:
          for a non-writer the dialog renders read-only (its own `canWrite`
          verdict decides), which is exactly what "who is this shared with?"
          should answer. Hidden only when no folder is known to manage. */}
      {/* Three actions, beside the title, for everyone (proto:3012-3025).
          Share stays un-gated: for a non-writer the dialog renders read-only,
          which is exactly what "who is this shared with?" should answer. */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="mt-1.5 text-display font-semibold">{group}</h1>
        <div className="mt-1.5">
          <PageActions
            onShare={primaryFolder ? () => setManageFolder(primaryFolder) : undefined}
            onAdd={() => setAddOpen(true)}
            onCopyLink={() => copyToClipboard(window.location.href)}
            addLabel={`Add a skill or tool to ${group}`}
          />
        </div>
      </div>

      {/* Somebody is waiting on the person reading this. Rendered only for a
          group manager (canWrite) — every member can see the CRs elsewhere,
          but only the people who can act on a request get its banner. */}
      {summary?.canWrite && (
        <GroupJoinRequests
          group={group}
          folders={summary.folders}
          onManage={setManageFolder}
          reloadSignal={accessRevision}
          className="mt-4"
        />
      )}

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

      <GroupItemSections
        skillItems={shownSkills}
        toolItems={toolItems}
        onOpen={openItem}
        emptySkills={
          filterOn
            ? 'Nothing in this band needs you right now.'
            : `No skills yet. Add one, or ask your agent to write one for ${group}.`
        }
        // The band fades its controls until you hover it, and `opacity`
        // composites — so "the filter stays lit when it is on" has to be said
        // to the wrapper, not to the button inside it. Same for the spinner:
        // a refresh you cannot see is one people click twice.
        skillControlsActive={filterOn || refreshState !== 'idle'}
        skillControls={
          <BandControls
            attention={attention}
            filterOn={filterOn}
            onToggleFilter={() => setFilterOn((v) => !v)}
            refreshState={refreshState}
            onRefresh={() => {
              sawLoading.current = false;
              setRefreshState('spin');
              data.reload();
              data.reloadGroups();
            }}
          />
        }
      />

      {addOpen && summary && primaryFolder && (
        <AddToGroupDialog
          name={group}
          primaryPath={primaryFolder}
          canWrite={summary.canWrite}
          // Every skill, not just this group's: a skill's id is its name and
          // ids are global, so the collision that matters is with any of them.
          existingSkills={allSkillNames}
          onClose={() => setAddOpen(false)}
        />
      )}

      {manageDialog}
    </div>
  );
}




