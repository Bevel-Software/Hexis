import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Knowledge holds the design system, not a second one.
 *
 * The repo-wide `ds:check` ratchet is a COUNTER with slack — it would happily
 * accept a raw `bg-amber-50` reappearing here as long as something else
 * elsewhere went down. This is the module-scoped version of the same rule, and
 * it is a hard zero: the slate palette taught us that an off-system colour
 * fails SILENTLY (Tailwind emits no rule, the text renders at the inherited
 * colour, nothing errors), so counting is the only thing that catches it.
 *
 * If a genuinely new status colour is ever needed, it goes in
 * `shared/theme/tokens.css` and gets a name — it does not come back as a
 * number.
 */

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const RAW_PALETTE =
  /\b(?:bg|text|border|ring|divide|from|via|to|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|amber|yellow|green|emerald|teal|cyan|blue|indigo|violet|purple|fuchsia|pink|rose|orange|lime|sky)-\d{2,3}\b/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('modules/workspace design-system parity', () => {
  it('uses no raw Tailwind palette colours anywhere', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MODULE_DIR)) {
      const matches = readFileSync(file, 'utf8').match(RAW_PALETTE);
      if (matches) {
        offenders.push(`${relative(MODULE_DIR, file)}: ${[...new Set(matches)].join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no off-scale font sizes', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MODULE_DIR)) {
      const matches = readFileSync(file, 'utf8').match(/\btext-\[[0-9.]+px\]/g);
      if (matches) {
        offenders.push(`${relative(MODULE_DIR, file)}: ${[...new Set(matches)].join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses no bare `rounded`', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(MODULE_DIR)) {
      const matches = readFileSync(file, 'utf8').match(/\brounded(?![-\w[])/g);
      if (matches) offenders.push(relative(MODULE_DIR, file));
    }
    expect(offenders).toEqual([]);
  });
});
