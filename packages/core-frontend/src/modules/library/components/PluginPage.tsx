import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Button } from '../../../shared/components';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import { useLibraryToast } from '../state/toast.context';
import {
  decodePluginSegment,
  pathForPluginsIndex,
  urlForItemFile,
} from '../routes/library-paths';
import { primaryFolderOf } from '../utils/plugin-summary';
import { PluginJoinRequests } from './PluginJoinRequests';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManifestButton, ClientExtensionsSection } from './PluginExtras';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { AddToPluginDialog } from './AddToPluginDialog';
import { BandControls, EmptySkillsNudge, PluginBreadcrumb, PluginItemSections, PageNote,
  RemoveLibraryItemDialog,
} from './plugin-page-parts';
import { DeletePluginDialog } from './DeletePluginDialog';
import { PageActions } from './PageActions';
import { copyToClipboard } from '../utils/clipboard';
import { LockedPluginView } from './LockedPluginView';
import { PendingSkillReview } from './PendingSkillReview';

/**
 * One plugin, as a place: `/skills-and-tools/plugins/:plugin`.
 *
 * A plugin is a KB folder, so this page is the folder made legible — its skills
 * and the tools those skills need, side by side, with who runs it and who it is
 * shared with in one line above them. The sidebar and the gallery could already
 * FILTER to a plugin; what they could not do is be linked to, bookmarked, or
 * handed to somebody. That is the whole difference this page makes.
 *
 * WHICH VIEW: the page decides member-vs-locked, not the router and not the
 * sidebar. The member view renders when the folder verdict says `canRead`, OR
 * when the caller's catalog already contains an item in the plugin (a per-file
 * grant can hand somebody one skill inside a folder they cannot read). Locked
 * means: the summary says no AND the catalog agrees — which can only happen
 * for a DISCOVERABLE plugin, because an undiscoverable one never reaches this
 * page's data at all and renders like one that does not exist.
 */
export function PluginPage() {
  const params = useParams();
  const plugin = decodePluginSegment(params.plugin ?? '');
  const data = useLibrary();
  const toast = useLibraryToast();
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
  /** The proposed skill being reviewed, if the reader opened one. */
  const [reviewing, setReviewing] = useState<LibraryItem | null>(null);
  /**
   * Whether the join-requests banner is actually on screen. The empty band's
   * chalk arrow points a fixed distance up at the title row's `+`, so any
   * banner between them turns the arrow into a lie — this is how the page
   * knows to stand the arrow down (the sentence and its action stay).
   */
  const [joinRequestsShown, setJoinRequestsShown] = useState(false);

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
   * `reloadPlugins()` raises `pluginsLoading` synchronously, so that phase is
   * guaranteed to be observed — and if it somehow were not, the button keeps
   * spinning, which is the failure worth having.
   */
  const sawLoading = useRef(false);
  const spinning = refreshState === 'spin';
  const loadsSettled = !data.loading && !data.pluginsLoading;
  useEffect(() => {
    if (!spinning) return;
    if (!loadsSettled) {
      sawLoading.current = true;
      return;
    }
    if (!sawLoading.current) return;
    sawLoading.current = false;
    setRefreshState(data.error || data.pluginsError ? 'idle' : 'done');
  }, [spinning, loadsSettled, data.error, data.pluginsError]);

  // The freshness line decays on its own — that one IS a clock, and it is the
  // only timer left. Cleared on unmount rather than left to fire into a
  // component that is gone.
  useEffect(() => {
    if (refreshState !== 'done') return;
    const timer = window.setTimeout(() => setRefreshState('idle'), 4000);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  /** The card being removed, while its confirm dialog is up. */
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  /** Whether the plugin's own delete confirmation is up. */
  const [deleteOpen, setDeleteOpen] = useState(false);

  const summary = useMemo(
    () => data.pluginSummaries.find((g) => g.name === plugin) ?? null,
    [data.pluginSummaries, plugin],
  );
  const pluginItems = useMemo(
    () => data.items.filter((i) => i.plugin === plugin),
    [data.items, plugin],
  );
  /** For the add dialog's name check — global, because a skill's id is global. */
  const allSkillNames = useMemo(
    () => data.items.filter((i) => i.kind === 'skill').map((i) => i.name),
    [data.items],
  );

  const skillItems = pluginItems.filter((i) => i.kind === 'skill');
  const toolItems = pluginItems.filter((i) => i.kind === 'integration');
  const attention = attentionOf(data.items, plugin);
  // What the Skills band actually renders. The filter is a VIEW over the band,
  // not a different query — flipping it back must show exactly what was there.
  const shownSkills = filterOn ? skillItems.filter((i) => i.status.state !== 'ok') : skillItems;

  /**
   * Both kinds open a PAGE — `skills/:name` has landed, so the contract this
   * function used to carry is discharged and the dialog is gone. Kept identical
   * to `LibraryPage.openItem` on purpose: a card must do the same thing
   * wherever you clicked it — including the proposed-skill case, which opens
   * its change request because it has no page to open.
   */
  function openItem(item: LibraryItem) {
    if (item.pending) {
      setReviewing(item);
      return;
    }
    if (kbDirName) navigate(urlForItemFile(kbDirName, item.path));
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
          data.reloadPlugins();
          data.reload();
          setAccessRevision((r) => r + 1);
        }}
      />
    ) : null;

  // Nothing has spoken yet: the catalog is still loading, the plugin index is
  // still loading, and no item has proven the plugin exists. Deciding now would
  // flash "doesn't exist" (or a locked splash) at somebody who is simply early.
  if (pluginItems.length === 0 && (data.loading || data.pluginsLoading)) {
    return <PageNote>Loading the library…</PageNote>;
  }

  if (summary && !summary.canRead && pluginItems.length === 0) {
    return (
      <>
        <LockedPluginView
          plugin={summary}
          onRequested={data.reloadPlugins}
          onUnlocked={() => {
            data.reload();
            data.reloadPlugins();
          }}
          onManage={setManageFolder}
        />
        {manageDialog}
      </>
    );
  }

  // No summary, no items, and the endpoint did NOT fail — the plugin really is
  // not there. With a failed endpoint the honest answer is the degraded member
  // view below, because "we couldn't ask" is not "it doesn't exist".
  if (!summary && pluginItems.length === 0 && !data.pluginsError) {
    return (
      <div className="py-16 text-center">
        <p className="text-ui text-ink-faint">{"This plugin doesn't exist yet."}</p>
        <Link
          to={pathForPluginsIndex()}
          className="mt-2 inline-block rounded-xs text-ui font-semibold text-ink underline"
        >
          All plugins
        </Link>
      </div>
    );
  }

  const primaryFolder = summary ? primaryFolderOf(summary) : null;

  return (
    <div className="pb-14">
      <PluginBreadcrumb name={plugin} />

      {/* The title row carries the page's one persistent action. `Share` IS
          the manage-access dialog — not a doorway to it. It stays un-gated:
          for a non-writer the dialog renders read-only (its own `canWrite`
          verdict decides), which is exactly what "who is this shared with?"
          should answer. Hidden only when no folder is known to manage. */}
      {/* Three actions, beside the title, for everyone (proto:3012-3025).
          Share stays un-gated: for a non-writer the dialog renders read-only,
          which is exactly what "who is this shared with?" should answer. */}
      <div className="flex items-start justify-between gap-4">
        <h1 className="mt-1.5 text-display font-semibold">{plugin}</h1>
        <div className="mt-1.5 flex items-center gap-1">
          <ManifestButton kbDirName={kbDirName} folder={plugin} canWrite={summary?.canWrite === true} />
          <PageActions
            onShare={primaryFolder ? () => setManageFolder(primaryFolder) : undefined}
            // The dialog needs both to mount (`addOpen && summary &&
            // primaryFolder`), so without them `+` could only ever be a
            // no-op — it is omitted instead, the same way `Share` is when
            // there is no folder to manage. The empty band's doorway checks
            // the identical prerequisite, so the two ways to add always agree
            // about whether adding is possible at all.
            onAdd={summary && primaryFolder ? () => setAddOpen(true) : undefined}
            onCopyLink={() => copyToClipboard(window.location.href)}
            // The OWNER's verb — `isOwner` is the same verdict the DELETE
            // route enforces, so the item appears for exactly the people the
            // backend will let through.
            onDelete={summary?.isOwner ? () => setDeleteOpen(true) : undefined}
            addLabel={`Add a skill or tool to ${plugin}`}
          />
        </div>
      </div>

      {/* Somebody is waiting on the person reading this. Rendered only for a
          plugin manager (canWrite) — every member can see the CRs elsewhere,
          but only the people who can act on a request get its banner. */}
      {summary?.canWrite && (
        <PluginJoinRequests
          plugin={plugin}
          folders={summary.folders}
          onManage={setManageFolder}
          reloadSignal={accessRevision}
          onVisible={setJoinRequestsShown}
          className="mt-4"
        />
      )}

      {attention > 0 && (
        <Banner role="status" tone="wait" className="mt-4">
          <span>
            {`${attention} ${
              attention === 1
                ? 'integration needs setup: connect it'
                : 'integrations need setup: connect them'
            } to unblock this plugin's skills.`}
          </span>{' '}
          <Button variant="outline" size="tiny" onClick={() => navigate('/connect')}>
            Finish setup
          </Button>
        </Banner>
      )}

      <PluginItemSections
        skillItems={shownSkills}
        toolItems={toolItems}
        onOpen={openItem}
        // Removal is the PLUGIN MANAGER's verb — the same canWrite that lets
        // them answer join requests. The backend's per-path gate enforces it
        // for real; this only decides who sees the affordance.
        onRemove={summary?.canWrite ? setRemoving : undefined}
        emptySkills={
          filterOn ? (
            'Nothing in this band needs you right now.'
          ) : summary && primaryFolder ? (
            // A truly empty plugin is the one moment the page has to teach
            // where "add" lives — the button opens the same dialog the title
            // row's `+` does, and the nudge's arrow points at that `+`. The
            // arrow stands down when a banner sits between the band and the
            // title row (join requests, integration attention): its aim is a
            // fixed offset, and pointing into a banner teaches the wrong spot.
            <EmptySkillsNudge
              lead="No skills yet."
              actionLabel="Add the first skill"
              tail={`, or ask your agent to write one for ${plugin}.`}
              agentOnly={`No skills yet. Ask your agent to write one for ${plugin}.`}
              arrow={attention === 0 && !joinRequestsShown}
              onAction={() => setAddOpen(true)}
            />
          ) : (
            // Degraded: the plugins endpoint failed, so the summary — and with
            // it the folder the add dialog writes into — is missing. The
            // dialog gated on both (`addOpen && summary && primaryFolder`)
            // could not mount, so a doorway here would be a button that does
            // nothing. State the fact and the one door that still works.
            `No skills yet. Ask your agent to write one for ${plugin}.`
          )
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
              data.reloadPlugins();
            }}
          />
        }
      />

      {reviewing && (
        <PendingSkillReview
          item={reviewing}
          onClose={() => setReviewing(null)}
          onResolved={() => {
            setReviewing(null);
            // One reload moves it off the review shelf and into the catalog;
            // the plugin index follows because its skill count just changed.
            data.reload();
            data.reloadPlugins();
          }}
        />
      )}

      {addOpen && summary && primaryFolder && (
        <AddToPluginDialog
          name={plugin}
          primaryPath={primaryFolder}
          canWrite={summary.canWrite}
          // Every skill, not just this plugin's: a skill's id is its name and
          // ids are global, so the collision that matters is with any of them.
          existingSkills={allSkillNames}
          onClose={() => setAddOpen(false)}
        />
      )}

      {deleteOpen && summary && (
        <DeletePluginDialog
          name={plugin}
          skillCount={summary.skillCount}
          toolCount={summary.toolCount}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            toast(`Deleted ${plugin}.`);
            // This page's place just ceased to exist — the index is the
            // honest landing. Reloads follow so the sidebar agrees.
            navigate(pathForPluginsIndex());
            data.reload();
            data.reloadPlugins();
          }}
        />
      )}

      {removing && (
        <RemoveLibraryItemDialog
          item={removing}
          place={plugin}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            toast(`Removed ${removing.name} from ${plugin}.`);
            // Catalog for the card, plugin index for the counts.
            data.reload();
            data.reloadPlugins();
          }}
        />
      )}

      <ClientExtensionsSection kbDirName={kbDirName} folder={plugin} />
      {manageDialog}
    </div>
  );
}




