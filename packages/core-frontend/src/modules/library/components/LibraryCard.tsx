import { useRef, type PointerEvent } from 'react';
import { GearIcon } from './GearIcon';
import { StatusGem } from './StatusGem';
import type { AttentionStatus } from '../utils/status';

export interface LibraryCardProps {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  /** Rendered in the footer ONLY when it needs attention (mock rule). */
  status: AttentionStatus;
  picked: boolean;
  /** Card-body click: toggle loadout membership (rect feeds the particle flight). */
  onToggle(fromRect: DOMRect): void;
  /** Top-right info button: open the detail dialog. */
  onInfo(): void;
}

/**
 * One gallery card. Deliberately icon/emoji-free (approved design). Skills get
 * the green top accent strip; integrations the gear chrome (4 corner gears +
 * 1 center, slow-spinning on hover). 3D tilt + glare follow the pointer.
 */
export function LibraryCard({
  kind,
  id,
  name,
  description,
  owned,
  status,
  picked,
  onToggle,
  onInfo,
}: LibraryCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    el.style.transform = `translateY(-12px) scale(1.045) rotateX(${(0.5 - py) * 10}deg) rotateY(${(px - 0.5) * 10}deg)`;
    el.style.setProperty('--lib-mx', `${px * 100}%`);
    el.style.setProperty('--lib-my', `${py * 100}%`);
  }

  function onPointerLeave() {
    if (ref.current) ref.current.style.transform = '';
  }

  const needsAttention = kind === 'integration' && status.state !== 'ok';

  return (
    <div
      ref={ref}
      data-testid={`library-card-${kind}-${id}`}
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      aria-label={`${name} — ${picked ? 'remove from loadout' : 'add to loadout'}`}
      className={`lib-card ${kind === 'skill' ? 'lib-card-skill' : 'lib-card-tool'} ${picked ? 'lib-card-picked' : ''} flex min-h-[180px] flex-col gap-2.5 p-4`}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onClick={() => {
        const el = ref.current;
        if (el) onToggle(el.getBoundingClientRect());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const el = ref.current;
          if (el) onToggle(el.getBoundingClientRect());
        }
      }}
    >
      {kind === 'integration' && (
        <div className="lib-gears">
          <GearIcon />
          <GearIcon />
          <GearIcon />
          <GearIcon />
          <GearIcon />
        </div>
      )}
      <div className="lib-card-glare" />
      <button
        type="button"
        aria-label={`Details for ${name}`}
        title="Details"
        className={`absolute right-2.5 top-2.5 z-[3] flex h-6 w-6 items-center justify-center rounded-full border bg-white/85 font-serif text-xs font-bold italic transition-all hover:scale-110 hover:border-[#0d9488] hover:bg-white hover:text-[#0f766e] ${picked ? 'border-[#9dd8cd] text-slate-500' : 'border-slate-200 text-slate-400'}`}
        onClick={(e) => {
          e.stopPropagation();
          onInfo();
        }}
      >
        i
      </button>
      <div className="pr-6">
        <div className="text-[14.5px] font-bold tracking-[.01em] text-slate-800">{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[.08em] text-slate-400">
          {kind === 'skill' ? 'Skill' : 'Integration'}
          {owned && (
            <span className="rounded-full border border-[#f0dda6] bg-[#fdf3d8] px-1.5 text-[9.5px] font-bold tracking-[.05em] text-[#92600a]">
              OWNER
            </span>
          )}
        </div>
      </div>
      <div className="relative flex-1 text-xs text-slate-500">{description}</div>
      {needsAttention && (
        <div
          className={`flex items-center border-t pt-2.5 ${picked ? 'border-[#bde4dc]' : 'border-slate-200'}`}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
            <StatusGem state={status.state} />
            {status.text}
          </span>
        </div>
      )}
      <div className="lib-hover-cta">
        {picked ? (
          <span className="lib-hc-remove">− Remove</span>
        ) : (
          <span className="lib-hc-add">+ Add to loadout</span>
        )}
      </div>
    </div>
  );
}
