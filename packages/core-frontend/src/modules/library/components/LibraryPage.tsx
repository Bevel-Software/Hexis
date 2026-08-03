import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../library.css';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { pathForTool } from '../routes/library-paths';
import { emptyMessageFor, filterLibraryItems, type LibraryFilter } from '../utils/status';
import { Banner, TextField } from '../../../shared/components';
import { useGroupAccessRequests } from '../hooks/useGroupAccessRequests';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { ManageAccessDialog } from '../../access/components/ManageAccessDialog';
import { useLibraryToast } from '../state/toast';
import { AccessRequestsBanner } from './AccessRequestsBanner';
import { GroupItemSections } from './group-page-parts';
import { DetailDialog, type DetailTarget } from './DetailDialog';

/**
 * The Library gallery — the card grid at `/skills-and-tools` and its three
 * filtered views (`/owned`, `/yours`, and a group's cards).
 *
 * This is CONTENT only: the sidebar, the flex shell and the data live in
 * `LibraryLayout` + `LibraryProvider` above it. The filter arrives as a prop
 * because the URL owns selection now — there is no `useState<LibraryFilter>`
 * anywhere, so a deep link, the back button and the sidebar can never disagree
 * about what is selected.
 *
 * Two things it does not have, and won't:
 *
 *  - the LOADOUT. It came from a retired mock; the prototype has no such
 *    concept, and it was a documented client-side stub, so nothing persisted
 *    was lost. Its rail is now the group nav.
 *  - Skills / Integrations filter chips. Groups are the structure, and a group
 *    owns its skills AND the tools they need, so splitting the catalog by kind
 *    showed a group's integrations detached from the reason they exist.
 */

/** The h1 names what the sidebar has selected, so the two never disagree. */
function headingFor(filter: LibraryFilter): string {
  switch (filter.kind) {
    case 'all':
      return 'Library';
    case 'owned':
      return 'Owned by me';
    case 'ungrouped':
      return 'Yours alone';
    case 'group':
      return filter.group;
  }
}

export function LibraryPage({ filter }: { filter: LibraryFilter }) {
  const data = useLibrary();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { kbDirName } = useWorkspace();
  const requests = useGroupAccessRequests();
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  /** Repo-relative folder whose `access.md` the Manage-access dialog is on. */
  const [manageFolder, setManageFolder] = useState<string | null>(null);

  const visible = useMemo(
    () => filterLibraryItems(data.items, filter, query),
    [data.items, filter, query],
  );

  /**
   * Pending requests, one banner per group, on the Everything view only.
   *
   * Everything is where an admin lands, so it is the one place a request is
   * guaranteed to be SEEN — the group's own page also carries its banner, but
   * nobody visits a group to find out that somebody wants into it. The other
   * two gallery views ("Owned by me", "Yours alone") are about your own things,
   * and a request is not one of them.
   */
  const pendingByGroup = useMemo(() => {
    if (filter.kind !== 'all') return [];
    const groups = [...new Set(requests.requests.map((r) => r.group))].sort((a, b) =>
      a.localeCompare(b),
    );
    return groups.map((group) => ({
      group,
      folders: data.groupSummaries.find((g) => g.name === group)?.folders ?? [],
      rows: requests.requests.filter((r) => r.group === group),
    }));
  }, [filter, requests.requests, data.groupSummaries]);

  async function dismiss(id: string) {
    try {
      await requests.dismiss(id);
    } catch {
      toast("Couldn't dismiss that — try again.");
      requests.reload();
    }
  }

  /**
   * Integrations open a PAGE, skills still open the dialog. The asymmetry is
   * temporary and deliberate: the tool page has landed, the skill page is
   * Ali's and hasn't. A card that opens a URL is also the only way the OAuth
   * round-trip has somewhere to come back to.
   */
  function openItem(item: LibraryItem) {
    if (item.kind === 'integration') {
      navigate(pathForTool(item.id));
      return;
    }
    const skill = data.skills.find((s) => s.name === item.id);
    if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
  }

  return (
    <>
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-display font-semibold">{headingFor(filter)}</h1>
          <p className="mt-0.5 text-ui text-ink-muted">
            {visible.length} {visible.length === 1 ? 'item' : 'items'}
          </p>
        </div>
        <TextField
          className="ml-auto w-64"
          placeholder="Search the library…"
          aria-label="Search the library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="mt-5" />

      {pendingByGroup.map(({ group, folders, rows }) => (
        <AccessRequestsBanner
          key={group}
          group={group}
          folders={folders}
          requests={rows}
          onManage={setManageFolder}
          onDismiss={(id) => void dismiss(id)}
        />
      ))}

      {data.error ? (
        <Banner role="alert" tone="danger">
          {data.error}
          <button type="button" className="ml-3 font-semibold underline" onClick={data.reload}>
            Try again
          </button>
        </Banner>
      ) : data.loading ? (
        <div className="py-16 text-center text-ui text-ink-faint">Loading the library…</div>
      ) : visible.length === 0 ? (
        <div className="py-16 text-center text-ui text-ink-faint">
          {emptyMessageFor(filter, query)}
        </div>
      ) : (
        // Skills and tools, split — the same two bands a group page has.
        // One undifferentiated grid made you read every card's body to learn
        // what kind of thing it was; the heading does that now, once, for a
        // whole band. A band with nothing in it is dropped rather than shown
        // empty: this is a search result, not an inventory of what could be.
        <div className="pb-14">
          <GroupItemSections
            skillItems={visible.filter((i) => i.kind === 'skill')}
            toolItems={visible.filter((i) => i.kind === 'integration')}
            onOpen={openItem}
            hideEmpty
            emptySkills=""
          />
        </div>
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

      {/* Granting read here IS approving the request: the row retires itself
          server-side once the requester can read the folder, which is why
          closing the dialog refetches instead of marking anything approved.
          `kbDirName` gates it — the resolver addresses files repo-relative and
          the dialog strips that prefix, so without it the path we hand over is
          not the path we mean. */}
      {manageFolder && kbDirName && (
        <ManageAccessDialog
          entry={{
            name: manageFolder.split('/').pop() ?? manageFolder,
            relativePath: `${kbDirName}/${manageFolder}`,
            type: 'directory',
          }}
          onClose={() => {
            setManageFolder(null);
            data.reloadGroups();
            requests.reload();
          }}
        />
      )}
    </>
  );
}
