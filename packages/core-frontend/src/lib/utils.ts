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

/**
 * Human-readable relative time ("2h ago", "3d ago"). Falls back to an absolute
 * date past ~a month, where "5w ago" stops meaning anything.
 *
 * Shared rather than per-surface: the file-history timeline and the document
 * rail both say when a file was last touched, and two formatters would
 * eventually disagree about the same commit on the same screen.
 */
export function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const absolute = () =>
    d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (diffMs < 0) return absolute();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return absolute();
}

