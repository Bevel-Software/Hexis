import type { PullRequestSummary } from '@bevel-software/platform-shared';

interface ChangeRequestDockProps {
  crs: PullRequestSummary[];
  onSelect(cr: PullRequestSummary): void;
}

/**
 * Owner-only panel docked left of the detail dialog: a minimal name-list of
 * the open change requests touching this skill — nothing else (approved
 * design). Selecting one opens the side-by-side compare. Rendered `fixed`
 * from inside the Dialog so it escapes the panel's overflow (the Dialog panel
 * carries no transform, so fixed positioning stays viewport-relative).
 */
export function ChangeRequestDock({ crs, onSelect }: ChangeRequestDockProps) {
  return (
    <div
      className="lib-cr-dock fixed top-1/2 z-[55] flex max-h-[72vh] w-[232px] -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(22,35,58,0.20)]"
      style={{ right: 'calc(50% + 22.5rem)' }}
      aria-label="Change requests for this skill"
    >
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
        Change requests
        <span className="rounded-full bg-[#e6f7f4] px-2 text-[10.5px] text-[#0f766e]">{crs.length}</span>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto px-2.5 pb-3">
        {crs.length === 0 ? (
          <div className="p-3 text-center text-xs text-slate-400">No open change requests</div>
        ) : (
          crs.map((cr) => (
            <button
              key={cr.number}
              type="button"
              className="rounded-[10px] border border-slate-200 bg-[#fafbfd] px-3 py-2.5 text-left text-[12.5px] font-semibold text-slate-700 transition-colors hover:border-[#7fd0c4]"
              onClick={() => onSelect(cr)}
            >
              {cr.title}
              <span className="mt-0.5 block text-[10px] font-normal text-slate-400">
                {cr.appAuthor?.name ?? cr.author.name ?? cr.author.login}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
