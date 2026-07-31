import type { GemState } from '../utils/status';

const GLYPH: Record<GemState, string> = {
  ok: '✓',
  warn: '!',
  err: '✕',
  off: '·',
};

/**
 * Glossy status gem from the approved mock — emerald / amber / red / gray with
 * a text glyph. Text glyphs (not an icon set) are part of the approved visual
 * language; the state text next to it carries the accessible meaning.
 */
export function StatusGem({ state, className = '' }: { state: GemState; className?: string }) {
  return (
    <span className={`lib-gem lib-gem-${state} ${className}`.trim()} aria-hidden="true">
      {GLYPH[state]}
    </span>
  );
}
