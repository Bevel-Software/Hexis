import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * An inline notice. Implements the prototype's `.nodiff` and `.verdict`.
 *
 * `role` is REQUIRED, not defaulted. The app's existing banners are selected
 * by 13 tests via `getByRole('alert')`, and the correct role genuinely
 * differs by use: an error that interrupts is `alert`, a passive note is
 * `status`, and a purely decorative summary is `note`. Defaulting it would
 * quietly make every banner an assertive live region.
 *
 * Renders nothing when `children` is empty, so a conditional banner does not
 * leave an empty bordered box behind. This matters: 13 existing tests assert
 * `expect(container.firstChild).toBeNull()` on exactly this kind of
 * conditional element.
 */

export type BannerTone = 'wait' | 'ok' | 'danger' | 'neutral';

const TONE: Record<BannerTone, string> = {
  wait: 'bg-wait-soft text-ink',
  ok: 'bg-ok-soft text-ok',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-sunken text-ink',
};

export interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: BannerTone;
  /** REQUIRED — see the note above on why this is not defaulted. */
  role: 'alert' | 'status' | 'note';
  /** Leading marker: the prototype's bold `.nb` glyph or an icon. */
  icon?: ReactNode;
}

export function Banner({
  tone = 'neutral',
  icon,
  className,
  children,
  ...rest
}: BannerProps) {
  if (children === null || children === undefined || children === false) return null;

  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-md px-3.5 py-3 text-body leading-snug',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon && <span className="flex-none font-semibold">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
