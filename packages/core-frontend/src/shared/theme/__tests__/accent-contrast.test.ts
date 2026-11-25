/**
 * The accent tokens must stay legible under white.
 *
 * Why a test and not a review habit: a contrast ratio is invisible to every
 * gate the repo already has. Tailwind compiles `bg-accent` and `text-accent`
 * whatever the value is, tsc has no opinion on hex, and the design-system
 * ratchet counts OFF-system values — `bg-accent` is the on-system answer, so
 * it stays silent no matter how light the token drifts. Nothing errors; the
 * label just gets harder to read. Only measuring catches it.
 *
 * The accent is the one token where this matters, because it is the only one
 * carrying both roles against the same white:
 *
 *   bg-accent + text-white   Button's primary variant and every control
 *                            ported onto it (the prototype's `.btn.primary`)
 *   text-accent on canvas    links, tab underlines, checkmarks, dirty dots
 *
 * Both are `--color-accent` vs `#ffffff`, so one ratio governs both and a
 * single token edit is what fixes them. Threshold is WCAG AA for normal text
 * (4.5:1), not large text (3:1), because these labels are text-xs/text-sm.
 */
import { describe, it, expect } from 'vitest';
import { contrast, luminance, token } from '../../../__tests__/token-contrast';

const WHITE = '#ffffff';
const AA_NORMAL_TEXT = 4.5;

describe('accent contrast', () => {
  // Self-check: the formula reproduces two published ratios, so a failure
  // below is the token moving rather than the maths rotting.
  it('computes known WCAG ratios', () => {
    expect(contrast('#000000', WHITE)).toBeCloseTo(21, 5);
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it.each(['accent', 'accent-hover'])(
    '--color-%s clears AA against white',
    (name) => {
      expect(contrast(token(name), WHITE)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    },
  );

  // The hover step is an affordance: it has to be visible, and it has to go
  // the same direction the prototype's did (darker, never lighter). Equal
  // ratios would pass the check above while rendering as no feedback at all.
  it('accent-hover is perceptibly darker than accent', () => {
    expect(luminance(token('accent-hover'))).toBeLessThan(luminance(token('accent')));
    expect(contrast(token('accent'), token('accent-hover'))).toBeGreaterThan(1.1);
  });
});
