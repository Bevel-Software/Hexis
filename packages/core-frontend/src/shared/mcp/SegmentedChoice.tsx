import { useRef } from 'react';
import { cn } from '../../lib/utils';

/**
 * One choice out of a few, as a segmented row: the control the welcome page
 * picks an agent with, shared so every "which one are you?" on the connection
 * pages looks and drives the same.
 *
 * A radiogroup, not a row of `aria-pressed` toggles: the options are mutually
 * exclusive and one is always chosen, which is what `radio` means and what
 * `pressed` does not. Three independent toggles tell a screen reader that any
 * combination, including none, is possible.
 */
export function SegmentedChoice<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  /** The group's accessible name: what is being chosen. */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * Arrow keys move the choice, because `role="radiogroup"` promised they
   * would. The role is not decoration: it tells a screen reader "these are
   * exclusive, one is always on", and the same standard that defines it also
   * defines how it is driven: arrows select, Tab leaves. Claiming the role
   * while only answering clicks describes a control the keyboard cannot work.
   *
   * Selection FOLLOWS focus, which is the pattern's default for a choice this
   * cheap to change: picking an option re-renders a snippet, nothing is
   * submitted, so there is no cost to arriving on an option and no reason to
   * make people confirm. Wraps at both ends: a few options in a row have no
   * meaningful edge to stop at.
   *
   * Paired with the roving `tabIndex` below: one stop for the whole group,
   * not one per option, so Tab moves past the picker rather than through it.
   */
  function onRadioKeyDown(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next]!.id);
    radios.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('flex gap-0.5 rounded-lg bg-sunken p-0.5', className)}>
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          // Roving: only the chosen option is a tab stop, so the group costs
          // ONE Tab rather than one per option.
          tabIndex={o.id === value ? 0 : -1}
          ref={(el) => {
            radios.current[i] = el;
          }}
          onKeyDown={(e) => onRadioKeyDown(e, i)}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-detail transition-colors',
            o.id === value ? 'bg-surface font-semibold text-ink shadow-card' : 'text-ink-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
