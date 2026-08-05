import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The one button. Implements the prototype's `.btn` and its five modifiers
 * (`.primary` / `.quiet` / `.small` / `.tiny` / `.danger`).
 *
 * Replaces ~117 hand-rolled button class strings, of which 153 distinct
 * variants existed across 171 sites — an average reuse of 1.1. The padding
 * values below are the design's, and they are magic numbers exactly ONCE
 * instead of once per call site.
 *
 * A11y contract (frozen): this component spreads `...rest` onto the <button>
 * and never sets `role`, `aria-*` or `title` itself, so callers keep full
 * control of the accessibility layer that 76 tests select on.
 *
 * For links, use `buttonClasses()` rather than a polymorphic `as` prop:
 *   <Link className={buttonClasses({ variant: 'primary' })}>…</Link>
 */

export type ButtonVariant = 'primary' | 'outline' | 'quiet' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'tiny';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-white hover:bg-accent-hover',
  outline: 'border-line-strong bg-transparent text-ink hover:bg-hover',
  quiet: 'border-transparent text-ink-muted hover:text-ink hover:bg-hover',
  danger: 'border-line-strong text-danger hover:bg-danger-soft',
};

/** `quiet` is a text button, so it gets tighter horizontal padding. */
const SIZE: Record<ButtonSize, string> = {
  md: 'px-[15px] py-[7px] text-ui',
  sm: 'px-3 py-1 text-detail',
  tiny: 'px-2.5 py-[3px] text-meta',
};

const QUIET_SIZE: Record<ButtonSize, string> = {
  md: 'px-[9px] py-[7px] text-ui',
  sm: 'px-2 py-1 text-detail',
  tiny: 'px-1.5 py-[3px] text-meta',
};

export function buttonClasses({
  variant = 'outline',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    'inline-flex items-center justify-center gap-[7px] rounded-full border',
    'font-medium whitespace-nowrap transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-muted',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT[variant],
    variant === 'quiet' ? QUIET_SIZE[size] : SIZE[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label, inside the same flex row. */
  leadingIcon?: ReactNode;
  /** Rendered after the label. */
  trailingIcon?: ReactNode;
}

export function Button({
  variant = 'outline',
  size = 'md',
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClasses({ variant, size, className })} {...rest}>
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}
