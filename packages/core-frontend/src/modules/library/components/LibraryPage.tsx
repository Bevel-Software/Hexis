import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../library.css';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { pathForSkill, pathForTool } from '../routes/library-paths';
import { emptyMessageFor, filterLibraryItems, type LibraryFilter } from '../utils/status';
import { Banner, TextField } from '../../../shared/components';
import { GroupItemSections } from './group-page-parts';

/**
 * The Library gallery — the card grid at `/skills-and-tools/everything` and its
 * filtered views (`/owned`, and a group's cards).
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
      return 'Everything';
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
  const [query, setQuery] = useState('');

  const visible = useMemo(
    () => filterLibraryItems(data.items, filter, query),
    [data.items, filter, query],
  );

  /** Both kinds open a PAGE now — the skill page landed alongside the tool one. */
  function openItem(item: LibraryItem) {
    navigate(item.kind === 'integration' ? pathForTool(item.id) : pathForSkill(item.id));
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
    </>
  );
}
