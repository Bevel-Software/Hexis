import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../library.css';
import { groupOfPath } from '@bevel-software/platform-shared';
import { LibraryToastProvider } from '../state/toast';
import { useLibraryData } from '../hooks/useLibraryData';
import {
  filterLibraryItems,
  groupCounts,
  neededToolsFor,
  skillStatus,
  toolStatus,
  type AttentionStatus,
  type LibraryFilter,
} from '../utils/status';
import { Banner, TextField } from '../../../shared/components';
import { LibraryCard } from './LibraryCard';
import { GroupsSidebar } from './GroupsSidebar';
import { DetailDialog, type DetailTarget } from './DetailDialog';

/**
 * The Library — the skills + integrations catalog (the Skills & Tools app
 * surface at `/skills-and-tools`, registered in the core shell).
 *
 * Rebuilt on the prototype. Two things it no longer has:
 *
 *  - the LOADOUT. It came from a retired mock; the prototype has no such
 *    concept, and it was a documented client-side stub, so nothing persisted
 *    was lost. Its rail is now the group nav.
 *  - Skills / Integrations filter chips. Groups are the structure, and a group
 *    owns its skills AND the tools they need, so splitting the catalog by kind
 *    showed a group's integrations detached from the reason they exist.
 *
 * Groups are derived from each item's KB path, so they work against both the
 * merged `Groups/` layout and the pre-merge one.
 *
 * All data is real: skills catalog, secrets-vault connection status, workflow
 * change requests.
 */
export function LibraryPage() {
  return (
    <LibraryToastProvider>
      <LibraryPageInner />
    </LibraryToastProvider>
  );
}

interface GalleryItem {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
  /** Folder group from the KB path, or null when the item is in none. */
  group: string | null;
}

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

function LibraryPageInner() {
  const data = useLibraryData();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<LibraryFilter>({ kind: 'all' });
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const items: GalleryItem[] = useMemo(() => {
    const skillItems: GalleryItem[] = data.skills.map((s) => ({
      kind: 'skill',
      id: s.name,
      name: s.name,
      description: s.description,
      owned: data.ownedSkills.has(s.name),
      group: groupOfPath(s.path),
      status: skillStatus(
        neededToolsFor({ allowedTools: data.allowedToolsBySkill.get(s.name) }, data.tools),
      ),
    }));
    const toolItems: GalleryItem[] = data.tools.map((t) => ({
      kind: 'integration',
      id: t.slug,
      name: t.name,
      // The browser tool surface exposes no human description for a `.tool`
      // manual yet (see report) — the card stays clean; detail lives behind it.
      description: '',
      owned: t.canWrite,
      group: groupOfPath(t.path),
      status: toolStatus(t),
    }));
    return [...skillItems, ...toolItems];
  }, [data.skills, data.tools, data.ownedSkills, data.allowedToolsBySkill]);

  const visible = useMemo(
    () => filterLibraryItems(items, filter, query),
    [items, filter, query],
  );

  const groups = useMemo(() => groupCounts(items), [items]);
  const ownedCount = useMemo(() => items.filter((i) => i.owned).length, [items]);
  const ungroupedCount = useMemo(() => items.filter((i) => i.group === null).length, [items]);
  const attentionCount = useMemo(
    () => items.filter((i) => i.kind === 'integration' && i.status.state !== 'ok').length,
    [items],
  );

  function openDetail(item: GalleryItem) {
    if (item.kind === 'skill') {
      const skill = data.skills.find((s) => s.name === item.id);
      if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
    } else {
      const tool = data.tools.find((t) => t.slug === item.id);
      if (tool) setDetail({ kind: 'integration', tool });
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <GroupsSidebar
        filter={filter}
        onSelect={setFilter}
        groups={groups}
        ownedCount={ownedCount}
        ungroupedCount={ungroupedCount}
        attentionCount={attentionCount}
        onFinishSetup={() => navigate('/connect')}
      />

      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
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
      </main>

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
    </div>
  );
}
