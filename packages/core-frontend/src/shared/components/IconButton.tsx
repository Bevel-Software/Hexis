import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * A square, icon-only button. Implements the prototype's `.gearbtn` (28px),
 * `.dots` (28px), `.side-collapse` (24px), `.filt` (22px) and `.prow .x`.
 *
 * Absorbs 42 hand-rolled icon buttons. 35 of them already carry an
 * `aria-label`; this component makes that REQUIRED so the remaining 7 are a
 * compile error rather than a screen-reader regression nobody notices.
 * That is the C4 a11y contract enforced by the type system instead of by
 * code review.
 *
 * `active` drives the pressed background. Pass it alongside `aria-expanded`
 * for menu triggers — the component styles, the caller owns the semantics.
 */

export type IconButtonSize = 28 | 24 | 22 | 18;

const SIZE: Record<IconButtonSize, string> = {
  28: 'h-7 w-7 rounded-sm',
  24: 'h-6 w-6 rounded-sm',
  22: 'h-[22px] w-[22px] rounded-xs',
  18: 'h-[18px] w-[18px] rounded-xs',
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: IconButtonSize;
  tone?: 'default' | 'danger';
  /** Pressed/open state — matches the prototype's `[aria-expanded="true"]` look. */
  active?: boolean;
  /** REQUIRED: an icon-only control is invisible to assistive tech without it. */
  'aria-label': string;
}

export function IconButton({
  size = 28,
  tone = 'default',
  active = false,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex flex-none items-center justify-center transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-muted',
        'disabled:cursor-not-allowed disabled:opacity-50',
        SIZE[size],
        tone === 'danger'
          ? 'text-ink-faint hover:bg-danger-soft hover:text-danger'
          : 'text-ink-faint hover:bg-hover hover:text-ink',
        active && (tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-hover text-ink'),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
