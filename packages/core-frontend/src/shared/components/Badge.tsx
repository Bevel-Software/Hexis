import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * A chip. Implements the prototype's `.pill` and its `.wait` / `.ok` /
 * `.ver` / `.team` modifiers, plus the sidebar's `.n` count chips.
 *
 * Only 24 call sites across 17 files, which is a modest count for a
 * primitive — but they currently use FIVE different background/text pairs
 * all meaning "a chip". It is the most drift-prone element in the app, so
 * it earns its place on consistency rather than volume.
 *
 * `mono` is for version pills, which the design sets in the mono family with
 * tightened tracking so digits line up.
 */

export type BadgeTone = 'neutral' | 'ok' | 'wait' | 'danger' | 'outline';
export type BadgeSize = 'sm' | 'xs';

const TONE: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-ink-muted',
  ok: 'bg-ok-soft text-ok',
  wait: 'bg-wait-soft text-wait font-semibold',
  danger: 'bg-danger-soft text-danger font-semibold',
  outline: 'border border-line bg-transparent text-ink-muted',
};

const SIZE: Record<BadgeSize, string> = {
  sm: 'px-2.5 py-0.5 text-meta',
  xs: 'px-1.5 text-micro',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Version numbers and other digits that should align. */
  mono?: boolean;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  mono = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        TONE[tone],
        SIZE[size],
        mono && 'font-mono tracking-[-.02em]',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
