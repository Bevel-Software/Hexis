import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * A raised container. Implements the prototype's `.card`, `.panel`, `.files`,
 * `.crfiles` and `.crmini`.
 *
 * Absorbs 25 confirmed `bg-white + border + rounded` blocks and is the funnel
 * for the app's 92-site `bg-white` split — a `bg-white` is either the page
 * canvas or a raised surface, and the two want different colours the moment
 * the palette stops being pure white.
 *
 * `interactive` adds the hover/press affordance the prototype gives clickable
 * cards. It does NOT make the element a button: pass `as="button"` for that,
 * so the semantics and the styling are decided independently.
 */

export type SurfaceTone = 'surface' | 'sunken' | 'sidebar';
export type SurfaceRadius = 'md' | 'lg' | 'xl' | '2xl';
export type SurfaceElevation = 'none' | 'card' | 'overlay';

const TONE: Record<SurfaceTone, string> = {
  surface: 'bg-surface',
  sunken: 'bg-sunken',
  sidebar: 'bg-sidebar',
};

const RADIUS: Record<SurfaceRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
};

const ELEVATION: Record<SurfaceElevation, string> = {
  none: '',
  card: 'shadow-card',
  overlay: 'shadow-overlay',
};

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'aside' | 'article' | 'button';
  /**
   * Only meaningful with `as="button"`. Declared here because a `<button>`
   * inside a form defaults to `type="submit"`, so a card that omits it would
   * submit the form it happens to sit in.
   */
  type?: 'button' | 'submit' | 'reset';
  tone?: SurfaceTone;
  radius?: SurfaceRadius;
  elevation?: SurfaceElevation;
  /** Adds the prototype's hover border/background lift and press scale. */
  interactive?: boolean;
  /** Applies the card's default 14px/16px padding. */
  padded?: boolean;
}

export function Surface({
  as: Tag = 'div',
  tone = 'surface',
  radius = 'xl',
  elevation = 'card',
  interactive = false,
  padded = false,
  className,
  children,
  ...rest
}: SurfaceProps) {
  return (
    <Tag
      className={cn(
        'border border-line',
        TONE[tone],
        RADIUS[radius],
        ELEVATION[elevation],
        padded && 'px-4 pt-3.5 pb-3',
        interactive &&
          'cursor-pointer transition-[border-color,background-color,transform] hover:border-line-strong hover:bg-surface-hover active:scale-[.995]',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
