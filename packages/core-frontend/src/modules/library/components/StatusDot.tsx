import { cn } from '../../../lib/utils';
import type { GemState } from '../utils/status';

const TONE: Record<GemState, string> = {
  ok: 'bg-ok',
  warn: 'bg-wait-dot',
  err: 'bg-danger',
  off: 'bg-ink-faint opacity-50',
};

/**
 * The prototype's `.rdot` — a flat 6px dot, no gloss and no glyph.
 *
 * Replaces the mock's glossy `.lib-gem` (a 20px radial-gradient bead with a
 * ✓/!/✕ glyph and three inset shadows). The glyph carried no information the
 * colour did not: every caller renders the state text beside it, which is what
 * assistive tech reads — the dot is `aria-hidden` in both designs.
 */
export function StatusDot({ state, className = '' }: { state: GemState; className?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 shrink-0 rounded-full', TONE[state], className)}
      aria-hidden="true"
    />
  );
}
