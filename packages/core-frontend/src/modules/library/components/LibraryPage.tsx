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
import { LibraryCard } from './LibraryCard';
import { LoadoutSidebar, type LoadoutRow } from './LoadoutSidebar';
import { DetailDialog, type DetailTarget } from './DetailDialog';
import { flyParticles } from './particles';

/**
 * The Library — the core skills / integrations / loadout view (the Skills &
 * Tools app surface at `/skills-and-tools`, registered in the core shell).
 * Game-style visual direction from
 * the approved mock `mocks/mock-a2-game-library.html`: teal accent, status
 * gems, tilting cards, loadout sidebar with particle flight. All data is real
 * (skills catalog, secrets-vault connection status, workflow change
 * requests); only the loadout itself is a documented client-side stub.
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

  function toggleItem(item: GalleryItem, fromRect?: DOMRect) {
    const added = loadout.toggle(item.kind, item.id);
    if (added) {
      toast(
        item.status.state === 'ok'
          ? `${item.name} added — ready to go`
          : `${item.name} added — needs a quick sign-in`,
      );
      if (fromRect) flyParticles(fromRect, item.kind, item.id);
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

  const chip = (cat: LibraryCategory, label: string, count: number) => (
    <button
      key={cat}
      type="button"
      aria-pressed={category === cat}
      className={`flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[12.5px] font-semibold transition-all ${
        category === cat
          ? 'border-[#7fd0c4] bg-gradient-to-br from-[#e6f7f4] to-[#d5f1ec] text-[#0f766e] shadow-[0_2px_10px_rgba(13,148,136,0.22)]'
          : 'border-slate-200 bg-white text-slate-500 hover:border-[#7fd0c4] hover:text-slate-800'
      }`}
      onClick={() => setCategory(cat)}
    >
      {label}
      <span
        className={`rounded-full px-1.5 text-[10.5px] font-bold ${
          category === cat ? 'bg-[#0d948826]' : 'bg-slate-900/5'
        }`}
      >
        {count}
      </span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 bg-[#eef1f6] text-slate-800">
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

      <main
        className="min-w-0 flex-1 overflow-y-auto px-8 py-6"
        style={{
          background:
            'radial-gradient(900px 500px at 85% -10%, rgba(13,148,136,.08), transparent 60%), radial-gradient(700px 500px at -10% 110%, rgba(59,130,246,.06), transparent 55%)',
        }}
      >
        <div className="mb-1 flex items-center gap-4">
          <div>
            <h1 className="text-[26px] font-bold tracking-tight">Library</h1>
            <div className="text-[13px] text-slate-500">
              Click a card to add it to your loadout · open a card's details for more.
            </div>
          </div>
          <div className="ml-auto flex w-64 items-center gap-2 rounded-[11px] border border-slate-200 bg-white px-3.5 py-2 shadow-[0_1px_4px_rgba(22,35,58,0.05)]">
            <input
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-slate-400"
              placeholder="Search the library…"
              aria-label="Search the library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="mb-5 mt-4 flex gap-2">
          {chip('skills', 'Skills', counts.skills)}
          {chip('integrations', 'Integrations', counts.integrations)}
          {chip('owned', 'Owned by me', counts.owned)}
        </div>

        {data.error ? (
          <div className="rounded-xl border border-[#f3c4c4] bg-[#fdecec] px-4 py-3 text-sm text-[#c53030]">
            {data.error}
            <button type="button" className="ml-3 font-bold underline" onClick={data.reload}>
              Try again
            </button>
          </div>
        ) : data.loading ? (
          <div className="py-16 text-center text-sm text-slate-400">Loading the library…</div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">Nothing here matches yet.</div>
        ) : (
          <div className="lib-grid grid grid-cols-[repeat(auto-fill,minmax(228px,1fr))] gap-5 pb-14">
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
                onToggle={(rect) => toggleItem(item, rect)}
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
