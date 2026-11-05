#!/usr/bin/env node
/**
 * Third-party licence notices.
 *
 * Almost every licence in the tree (MIT, ISC, BSD-*, Apache-2.0) grants the
 * right to redistribute only on the condition that its copyright notice and
 * disclaimer travel WITH the distribution. We distribute three ways — the npm
 * tarballs, the Docker image, and the Vite bundle inside it — and a bundler
 * strips comments, so the notices have to be re-attached as a file or the
 * grant technically lapses.
 *
 * This generates that file from the resolved dependency graph rather than a
 * hand-kept list, so a new dependency can never be silently under-attributed.
 *
 * It is also the licence policy gate: generation FAILS on a denied licence
 * (see DENIED), because a build that would ship GPL/AGPL code must not
 * succeed. `--check` is the same gate without the writes, for PR CI.
 *
 * Not committed to git (see .gitignore): it is a ~500 KB build artifact fully
 * derived from the lockfile, and generating it in the same step that ships it
 * guarantees it describes the artifact actually being shipped. The output IS
 * deterministic — byte-identical on Windows and Linux for the same lockfile —
 * so committing it with a drift check is a viable alternative if the file is
 * ever wanted in review. That determinism depends on `normalise()` below;
 * without it, line endings alone changed the output between platforms.
 *
 * Usage:
 *   node scripts/generate-license-notices.mjs         # write notice files
 *   node scripts/generate-license-notices.mjs --check # policy gate, no writes
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * Where a notices file has to land. The root one covers the whole production
 * graph and is what the Docker image ships; each publishable package gets its
 * own scoped to that package's own subtree, because an npm consumer installing
 * only `platform-shared` must not be handed core-frontend's attributions.
 */
const TARGETS = [
  { dir: '.', filter: null, title: 'Hexis' },
  { dir: 'packages/shared', filter: '@bevel-software/platform-shared', title: '@bevel-software/platform-shared' },
  { dir: 'packages/core-backend', filter: '@bevel-software/platform-core-backend', title: '@bevel-software/platform-core-backend' },
  { dir: 'packages/core-frontend', filter: '@bevel-software/platform-core-frontend', title: '@bevel-software/platform-core-frontend' },
  { dir: 'packages/mcp-core', filter: '@bevel-software/platform-mcp-core', title: '@bevel-software/platform-mcp-core' },
  { dir: 'packages/hexis-mcp', filter: '@bevel-software/hexis-mcp', title: '@bevel-software/hexis-mcp' },
];

/**
 * Permissive / notice-only licences, in order of preference — the order is
 * what a dual-licensed package elects, so it runs fewest-obligations first.
 */
const ALLOWED = [
  'MIT', 'MIT-0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'ISC',
  'BSD-2-Clause', 'BSD-3-Clause', 'BSD', 'Zlib', 'Apache-2.0',
  'Python-2.0', 'AFL-2.1', 'CC-BY-4.0', 'MPL-2.0',
];

/**
 * Copyleft we will not ship. Matched on the whole expression, so a dual
 * licence like `MIT OR GPL-3.0-or-later` still passes by electing MIT — only
 * a package offering NO permissive option trips this.
 */
const DENIED = /^(A?GPL|LGPL|SSPL|BUSL|EPL|CDDL|OSL|EUPL|CPAL|CC-BY-SA|UNLICENSED|Proprietary)/i;

/**
 * Weak copyleft: shippable, but the obligation is more than attribution — if
 * we ever patch one of these packages' own files, the modified files stay
 * under that licence and have to be published. Called out in its own section
 * of the notices so it stays visible.
 */
const NOTABLE = new Set(['MPL-2.0']);

/**
 * Packages whose manifest omits `license` (or points at a file). Each value
 * was verified by reading the package's own LICENSE file — do not add an
 * entry here without doing the same.
 */
const RESOLVED = {
  khroma: 'MIT',          // license file is MIT; `license` field simply missing
  spawndamnit: 'MIT',     // manifest says "SEE LICENSE IN LICENSE"; file is MIT
  duck: 'BSD-2-Clause',   // manifest says bare "BSD"; file has no 3rd clause
};

/** Ask pnpm for the production graph, optionally scoped to one workspace package. */
function readLicenseData(filter) {
  const args = ['licenses', 'list', '--prod', '--json'];
  if (filter) args.push('--filter', filter);
  const raw = execFileSync('pnpm', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  // pnpm may print progress lines before the JSON body.
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

/**
 * Parse an SPDX expression into a tree. Splitting on OR/AND textually cannot
 * work: `(MIT OR X) AND GPL-3.0-only` would match MIT and drop the mandatory
 * GPL term entirely, letting copyleft through the gate. OR binds looser than
 * AND in SPDX, so the grammar is
 *   expr := and ( 'OR' and )* ;  and := term ( 'AND' term )* ;
 *   term := IDENT | '(' expr ')'
 * Returns null on anything it cannot parse, so callers fail closed.
 */
function parseSpdx(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (word) => (peek() ?? '').toUpperCase() === word;

  const parseExpr = () => {
    const options = [parseAnd()];
    while (isOp('OR')) {
      pos += 1;
      options.push(parseAnd());
    }
    return options.length === 1 ? options[0] : { op: 'OR', children: options };
  };

  const parseAnd = () => {
    const parts = [parseTerm()];
    while (isOp('AND')) {
      pos += 1;
      parts.push(parseTerm());
    }
    return parts.length === 1 ? parts[0] : { op: 'AND', children: parts };
  };

  const parseTerm = () => {
    if (peek() === '(') {
      pos += 1;
      const inner = parseExpr();
      if (peek() !== ')') return null;
      pos += 1;
      return inner;
    }
    const word = peek();
    if (!word || word === ')' || isOp('AND') || isOp('OR')) return null;
    pos += 1;
    // `GPL-2.0+` and `... WITH Classpath-exception` attach to the preceding id.
    if ((peek() ?? '').toUpperCase() === 'WITH') {
      pos += 2;
      return { id: `${word} WITH ${tokens[pos - 1]}` };
    }
    return { id: word };
  };

  const tree = parseExpr();
  if (!tree || pos !== tokens.length) return null;
  return tree;
}

/**
 * Walk the tree bottom-up. A leaf is shippable only if it is allow-listed and
 * not denied; AND requires EVERY operand (so a denied operand always sinks the
 * whole node); OR picks the allowed branch that ranks most permissive. `rank`
 * is the index into ALLOWED, so lower is more permissive.
 */
function evaluate(node) {
  if (node.id) {
    const ok = ALLOWED.includes(node.id) && !DENIED.test(node.id);
    return { ok, license: node.id, rank: ALLOWED.indexOf(node.id), denied: DENIED.test(node.id) };
  }

  const results = node.children.map(evaluate);

  if (node.op === 'AND') {
    const ok = results.every((r) => r.ok);
    return {
      ok,
      license: results.map((r) => r.license).join(' AND '),
      rank: Math.max(...results.map((r) => r.rank)),
      denied: results.some((r) => r.denied),
    };
  }

  const viable = results.filter((r) => r.ok).sort((a, b) => a.rank - b.rank);
  if (viable.length) return viable[0];
  return {
    ok: false,
    license: results.map((r) => r.license).join(' OR '),
    rank: -1,
    // Only a denial if EVERY branch is denied — an unrecognised alternative
    // means we simply could not classify it, which is a different problem.
    denied: results.every((r) => r.denied),
  };
}

/** Reduce an SPDX expression to the single licence we ship the package under. */
function elect(expression, pkgName) {
  const raw = (expression ?? '').trim();
  if (!raw || raw === 'Unknown') {
    const resolved = RESOLVED[pkgName];
    return resolved
      ? { license: resolved, note: 'resolved from the package LICENSE file' }
      : { license: 'UNKNOWN', unresolved: true };
  }

  const tree = parseSpdx(raw);
  if (!tree) return { license: raw, unresolved: true };

  const result = evaluate(tree);
  if (!result.ok) {
    return result.denied ? { license: raw, denied: true } : { license: raw, unresolved: true };
  }

  const normalised = raw.replace(/^\((.*)\)$/, '$1').trim();
  return result.license === normalised
    ? { license: result.license }
    : { license: result.license, note: `elected from \`${raw}\`` };
}

/**
 * Licences whose text is standard boilerplate carrying no per-package copyright
 * line, so a vendored canonical copy is a faithful substitute when a package
 * ships none. MIT/BSD are deliberately NOT here: their text embeds the holder's
 * copyright, and inventing that line would be worse than omitting it.
 */
const BOILERPLATE = new Set(['Apache-2.0', 'MPL-2.0']);

/**
 * Licence texts are deduplicated by exact content, so line endings decide
 * whether two copies of the same licence collapse into one block. They vary for
 * reasons that have nothing to do with the licence: packages ship whichever
 * ending their author committed, and git's autocrlf rewrites our own vendored
 * texts to CRLF on a Windows checkout — which stopped them matching the LF
 * copies shipped inside packages and emitted the same Apache-2.0 text twice.
 * Normalising on read makes the dedupe content-correct and the output
 * byte-identical on every platform.
 */
const normalise = (text) => text.replace(/\r\n/g, '\n').trim();

const canonicalText = (license) => {
  try {
    return normalise(readFileSync(join(ROOT, 'scripts', 'license-texts', `${license}.txt`), 'utf8'));
  } catch {
    return null;
  }
};

function readFileIfPresent(pkgPath, file) {
  try {
    const full = join(pkgPath, file);
    if (!statSync(full).isFile()) return null;
    return normalise(readFileSync(full, 'utf8')) || null;
  } catch {
    return null;
  }
}

/** Pull the verbatim licence text a package ships, so notices carry the real copyright line. */
function readLicenseText(pkgPath, license) {
  let entries = [];
  try {
    entries = readdirSync(pkgPath);
  } catch {
    /* package dir unreadable — fall through to the canonical text */
  }

  // Rank by how likely the file is to be THE licence. Sorting by name length
  // alone would let a package's NOTICE (6 chars) outrank its LICENSE (7).
  const rank = (f) => {
    if (/^licen[cs]e(\.(md|txt|markdown))?$/i.test(f)) return 0;
    if (/^copying(\.(md|txt))?$/i.test(f)) return 1;
    if (/^licen[cs]e/i.test(f)) return 2; // LICENSE-MIT, LICENSE.BSD, …
    return 3;
  };
  const candidates = entries
    .filter((f) => /^(licen[cs]e|copying)/i.test(f))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length);

  let text = null;
  for (const file of candidates) {
    text = readFileIfPresent(pkgPath, file);
    if (text) break;
  }

  let synthesised = false;
  if (!text && BOILERPLATE.has(license)) {
    text = canonicalText(license);
    synthesised = Boolean(text);
  }

  // Apache-2.0 §4(d): a NOTICE file shipped by the dependency must be
  // propagated with any derivative distribution, so carry it alongside.
  const notice = entries.some((f) => /^notice/i.test(f))
    ? readFileIfPresent(pkgPath, entries.find((f) => /^notice/i.test(f)))
    : null;
  if (text && notice) text = `${text}\n\n----- NOTICE -----\n\n${notice}`;

  return { text, synthesised };
}

/**
 * Flatten pnpm's licence->packages map into one record per RESOLVED VERSION.
 * pnpm reports `versions` and `paths` as parallel arrays, and 19 packages in
 * this tree resolve to more than one version. Collapsing them into a single
 * record would attribute every version using the licence file of whichever one
 * happened to come first — and versions legitimately differ in copyright year,
 * holder, or licence outright.
 */
function collect(data) {
  const packages = [];
  for (const [expression, entries] of Object.entries(data)) {
    for (const entry of entries) {
      const verdict = elect(expression === 'Unknown' ? null : expression, entry.name);
      const versions = entry.versions ?? [];
      const paths = entry.paths ?? [];
      // Pair by index; fall back so a malformed entry still yields one record.
      const count = Math.max(versions.length, paths.length, 1);

      for (let i = 0; i < count; i += 1) {
        const { text, synthesised } = readLicenseText(paths[i] ?? paths[0] ?? '', verdict.license);
        packages.push({
          name: entry.name,
          version: versions[i] ?? versions.join(', '),
          declared: expression,
          homepage: entry.homepage ?? '',
          author: typeof entry.author === 'string' ? entry.author : '',
          text,
          synthesised,
          ...verdict,
        });
      }
    }
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function render(title, packages) {
  const counts = {};
  for (const p of packages) counts[p.license] = (counts[p.license] ?? 0) + 1;

  const out = [];
  out.push(`# Third-party licence notices — ${title}`);
  out.push('');
  out.push(
    'This file is generated by `scripts/generate-license-notices.mjs` from the resolved',
    'production dependency graph. Do not edit it by hand — run `pnpm run notices`.',
  );
  out.push('');
  out.push(`It covers **${packages.length}** third-party packages. Each is redistributed under the`);
  out.push('licence named below, and the full text of every such licence follows.');
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push('| Licence | Packages |');
  out.push('| --- | ---: |');
  for (const [license, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    out.push(`| ${license} | ${count} |`);
  }
  out.push('');

  const notable = packages.filter((p) => NOTABLE.has(p.license));
  if (notable.length) {
    out.push('## Weak-copyleft dependencies');
    out.push('');
    out.push('These are shippable alongside our own licence, but carry an obligation beyond');
    out.push('attribution: modifications to *their own source files* must remain under the same');
    out.push('licence and be made available. Using them as dependencies triggers nothing.');
    out.push('');
    for (const p of notable) out.push(`- \`${p.name}@${p.version}\` — ${p.license}`);
    out.push('');
  }

  // Dedupe identical texts: Apache-2.0 and MPL-2.0 boilerplate is byte-identical
  // across dozens of packages, while MIT/BSD differ by their copyright line and
  // so naturally stay distinct.
  const texts = new Map();
  for (const p of packages) {
    if (!p.text) continue;
    if (!texts.has(p.text)) texts.set(p.text, { index: texts.size + 1, users: [] });
    texts.get(p.text).users.push(p);
  }

  const textless = packages.filter((p) => !p.text);
  if (textless.length) {
    out.push('## Packages shipping no licence file');
    out.push('');
    out.push('These declare a licence in their manifest but ship no licence file, and their');
    out.push('text embeds a copyright holder we must not invent. They are redistributed under');
    out.push('the declared licence; refer to the upstream project for the notice.');
    out.push('');
    for (const p of textless) {
      const who = p.author ? ` — © ${p.author}` : '';
      out.push(`- \`${p.name}@${p.version}\` — ${p.license}${who}${p.homepage ? ` <${p.homepage}>` : ''}`);
    }
    out.push('');
  }

  out.push('## Packages');
  out.push('');
  for (const p of packages) {
    const ref = p.text ? ` — see licence text #${texts.get(p.text).index}` : ' — no licence file shipped';
    const note = p.note ? ` _(${p.note})_` : '';
    const home = p.homepage ? ` <${p.homepage}>` : '';
    out.push(`- **${p.name}@${p.version}** — ${p.license}${note}${ref}${home}`);
  }
  out.push('');

  out.push('## Licence texts');
  out.push('');
  for (const [text, { index, users }] of texts) {
    out.push(`### ${index}. ${users.map((u) => u.name).join(', ')}`);
    if (users.every((u) => u.synthesised)) {
      out.push('');
      out.push(
        `_These packages ship no licence file. The canonical ${users[0].license} text follows;` +
          ' it is standard boilerplate and carries no per-package copyright line._',
      );
    }
    out.push('');
    out.push('```');
    out.push(text);
    out.push('```');
    out.push('');
  }

  return out.join('\n');
}

/** Fail the build on anything we cannot lawfully ship or cannot identify. */
function enforce(packages, label, problems) {
  for (const p of packages) {
    if (p.denied) {
      problems.push(`${label}: ${p.name}@${p.version} is ${p.declared} — denied by licence policy.`);
    } else if (p.unresolved || p.license === 'UNKNOWN') {
      problems.push(
        `${label}: ${p.name}@${p.version} declares ${JSON.stringify(p.declared)}, which is not in ` +
          'the allow-list. Read its LICENSE file, then add it to ALLOWED or RESOLVED in ' +
          'scripts/generate-license-notices.mjs.',
      );
    }
  }
}

const problems = [];
let written = 0;

for (const target of TARGETS) {
  const packages = collect(readLicenseData(target.filter));
  enforce(packages, target.title, problems);

  if (!CHECK_ONLY) {
    writeFileSync(join(ROOT, target.dir, 'THIRD-PARTY-NOTICES.md'), render(target.title, packages) + '\n');
    written += 1;
    console.log(`notices: ${target.dir}/THIRD-PARTY-NOTICES.md (${packages.length} packages)`);
  } else {
    console.log(`notices: ${target.title} — ${packages.length} packages checked`);
  }
}

if (problems.length) {
  console.error('\nLicence policy violations:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  CHECK_ONLY
    ? 'notices: licence policy OK'
    : `notices: licence policy OK, ${written} file(s) written`,
);
