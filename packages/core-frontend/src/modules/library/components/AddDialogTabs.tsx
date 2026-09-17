import { useId, useRef, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type AddKind = 'skills' | 'tools';

const KINDS: ReadonlyArray<readonly [AddKind, string]> = [
  ['skills', 'Skills'],
  ['tools', 'Tools'],
];

interface AddDialogTabsProps {
  selected: AddKind;
  onSelect(kind: AddKind): void;
  /** The selected tab's content. One panel, relabelled by whichever tab is on. */
  children: ReactNode;
}

/**
 * The Skills / Tools split inside both add dialogs (plugin and personal).
 *
 * The dialog is titled "Add a skill or tool", but everything in it used to be
 * about skills, and people went looking for how to add a tool and found
 * nothing. A tool has no form to fill in here — it is a prompt for the agent,
 * an `mcp.json` server, or a `.tool` manual — so the Tools tab explains rather
 * than creates.
 *
 * Same keyboard contract as `SkillFileTabs`: arrows and Home/End move the
 * selection, and focus follows it.
 */
export function AddDialogTabs({ selected, onSelect, children }: AddDialogTabsProps) {
  const baseId = useId();
  const buttons = useRef(new Map<AddKind, HTMLButtonElement>());

  function onKeyDown(e: React.KeyboardEvent) {
    const i = KINDS.findIndex(([kind]) => kind === selected);
    const at =
      e.key === 'ArrowRight' ? (i + 1) % KINDS.length
      : e.key === 'ArrowLeft' ? (i - 1 + KINDS.length) % KINDS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? KINDS.length - 1
      : undefined;
    if (at === undefined) return;
    e.preventDefault();
    const next = KINDS[at][0];
    onSelect(next);
    buttons.current.get(next)?.focus();
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="What to add"
        className="-mt-1 mb-3 flex gap-0.5 border-b border-line"
        onKeyDown={onKeyDown}
      >
        {KINDS.map(([kind, label]) => {
          const on = kind === selected;
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              id={`${baseId}-tab-${kind}`}
              aria-selected={on}
              aria-controls={`${baseId}-panel`}
              tabIndex={on ? 0 : -1}
              ref={(el) => {
                if (el) buttons.current.set(kind, el);
                else buttons.current.delete(kind);
              }}
              className={cn(
                'rounded-t-sm px-3 pb-2 pt-1.5 text-ui transition-colors',
                on
                  ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]'
                  : 'text-ink-muted hover:bg-hover hover:text-ink',
              )}
              onClick={() => onSelect(kind)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${selected}`}>
        {children}
      </div>
    </>
  );
}
