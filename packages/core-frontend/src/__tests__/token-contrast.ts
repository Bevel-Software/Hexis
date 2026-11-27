import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contrast of the design tokens, for the tests that hold a colour to a ratio.
 * One reader of `tokens.css` and one copy of the WCAG 2.1 maths, so every
 * such test measures the same way. Not a test file itself.
 *
 * A ratio is invisible to every other gate: Tailwind compiles a token class
 * whatever its value, and the design-system ratchet counts only off-system
 * values. Only measuring catches a token that drifts too light.
 */

// Resolved off this file rather than `process.cwd()` so a test does not care
// which directory vitest was launched from. Deliberately NOT written as
// `new URL('../shared/theme/tokens.css', import.meta.url)`: Vite rewrites
// that exact pattern into an asset URL, and the http-scheme result fails
// fileURLToPath.
const TOKENS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'theme', 'tokens.css'),
  'utf8',
);

/**
 * A colour token's literal, read off its declaration (`--color-<name>`) and
 * never out of a comment: `#rrggbb`, or `rgba(r, g, b, a)`.
 */
export function token(name: string): string {
  const match = TOKENS.match(
    new RegExp(`^\\s*--color-${name}:\\s*(#[0-9a-fA-F]{6}|rgba\\([^)]*\\))\\s*;`, 'm'),
  );
  if (!match) throw new Error(`--color-${name} not found in tokens.css`);
  return match[1];
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** An `rgba(r, g, b, a)` laid over an opaque `#rrggbb`: the `#rrggbb` the eye sees. */
export function over(rgba: string, base: string): string {
  const [r, g, b, a] = rgba.slice(rgba.indexOf('(') + 1, -1).split(',').map(Number);
  return toHex(channels(base).map((c, i) => c * (1 - a) + [r, g, b][i] * a));
}

/** WCAG 2.1 relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex)
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
