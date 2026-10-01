import { useMemo, useState } from 'react';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { isUngrouped } from '../utils/status';
import { useNavigate } from 'react-router-dom';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { useLibraryToast } from '../state/toast.context';
import { urlForLibraryItem } from '../routes/library-paths';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { personalPluginName } from '../utils/personal-plugin';
import { EmptySkillsNudge, PluginBreadcrumb, PluginItemSections, PageNote,
  RemoveLibraryItemDialog,
} from './plugin-page-parts';
import { PageActions } from './PageActions';
import { PendingItemReview } from './PendingItemReview';
import { cn } from '../../../lib/utils';
import { HEADER_BAND, PAGE_HEADER_TESTID } from '../../../shared/theme/header';
import { PersonalAddDialog } from './PersonalAddDialog';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { copyToClipboard } from '../utils/clipboard';

/**
 * A person's own space, as a plugin: `/skills-and-tools/yours`.
 *
 * These are the items in NO plugin folder — the sign-ins that are yours alone
 * and the skills no plugin has adopted. They were a filtered gallery ("Yours
 * alone", a heading and a flat grid); now they get the same page every plugin
 * gets, because from where you stand it is the same kind of thing: a place
 * with your skills and your tools in it.
 *
 * It carries the same actions every plugin page carries, because it is the same
 * kind of thing — with ONE exception, and it is a real one rather than a
 * decision:
 *
 *  - no Share IN THE TITLE ROW. Every other action here is a client-side
 *    affordance, but sharing needs a folder to write an `access.md` into, and
 *    this page is defined as the items in NO folder. There is nothing to point
 *    the dialog at. The prototype can share its personal list because there it
 *    is a real space record (`mine:<uid>`, proto:2265); the platform has no
 *    such object, and a Share button that opens an editor over nothing is
 *    worse than no button. Giving a person's own items a home folder is a
 *    backend change, and until that exists this stays absent.
 *
 * That absence is about the SPACE, not about what is in it. A skill here is
 * still a folder of its own with its own rules — which is exactly the
 * standalone skill the skill page offers Share for — so each skill CARD
 * carries the same `…` menu it carries everywhere else, pointed at its own
 * folder. Only the page has nothing to share; the skills on it do.
 */
export function PersonalPluginPage() {
  const data = useLibrary();
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const [addOpen, setAddOpen] = useState(false);
  const toast = useLibraryToast();
  /** The card being removed, while its confirm dialog is up. */
  const [removing, setRemoving] = useState<LibraryItem | null>(null);
  /**
   * Which folder the access dialog is open on — set only by a card's Share,
   * since the page itself has no folder to share. Held as the dialog's own
   * entry, exactly as the gallery and the skill page hold it, so retargeting
   * at an ancestor is the setter itself.
   */
  const [manageTarget, setManageTarget] = useState<FileTreeEntry | null>(null);
  /**
   * The proposal whose change request is open in the review dialog — the same
   * arrangement the gallery and the plugin page hold it in, so a Proposed card
   * behaves identically on all three.
   */
  const [reviewing, setReviewing] = useState<LibraryItem | null>(null);

  const name = personalPluginName();
  const items = useMemo(() => data.items.filter(isUngrouped), [data.items]);
  /**
   * For the add dialog's name check. Every skill, not only the ungrouped ones:
   * a skill's id is its name and ids are global, so a new skill here collides
   * with a plugin's just as surely as with one of your own.
   */
  const allSkillNames = useMemo(
    () => data.items.filter((i) => i.kind === 'skill').map((i) => i.name),
    [data.items],
  );
  const skillItems = items.filter((i) => i.kind === 'skill');
  const toolItems = items.filter((i) => i.kind === 'integration');

  /**
   * Identical to the gallery's and the plugin page's — one behaviour per card,
   * wherever you clicked it.
   *
   * A PROPOSAL has no page to navigate to (its file is on a change request's
   * branch, and every item page reads the default branch), so it opens its
   * change request instead — the only thing there is to read about it. This
   * page is no exception: a proposal reaches an ungrouped card when its
   * declaration sits in no plugin folder, and the card itself says whether it
   * is waiting on YOU. A card that names the reader as the reviewer and then
   * does nothing when clicked is the one arrangement that cannot be right.
   */
  function openItem(item: LibraryItem) {
    if (item.pending) {
      setReviewing(item);
      return;
    }
    if (kbDirName) navigate(urlForLibraryItem(kbDirName, item));
  }

  if (items.length === 0 && data.loading) {
    return <PageNote>Loading the library…</PageNote>;
  }

  return (
    <div className="pb-14">
      {/* The same title row every plugin page has — the shared header band,
          the height the sidebar's header row is, and the page's FIRST row:
          the breadcrumb rides on the band, because a crumb row above it would
          push the title bar off the line the sidebar's header row holds. The
          description line that used to sit under it is gone: "Only you see
          this" is what the page's own name already says, and a subtitle
          explaining a heading is the heading admitting it did not work
          (proto: the personal list carries no lede). */}
      <div data-testid={PAGE_HEADER_TESTID} className={cn(HEADER_BAND, 'justify-between gap-4')}>
        {/* Clipped, and allowed to take the row's shortfall, for the reason
            the plugin page's is — the trail is a fixed width, so a group that
            could only shrink would run its content across the actions beside
            it on a narrow viewport. */}
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <PluginBreadcrumb />
          <h1 className="min-w-0 truncate text-display font-semibold" title={name}>
            {name}
          </h1>
        </div>
        <div className="flex-none">
          <PageActions
            onAdd={() => setAddOpen(true)}
            onCopyLink={() => copyToClipboard(window.location.href)}
            addLabel="Add a skill or tool"
          />
        </div>
      </div>

      <PluginItemSections
        skillItems={skillItems}
        toolItems={toolItems}
        onOpen={openItem}
        // The skill's own folder, not the space's — see the page's docstring.
        onShare={
          kbDirName
            ? (item) =>
                setManageTarget({
                  name: item.path.split('/').pop() ?? item.path,
                  relativePath: `${kbDirName}/${item.path}`,
                  type: 'directory',
                })
            : undefined
        }
        // Your own space: everything here is yours to remove — the backend's
        // per-path gate agrees, since your personal folder names you as owner.
        onRemove={setRemoving}
        // An empty room should say what to do in it, not explain its own filing
        // rule. The nudge's link opens the same add dialog the title row's `+`
        // does, and its chalk arrow points at that `+` — the agent stays in the
        // sentence as the other way a first skill appears.
        emptySkills={
          <EmptySkillsNudge
            lead="No skills of your own yet."
            actionLabel="Add the first skill"
            tail=", or ask your agent to create one."
            agentOnly="No skills of your own yet. Ask your agent to create skills."
            onAction={() => setAddOpen(true)}
          />
        }
        emptyTools="No sign-ins of your own yet."
      />

      {addOpen && (
        <PersonalAddDialog
          name={name}
          existingSkills={allSkillNames}
          onClose={() => setAddOpen(false)}
        />
      )}

      {/* The same dialog the plugin page opens, on a skill's folder instead of
          a plugin's. `kbDirName` gates the OPENER because the resolver
          addresses files repo-relative and the dialog strips that prefix. */}
      {manageTarget && (
        <ManageAccessDialog
          // Keyed on the path, so retargeting at an ancestor remounts it
          // against that folder — the gallery's arrangement exactly.
          key={manageTarget.relativePath}
          // The Library speaks the DEFAULT branch: these cards list what is on
          // it, so the rules they share are edited where they were read,
          // whatever branch the ambient workspace happens to be on. Same choice
          // the skill page's Share and the gallery's make.
          workspaceId={encodeURIComponent(DEFAULT_BRANCH)}
          entry={manageTarget}
          // A personal skill's grant is usually its own, but one inherited from
          // a folder above it is managed where it lives — the skill page's
          // `Manage <Folder> →`, which a card's Share must offer too or the
          // inherited grant is read-only here and editable there.
          onManageAncestor={setManageTarget}
          onClose={() => {
            setManageTarget(null);
            // A grant can change who sees the skill — and whether it is still
            // in no plugin at all — so the catalog is re-read.
            data.reload();
          }}
        />
      )}

      {reviewing && (
        <PendingItemReview
          item={reviewing}
          onClose={() => setReviewing(null)}
          onResolved={() => {
            setReviewing(null);
            // One reload moves it off the review shelf and into the catalog —
            // where, once merged, it is a released item of your own.
            data.reload();
          }}
        />
      )}

      {removing && (
        <RemoveLibraryItemDialog
          item={removing}
          place="your space"
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            toast(`Removed ${removing.name}.`);
            data.reload();
          }}
        />
      )}
    </div>
  );
}
