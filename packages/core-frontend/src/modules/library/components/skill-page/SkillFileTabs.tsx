import { cn } from '../../../../lib/utils';

interface SkillFileTabsProps {
  /** File names relative to the skill folder; `SKILL.md` is always first. */
  files: string[];
  selected: string;
  /** Files carrying an open change request — the tab shows a dot. */
  pending?: ReadonlySet<string>;
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
 * `role="tablist"` is deliberate and load-bearing for the keyboard: with it,
 * left/right arrows are what a screen-reader user is told to press, which is
 * the behavior `onKeyDown` below implements.
 */
export function SkillFileTabs({ files, selected, pending, onSelect }: SkillFileTabsProps) {
  function onKeyDown(e: React.KeyboardEvent) {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = files.indexOf(selected);
    onSelect(files[(i + delta + files.length) % files.length]);
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
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={file}
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
