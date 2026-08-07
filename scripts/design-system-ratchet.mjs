#!/usr/bin/env node
/**
 * Design-system ratchet.
 *
 * The UI is mid-migration onto semantic tokens, so this enforces the only rule
 * that holds across a partial migration: the counts must never go UP.
 *
 * `raw-slate-palette` is already at 0 and the palette itself is deleted in
 * tokens.css, so for that rule the ratchet is effectively a hard ban — any
 * reintroduction is an increase. The other three still have real balances.
 *
 * Why a grep gate and not a build gate: disabling the palette with
 * `--color-slate-*: initial` fails SILENTLY. Tailwind simply emits no rule
 * for an unknown utility, so `text-slate-600` becomes a no-op class and the
 * text renders at its inherited colour. Nothing errors. Only counting catches
 * it.
 *
 * Usage:
 *   node scripts/design-system-ratchet.mjs          # check against baseline
 *   node scripts/design-system-ratchet.mjs --update # re-baseline after a codemod
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [
  'packages/core-frontend/src',
  'apps/web/src',
];
const BASELINE_FILE = join(ROOT, 'scripts', 'design-system-baseline.json');

/** Each rule is one thing the design system is trying to eliminate. */
const RULES = {
  'raw-slate-palette': /\b(?:text|bg|border|ring|divide|placeholder|from|via|to|outline|decoration|shadow|accent|caret|fill|stroke)-slate-\d{2,3}\b/g,
  'raw-hex-in-class': /\[#[0-9a-fA-F]{3,8}\]/g,
  // No trailing \b: `]` is a non-word char, so a boundary only exists when the
  // NEXT char is a word char — which it never is (it is `"` or a space). The
  // \b silently made this rule match nothing.
  'off-scale-font-size': /\btext-\[[0-9.]+px\]/g,
  'bare-rounded': /\brounded(?![-\w[])/g,
  // Status colours must come from the tokens (danger/ok/wait + -soft), not raw Tailwind.
  'raw-status-palette':
    /\b(?:text|bg|border|ring|divide|placeholder|from|via|to|outline|decoration|shadow|accent|caret|fill|stroke)-(?:red|rose|pink|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia)-\d{2,3}\b/g,
};

/** Files the design system itself owns — they legitimately hold raw values. */
const EXEMPT = [
  'shared/theme/',
  'shared/components/Button.tsx',
  'shared/components/IconButton.tsx',
  'shared/components/Surface.tsx',
  'shared/components/ListRow.tsx',
  'shared/components/Badge.tsx',
  'shared/components/Banner.tsx',
  'shared/components/Field.tsx',
  'shared/components/Menu.tsx',
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const counts = Object.fromEntries(Object.keys(RULES).map((k) => [k, 0]));

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    // Separators normalised before the EXEMPT test: `join()` builds a
    // backslashed path on Windows, while EXEMPT is written with `/`, so
    // `includes` matched NOTHING there — every design-system primitive got
    // counted and the same tree reported different numbers per platform
    // (here: +4 bare-rounded from Menu/Surface alone, enough to fail a gate
    // that passes in CI).
    const rel = file.slice(ROOT.length + 1).split(sep).join('/');
    if (EXEMPT.some((e) => rel.includes(e))) continue;
    const src = readFileSync(file, 'utf8');
    for (const [name, re] of Object.entries(RULES)) {
      counts[name] += (src.match(re) ?? []).length;
    }
  }
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_FILE, JSON.stringify(counts, null, 2) + '\n');
  console.log('Baseline updated:\n' + JSON.stringify(counts, null, 2));
  process.exit(0);
}

if (!existsSync(BASELINE_FILE)) {
  console.error(`No baseline at ${BASELINE_FILE}. Run with --update to create one.`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
let failed = false;

console.log('Design-system ratchet (counts must not increase):\n');
for (const [name, count] of Object.entries(counts)) {
  const was = baseline[name] ?? 0;
  const delta = count - was;
  const mark = delta > 0 ? 'FAIL' : delta < 0 ? ' -- ' : ' ok ';
  if (delta > 0) failed = true;
  console.log(
    `  [${mark}] ${name.padEnd(22)} ${String(count).padStart(5)}  (baseline ${was}${
      delta === 0 ? '' : delta > 0 ? `, +${delta}` : `, ${delta}`
    })`,
  );
}

if (failed) {
  console.error(
    '\nNew off-system values were introduced. Use the design tokens in\n' +
      'packages/core-frontend/src/shared/theme/tokens.css, or the primitives in\n' +
      "@bevel-software/platform-core-frontend/ui. If a decrease is expected, run\n" +
      'this script with --update to re-baseline.',
  );
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const wasTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`\nTotal ${total} (baseline ${wasTotal}). No regressions.`);
