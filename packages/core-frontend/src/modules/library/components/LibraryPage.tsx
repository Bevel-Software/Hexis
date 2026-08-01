import { useMemo, useState } from 'react';
import '../library.css';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { filterLibraryItems, type LibraryFilter } from '../utils/status';
import { Banner, TextField } from '../../../shared/components';
import { LibraryCard } from './LibraryCard';
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
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const visible = useMemo(
    () => filterLibraryItems(data.items, filter, query),
    [data.items, filter, query],
  );

  function openDetail(item: LibraryItem) {
    if (item.kind === 'skill') {
      const skill = data.skills.find((s) => s.name === item.id);
      if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
    } else {
      const tool = data.tools.find((t) => t.slug === item.id);
      if (tool) setDetail({ kind: 'integration', tool });
    }
  }

  return (
    <>
      <div className="flex items-start gap-4">
        <div>
          <h1 className="text-display font-semibold">{headingFor(filter)}</h1>
          <p className="mt-0.5 text-ui text-ink-muted">
            {visible.length} {visible.length === 1 ? 'item' : 'items'} · open one for what it
            does, who owns it, and what it needs.
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
        <div className="py-16 text-center text-ui text-ink-faint">Nothing here matches yet.</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-2.5 pb-14">
          {visible.map((item) => (
            <LibraryCard
              key={`${item.kind}:${item.id}`}
              kind={item.kind}
              id={item.id}
              name={item.name}
              description={item.description}
              owned={item.owned}
              status={item.status}
              onOpen={() => openDetail(item)}
            />
          ))}
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
    </>
  );
}
