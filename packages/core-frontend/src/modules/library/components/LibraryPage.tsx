import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../library.css';
import { LoadoutProvider, useLoadout, type LoadoutKind } from '../state/loadout';
import { LibraryToastProvider, useLibraryToast } from '../state/toast';
import { useLibraryData } from '../hooks/useLibraryData';
import {
  filterLibraryItems,
  neededToolsFor,
  skillStatus,
  toolStatus,
  type AttentionStatus,
  type LibraryCategory,
} from '../utils/status';
import { Banner, TextField } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { LibraryCard } from './LibraryCard';
import { LoadoutSidebar, type LoadoutRow } from './LoadoutSidebar';
import { DetailDialog, type DetailTarget } from './DetailDialog';

/**
 * The Library — the core skills / integrations / loadout view (the Skills &
 * Tools app surface at `/skills-and-tools`, registered in the core shell).
 *
 * Repainted onto the design system. This view previously ran its own visual
 * language from `mocks/mock-a2-game-library.html` — teal accent, glossy status
 * gems, 3D-tilting cards with pointer glare, spinning gear chrome and particle
 * flight into the loadout. That direction was replaced by the flat prototype
 * (`skill-prototype-juan.html`), so the game-feel layer is gone; the loadout
 * sidebar's slot animation is kept because it communicates the add, not decor.
 *
 * All data is real (skills catalog, secrets-vault connection status, workflow
 * change requests); only the loadout itself is a documented client-side stub.
 */
export function LibraryPage() {
  return (
    <LoadoutProvider>
      <LibraryToastProvider>
        <LibraryPageInner />
      </LibraryToastProvider>
    </LoadoutProvider>
  );
}

interface GalleryItem {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
}

function LibraryPageInner() {
  const data = useLibraryData();
  const loadout = useLoadout();
  const toast = useLibraryToast();
  const navigate = useNavigate();
  const [category, setCategory] = useState<LibraryCategory>('skills');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);

  const items: GalleryItem[] = useMemo(() => {
    const skillItems: GalleryItem[] = data.skills.map((s) => ({
      kind: 'skill',
      id: s.name,
      name: s.name,
      description: s.description,
      owned: data.ownedSkills.has(s.name),
      status: skillStatus(
        neededToolsFor({ allowedTools: data.allowedToolsBySkill.get(s.name) }, data.tools),
      ),
    }));
    const toolItems: GalleryItem[] = data.tools.map((t) => ({
      kind: 'integration',
      id: t.slug,
      name: t.name,
      // The browser tool surface exposes no human description for a `.tool`
      // manual yet (see report) — the card stays clean, detail lives in ⓘ.
      description: '',
      owned: t.canWrite,
      status: toolStatus(t),
    }));
    return [...skillItems, ...toolItems];
  }, [data.skills, data.tools, data.ownedSkills, data.allowedToolsBySkill]);

  const visible = useMemo(
    () => filterLibraryItems(items, category, query),
    [items, category, query],
  );

  const counts = useMemo(
    () => ({
      skills: items.filter((i) => i.kind === 'skill').length,
      integrations: items.filter((i) => i.kind === 'integration').length,
      owned: items.filter((i) => i.owned).length,
    }),
    [items],
  );

  const rows: LoadoutRow[] = useMemo(() => {
    const byKey = new Map(items.map((i) => [`${i.kind}:${i.id}`, i]));
    const pick = (kind: LoadoutKind, ids: string[]) =>
      ids
        .map((id) => byKey.get(`${kind}:${id}`))
        .filter((i): i is GalleryItem => i !== undefined)
        .map((i) => ({ kind, id: i.id, name: i.name, status: i.status }));
    return [...pick('skill', loadout.skills), ...pick('integration', loadout.integrations)];
  }, [items, loadout.skills, loadout.integrations]);

  const attentionCount = rows.filter((r) => r.status.state !== 'ok').length;

  function toggleItem(item: GalleryItem) {
    const added = loadout.toggle(item.kind, item.id);
    if (added) {
      toast(
        item.status.state === 'ok'
          ? `${item.name} added — ready to go`
          : `${item.name} added — needs a quick sign-in`,
      );
    }
  }

  function openDetail(item: GalleryItem) {
    if (item.kind === 'skill') {
      const skill = data.skills.find((s) => s.name === item.id);
      if (skill) setDetail({ kind: 'skill', skill, owned: item.owned });
    } else {
      const tool = data.tools.find((t) => t.slug === item.id);
      if (tool) setDetail({ kind: 'integration', tool });
    }
  }

  const chip = (cat: LibraryCategory, label: string, count: number) => {
    const on = category === cat;
    return (
      <button
        key={cat}
        type="button"
        aria-pressed={on}
        className={cn(
          'flex items-center gap-2 rounded-full border px-4 py-1.5 text-detail font-medium transition-colors',
          on
            ? 'border-transparent bg-ink text-canvas'
            : 'border-line text-ink-muted hover:bg-hover hover:text-ink',
        )}
        onClick={() => setCategory(cat)}
      >
        {label}
        <span className={cn('rounded-full px-1.5 text-micro', on ? 'bg-canvas/20' : 'bg-hover')}>
          {count}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <LoadoutSidebar
        rows={rows}
        onOpen={(row) => {
          const item = items.find((i) => i.kind === row.kind && i.id === row.id);
          if (item) openDetail(item);
        }}
        onRemove={(row) => loadout.remove(row.kind, row.id)}
        attentionCount={attentionCount}
        onFinishSetup={() => navigate('/connect')}
      />

      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="flex items-start gap-4">
          <div>
            <h1 className="text-display font-semibold">Library</h1>
            <p className="mt-0.5 text-ui text-ink-muted">
              Click a card to add it to your loadout · open a card's details for more.
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

        <div className="mb-5 mt-4 flex gap-2">
          {chip('skills', 'Skills', counts.skills)}
          {chip('integrations', 'Integrations', counts.integrations)}
          {chip('owned', 'Owned by me', counts.owned)}
        </div>

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
                picked={loadout.isIn(item.kind, item.id)}
                onToggle={() => toggleItem(item)}
                onInfo={() => openDetail(item)}
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
          inLoadout={
            detail.kind === 'skill'
              ? loadout.isIn('skill', detail.skill.name)
              : loadout.isIn('integration', detail.tool.slug)
          }
          onToggleLoadout={() => {
            const item = items.find(
              (i) =>
                i.kind === (detail.kind === 'skill' ? 'skill' : 'integration') &&
                i.id === (detail.kind === 'skill' ? detail.skill.name : detail.tool.slug),
            );
            if (item) toggleItem(item);
          }}
          onClose={() => setDetail(null)}
          onDataChanged={data.reload}
        />
      )}
    </div>
  );
}
