import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../library.css';
import { useAuth } from '../../auth/state/auth.context';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { urlForLibraryItem } from '../routes/library-paths';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { EVERYONE_TEAM, emptyMessageFor, filterLibraryItems, type LibraryFilter } from '../utils/status';
import { pluginEntriesFor } from '../utils/plugin-entries';
import { personalPluginName } from '../utils/personal-plugin';
import { Banner, TextField } from '../../../shared/components';
import { PluginItemSections } from './plugin-page-parts';
import { PluginRows } from './PluginRows';
import { ManagedPluginRequests } from './ManagedPluginRequests';
import { PendingSkillReview } from './PendingSkillReview';

/**
 * The Library gallery — Everything (the root), Owned by me, and a team's
 * page: plugins as rows, then skills and tools as cards, under one search.
 *
 * This is CONTENT only: the sidebar, the flex shell and the data live in
 * `LibraryLayout` + `LibraryProvider` above it. The filter arrives as a prop
 * because the URL owns selection now — there is no `useState<LibraryFilter>`
 * anywhere, so a deep link, the back button and the sidebar can never disagree
 * about what is selected.
 *
 * Plugins head the page because they are where things live and who they are
 * for; the all-plugins index that used to be the root is this band. A team's
 * page is the same page sliced by the server's answer for that team — what
 * being in the group lets a person use — and never by anything the items
 * themselves claim.
 *
 * Two things it does not have, and won't:
 *
 *  - the LOADOUT. It came from a retired mock; the prototype has no such
 *    concept, and it was a documented client-side stub, so nothing persisted
 *    was lost. Its rail is now the plugin nav.
 *  - Skills / Integrations filter chips. Plugins are the structure, and a plugin
 *    owns its skills AND the tools they need, so splitting the catalog by kind
 *    showed a plugin's integrations detached from the reason they exist.
 */

/** The h1 names what the sidebar has selected, so the two never disagree. */
function headingFor(filter: LibraryFilter): string {
  switch (filter.kind) {
    case 'all':
      return 'Everything';
    case 'owned':
      return 'Owned by me';
    case 'ungrouped':
      return 'Yours alone';
    case 'team':
      return filter.group;
    case 'group':
      return filter.plugin;
  }
}

export function LibraryPage({ filter }: { filter: LibraryFilter }) {
  const data = useLibrary();
  const navigate = useNavigate();
  const { kbDirName } = useWorkspace();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  /** The proposed skill being reviewed, if the reader opened one. */
  const [reviewing, setReviewing] = useState<LibraryItem | null>(null);

  const visible = useMemo(
    () => filterLibraryItems(data.items, filter, query, data.teams),
    [data.items, filter, query, data.teams],
  );
  const personalLabel = personalPluginName(user?.name);
  const plugins = useMemo(
    () => pluginEntriesFor(data.items, data.pluginSummaries, filter, data.teams, query, personalLabel),
    [data.items, data.pluginSummaries, filter, data.teams, query, personalLabel],
  );
  const count = plugins.length + visible.length;
  // A team the server LISTED NOTHING LIKE is not a team — a stale link, a
  // renamed group — and the page says so instead of showing an empty slice
  // as fact. Only once the list has arrived, and only when it arrived: a
  // pending request has no list yet, and a failed one is "we could not
  // ask", which is not "there is no such team".
  const teamsSettled = filter.kind === 'team' && !data.teamsLoading && data.teamsError === null;
  const unknownTeam = teamsSettled && !data.teams.some((t) => t.name === filter.group);

  /**
   * Both kinds open a PAGE now — the skill page landed alongside the tool one.
   * A PROPOSED skill is the exception: it has no page, because the skill page
   * reads the default branch and the skill is not on it yet. Its card opens the
   * change request instead, which is the only thing there is to read.
   */
  function openItem(item: LibraryItem) {
    if (item.pending) {
      setReviewing(item);
      return;
    }
    if (kbDirName) navigate(urlForLibraryItem(kbDirName, item));
  }

  return (
    <>
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-display font-semibold">{headingFor(filter)}</h1>
          <p className="mt-0.5 text-ui text-ink-muted">
            {data.loading ? '…' : `${count} ${count === 1 ? 'item' : 'items'}`}
          </p>
          {/* Everyone is not a group but the organisation: say what the page
              holds, because the name alone reads like one more team. Only
              once the list has settled and names it — while it loads, or
              when it failed, the state below is the whole story. */}
          {filter.kind === 'team' && filter.group === EVERYONE_TEAM && teamsSettled && !unknownTeam && (
            <p className="mt-2 max-w-prose text-ui text-ink-muted">
              Org-wide: what every signed-in person and their agents can use, with no group or role needed.
            </p>
          )}
        </div>
        <TextField
          className="ml-auto w-64"
          placeholder="Search"
          aria-label="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* Somebody asking to join one of the plugins is the news on the page
          the Library opens on — the one place the ask is certain to be seen.
          Renders nothing when nothing pends. */}
      {filter.kind === 'all' && (
        <div className="mt-5 empty:mt-0">
          <ManagedPluginRequests />
        </div>
      )}

      <div className="mt-5" />

      {data.error ? (
        <Banner role="alert" tone="danger">
          {data.error}
          <button type="button" className="ml-3 font-semibold underline" onClick={data.reload}>
            Try again
          </button>
        </Banner>
      ) : data.loading ? (
        <div className="py-16 text-center text-ui text-ink-faint">Loading the library…</div>
      ) : filter.kind === 'team' && data.teamsLoading ? (
        <div className="py-16 text-center text-ui text-ink-faint">Loading teams…</div>
      ) : filter.kind === 'team' && data.teamsError ? (
        <Banner role="alert" tone="danger">
          {data.teamsError}
          <button type="button" className="ml-3 font-semibold underline" onClick={data.reloadPlugins}>
            Try again
          </button>
        </Banner>
      ) : unknownTeam ? (
        <div className="py-16 text-center text-ui text-ink-faint">
          {`There's no team called ${filter.kind === 'team' ? filter.group : ''}.`}
        </div>
      ) : (
        <div className="pb-14">
          <PluginRows entries={plugins} showCreate={filter.kind === 'all'} />
          {visible.length === 0 && plugins.length === 0 ? (
            <div className="py-16 text-center text-ui text-ink-faint">
              {emptyMessageFor(filter, query)}
            </div>
          ) : (
            // Skills and tools, split — the same two bands a plugin page has.
            // One undifferentiated grid made you read every card's body to learn
            // what kind of thing it was; the heading does that now, once, for a
            // whole band. A band with nothing in it is dropped rather than shown
            // empty: this is a search result, not an inventory of what could be.
            <PluginItemSections
              skillItems={visible.filter((i) => i.kind === 'skill')}
              toolItems={visible.filter((i) => i.kind === 'integration')}
              onOpen={openItem}
              hideEmpty
              emptySkills=""
            />
          )}
        </div>
      )}

      {reviewing && (
        <PendingSkillReview
          item={reviewing}
          onClose={() => setReviewing(null)}
          onResolved={() => {
            setReviewing(null);
            // The skill leaves the review shelf and joins the catalog by the
            // same reload — one load answers both, so the card cannot appear
            // twice in the frame between them.
            data.reload();
          }}
        />
      )}
    </>
  );
}
