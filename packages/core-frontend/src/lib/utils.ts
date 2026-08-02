import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `text-*` is ambiguous: it is BOTH the font-size namespace and the
 * text-colour namespace. tailwind-merge resolves that with a built-in list of
 * Tailwind's own scale names — which does not include ours.
 *
 * Untaught, it classifies a custom size like `text-ui` as a COLOUR, decides it
 * conflicts with `text-ink-muted`, and silently drops the colour:
 *
 *   cn('text-ink-muted', 'text-ui')  ->  'text-ui'      // colour lost
 *
 * That is a silent, app-wide text-colour bug the moment a primitive composes a
 * size and a colour, which every one of them does. Declaring the design
 * system's scales here is what makes `cn()` safe to build primitives on.
 *
 * Keep these in sync with `src/shared/theme/tokens.css`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // font sizes — see `--text-*` in tokens.css
      text: [
        'micro',
        'label',
        'meta',
        'detail',
        'ui',
        'body',
        'strong',
        'lede',
        'title',
        'head',
        'display-sm',
        'display',
      ],
      // semantic colours — see `--color-*` in tokens.css
      color: [
        'canvas',
        'sidebar',
        'surface',
        'surface-hover',
        'sunken',
        'ink',
        'ink-muted',
        'ink-faint',
        'line',
        'line-strong',
        'hover',
        'accent',
        'accent-hover',
        'ok',
        'ok-soft',
        'wait',
        'wait-soft',
        'wait-dot',
        'danger',
        'danger-soft',
        'mark-del',
        'mark-ins',
        'scrim',
        // brand purple — outside the design system, fate pending (T21)
        'bevel',
        'bevel-deep',
        'bevel-soft',
      ],
      shadow: ['overlay', 'card'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Hide the extension in display labels. Dot-prefixed names (.env, .gitignore)
// keep their full name. Compound suffixes (foo.test.ts) only lose the final part.
export function stripExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

