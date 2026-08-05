import { useRef } from 'react';
import { cn } from '../../../../lib/utils';
import { skillPanelId, skillTabId } from './tab-ids';

interface SkillFileTabsProps {
  /** File names relative to the skill folder; `SKILL.md` is always first. */
  files: string[];
  selected: string;
  /** Files carrying an open change request — the tab shows a dot. */
  pending?: ReadonlySet<string>;
  /**
   * Shared prefix for the tab ids and the panel id, so the two halves can point
   * at each other. The owner of both mints it (`useId`).
   */
  baseId: string;
  onSelect(file: string): void;
}

/**
 * The skill's files, as tabs — the prototype's `.ftabs` (line 244).
 *
 * Tabs rather than the dialog's stacked list because a skill's files are
 * ALTERNATIVES: you read one at a time, and the list spent a block of vertical
 * space restating that fact above every file you actually wanted to read. The
 * dot marks a file with a change request open on it, so the one file that needs
 * a decision is visible before you have clicked anything.
 *
 * `role="tablist"` is deliberate and load-bearing: it is what tells a screen
 * reader user to press arrows, so the keyboard handling below has to actually
 * honour that promise — arrows and Home/End, with FOCUS following selection.
 */
export function SkillFileTabs({
  files,
  selected,
  pending,
  baseId,
  onSelect,
}: SkillFileTabsProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  /**
   * Select AND focus. The tabs use a roving tabindex, so selecting alone moves
   * the tab stop to a button the user is not standing on: the focus ring stays
   * behind on a tab that is no longer selected, and a screen reader keeps
   * announcing it while a different file is on screen.
   */
  function go(file: string) {
    onSelect(file);
    buttons.current.get(file)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const i = files.indexOf(selected);
    const next =
      e.key === 'ArrowRight'
        ? files[(i + 1) % files.length]
        : e.key === 'ArrowLeft'
          ? files[(i - 1 + files.length) % files.length]
          : e.key === 'Home'
            ? files[0]
            : e.key === 'End'
              ? files[files.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    go(next);
  }

  return (
    <div
      role="tablist"
      aria-label="Files in this skill"
      className="mt-6 flex flex-wrap gap-0.5 border-b border-line"
      onKeyDown={onKeyDown}
    >
      {files.map((file) => {
        const on = file === selected;
        return (
          <button
            key={file}
            type="button"
            role="tab"
            id={skillTabId(baseId, file)}
            aria-selected={on}
            aria-controls={skillPanelId(baseId)}
            tabIndex={on ? 0 : -1}
            title={file}
            ref={(el) => {
              if (el) buttons.current.set(file, el);
              else buttons.current.delete(file);
            }}
            className={cn(
              'flex items-center gap-1.5 rounded-t-sm px-3 pb-2 pt-1.5 font-mono text-meta transition-colors',
              on
                ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]'
                : 'text-ink-muted hover:bg-hover hover:text-ink',
            )}
            onClick={() => onSelect(file)}
          >
            {file}
            {pending?.has(file) && (
              <span
                aria-label="Has an open change request"
                className="size-1.5 shrink-0 rounded-full bg-wait-dot"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
