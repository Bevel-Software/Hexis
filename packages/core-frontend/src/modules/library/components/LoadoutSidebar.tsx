import { useEffect, useRef, useState } from 'react';
import { StatusDot } from './StatusDot';
import type { LoadoutKind } from '../state/loadout';
import type { AttentionStatus } from '../utils/status';

export interface LoadoutRow {
  kind: LoadoutKind;
  id: string;
  name: string;
  status: AttentionStatus;
}

interface LoadoutSidebarProps {
  rows: LoadoutRow[];
  onOpen(row: LoadoutRow): void;
  onRemove(row: LoadoutRow): void;
  /** How many loadout items still need attention; drives the CTA. */
  attentionCount: number;
  onFinishSetup(): void;
}

/**
 * The loadout sidebar (deck-tracker style). Collapses to a slim vertical rail
 * when empty; rows animate in, hover swaps the status gem for a remove button,
 * and SKILLS / INTEGRATIONS group labels appear only when both kinds are
 * present. The count pulses on every change.
 */
export function LoadoutSidebar({
  rows,
  onOpen,
  onRemove,
  attentionCount,
  onFinishSetup,
}: LoadoutSidebarProps) {
  const total = rows.length;
  const skills = rows.filter((r) => r.kind === 'skill');
  const integrations = rows.filter((r) => r.kind === 'integration');
  const both = skills.length > 0 && integrations.length > 0;

  // Pulse the count on change (mock's `.pulse` re-trigger).
  const [pulse, setPulse] = useState(false);
  const prevTotal = useRef(total);
  useEffect(() => {
    if (prevTotal.current !== total) {
      prevTotal.current = total;
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 220);
      return () => clearTimeout(t);
    }
  }, [total]);

  if (total === 0) {
    return (
      <aside
        aria-label="Your loadout (empty)"
        className="flex h-full w-14 shrink-0 flex-col items-center gap-3 border-r border-line bg-gradient-to-b from-white to-[#fafbfd] py-4 shadow-[6px_0_30px_rgba(22,35,58,0.06)] transition-[width] duration-300"
      >
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#f0f3f7] text-xs font-bold text-ink-faint shadow-[inset_0_0_0_1px_#e2e8f0]">
          0
        </div>
        <div className="text-[10.5px] font-bold uppercase tracking-[.2em] text-ink-faint [writing-mode:vertical-rl]">
          Loadout
        </div>
      </aside>
    );
  }

  const renderRow = (row: LoadoutRow) => (
    <div
      key={`${row.kind}:${row.id}`}
      data-loadout-key={`${row.kind}:${row.id}`}
      role="button"
      tabIndex={0}
      className="lib-slot relative mb-2 flex h-[46px] cursor-pointer items-center gap-2.5 overflow-hidden rounded-[11px] border border-[#d2e9e4] bg-gradient-to-r from-[#e6f7f4] via-[#e6f7f459] to-transparent px-2.5 transition-colors hover:border-[#7fd0c4]"
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(row);
      }}
    >
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold text-ink">{row.name}</div>
        <div className="text-[10.5px] text-ink-faint">{row.status.text}</div>
      </div>
      <span className="lib-slot-gem ml-auto shrink-0">
        <StatusDot state={row.status.state} />
      </span>
      <button
        type="button"
        aria-label={`Remove ${row.name} from loadout`}
        title="Remove from loadout"
        className="lib-slot-kick absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-white text-xs font-bold text-ink-faint hover:scale-110 hover:border-[#f3c4c4] hover:bg-[#fdecec] hover:text-[#c53030]"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(row);
        }}
      >
        ✕
      </button>
    </div>
  );

  return (
    <aside
      aria-label="Your loadout"
      className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-gradient-to-b from-white to-[#fafbfd] p-4 shadow-[6px_0_30px_rgba(22,35,58,0.06)] transition-[width] duration-300"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="whitespace-nowrap text-[15px] font-bold uppercase tracking-[.06em] text-[#0f766e]">
          Your loadout
        </h2>
        <div className={`text-[13px] font-bold text-ink-muted ${pulse ? 'lib-count-pulse' : ''}`}>
          {total}
        </div>
      </div>

      <div className="-mx-1.5 flex-1 overflow-y-auto px-1.5 pb-1">
        {both && (
          <div className="mx-1 mb-2 mt-1 text-[10px] font-bold uppercase tracking-[.14em] text-ink-faint">
            Skills
          </div>
        )}
        {skills.map(renderRow)}
        {both && (
          <div className="mx-1 mb-2 mt-3 text-[10px] font-bold uppercase tracking-[.14em] text-ink-faint">
            Integrations
          </div>
        )}
        {integrations.map(renderRow)}
        <div className="flex h-[46px] items-center justify-center rounded-[11px] border-[1.5px] border-dashed border-[#cbd7e4] text-[11.5px] tracking-[.05em] text-ink-faint">
          ◇ pick more from the library
        </div>
      </div>

      <div className="mt-3">
        {attentionCount > 0 ? (
          <>
            <button
              type="button"
              className="w-full rounded-xl bg-gradient-to-br from-[#0d9488] to-[#0f766e] p-3 text-sm font-bold tracking-[.03em] text-white shadow-[0_6px_20px_rgba(13,148,136,0.22),inset_0_1px_0_rgba(255,255,255,0.35)] transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[.98]"
              onClick={onFinishSetup}
            >
              Finish setup ({attentionCount})
            </button>
            <div className="mt-2 flex items-center justify-center gap-1.5 text-[11.5px] text-[#b45309]">
              Some items need a quick sign-in first
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-[#d2e9e4] bg-[#e6f7f4] p-3 text-center text-[12px] font-semibold text-[#0f766e]">
            Everything in your loadout is ready
          </div>
        )}
      </div>
    </aside>
  );
}
