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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved off this file rather than `process.cwd()` so the test does not
// care which directory vitest was launched from. Deliberately NOT written as
// `new URL('../tokens.css', import.meta.url)`: Vite rewrites that exact
// pattern into an asset URL, and the http-scheme result fails fileURLToPath.
const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'tokens.css'),
  'utf8',
);

/** Reads a token's literal off its declaration, ignoring hex in comments. */
function token(name: string): string {
  const match = TOKENS.match(
    new RegExp(`^\\s*--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'm'),
  );
  if (!match) throw new Error(`--color-${name} not found in tokens.css`);
  return match[1];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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
