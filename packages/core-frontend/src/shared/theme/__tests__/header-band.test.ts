/**
 * The header band must stay ONE number in ONE place.
 *
 * The bug this guards is not "the header is the wrong height" — it is "the
 * two headers under the toolbar each computed their own height, and nothing
 * in the build noticed they disagreed." Tailwind compiles `h-header` whatever
 * `--spacing-header` says; tsc has no opinion on a class string; the
 * design-system ratchet counts OFF-system values and `h-header` is the
 * on-system answer. A page that quietly goes back to `h-[52px]`, or to a
 * `mt-1.5` nudging its title into place, breaks the seam and every existing
 * gate stays silent. Only reading the sources catches it.
 *
 * So this test asserts the two halves of the contract:
 *   1. the token exists in `tokens.css`, and `HEADER_BAND` is what spends it;
 *   2. every header row in the app comes through `HEADER_BAND` — no page
 *      keeps a private header height.
 *
 * The measured half of the contract — that the sidebar's row and a page's
 * title bar actually render to the same pixel height — is
 * `modules/layout/__tests__/HeaderAlignment.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_BAND, HEADER_COLUMN_TOP } from '../header';

// Resolved off this file rather than `process.cwd()`, and deliberately not as
// `new URL(..., import.meta.url)`: Vite rewrites that exact pattern into an
// asset URL, whose http scheme fails `fileURLToPath`. Same reasoning as
// `accent-contrast.test.ts`, which reads the same stylesheet.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..');

const read = (relativeToSrc: string) => readFileSync(join(SRC, relativeToSrc), 'utf8');

const TOKENS = read('shared/theme/tokens.css');

/**
 * Every row that renders a header — the sidebar's, and each surface's page
 * title bar. The ticket's third acceptance criterion is this list: the file
 * page, the skill page, the tool page and the Library's own pages all inherit
 * the fix, and none of them keeps a height of its own.
 */
const HEADER_ROWS = [
  'modules/layout/components/SidebarFrame.tsx',
  'modules/workspace/components/KbPageHeader.tsx',
  'modules/library/components/LibraryPage.tsx',
  'modules/library/components/PluginPage.tsx',
  'modules/library/components/PersonalPluginPage.tsx',
  'modules/library/components/LockedPluginView.tsx',
  'modules/library/components/skill-page/SkillPage.tsx',
  'modules/library/components/tool-page/ToolPage.tsx',
];

/** Every column that opens on a band, and so must open at the same offset. */
const HEADER_COLUMNS = [
  'modules/layout/components/SidebarFrame.tsx',
  'modules/library/components/LibraryLayout.tsx',
  'modules/workspace/components/KbDocumentShell.tsx',
];

/** What marks an element as a header row, and as a header column. */
const ROW_MARKER = String.raw`data-testid=\{(?:PAGE_HEADER_TESTID|SIDEBAR_HEADER_TESTID)\}`;
const COLUMN_MARKER = String.raw`\bHEADER_COLUMN_TOP\b`;

/**
 * Every `.tsx` under `src/` that a header row or a header column could be
 * hiding in — the app's own code, not its tests.
 *
 * This is what stops `HEADER_ROWS` and `HEADER_COLUMNS` from going quietly
 * stale. Two enumerations of "every page with a title bar", maintained by
 * hand, are two more things that can be forgotten: a page added next year
 * would render a private header height and the whole suite would stay green,
 * which is the exact shape of the bug this file exists to prevent. So the
 * lists are checked against the tree rather than trusted — see 'the list of
 * header rows is the whole list' below.
 */
const APP_SOURCES = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.split(sep).join('/'))
  .filter((entry) => entry.endsWith('.tsx') && !entry.includes('__tests__/'));

/** The app files whose source matches `pattern`, as paths relative to `src/`. */
function sourcesMatching(pattern: string): string[] {
  return APP_SOURCES.filter((file) => new RegExp(pattern).test(read(file))).sort();
}

/**
 * The opening tag around each hit of `marker` in a source file — from the
 * `<` that opens it to the end of that tag. Scoped to the tag rather than the
 * whole file on purpose: a page is allowed its own `h-[60vh]` panel three
 * hundred lines further down, and its own `pt-[34px]` on something that is
 * not a header column; what it is not allowed is a height or an offset on the
 * element that has to agree with the sidebar.
 */
function tagsAround(source: string, marker: string): string[] {
  const tags: string[] = [];
  const hits = new RegExp(marker, 'g');
  for (let hit = hits.exec(source); hit; hit = hits.exec(source)) {
    // From the '<' that opens the tag, so the attribute order does not
    // decide whether the test can see the className.
    const start = source.lastIndexOf('<', hit.index);
    const end = source.indexOf('>', hit.index);
    // An unterminated tag is a parse the assertions cannot trust, so hand
    // them the rest of the file rather than a silently empty string.
    tags.push(source.slice(start === -1 ? hit.index : start, end === -1 ? undefined : end));
  }
  return tags;
}

const headerRowTagsIn = (source: string) => tagsAround(source, ROW_MARKER);
const columnTagsIn = (source: string) => tagsAround(source, COLUMN_MARKER);

describe('the header height token', () => {
  it('is declared once, in tokens.css', () => {
    const declarations = TOKENS.match(/^\s*--spacing-header:\s*[^;]+;/gm) ?? [];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatch(/--spacing-header:\s*\d+(\.\d+)?px;/);
  });

  it('is what HEADER_BAND spends', () => {
    // `h-header` is the utility Tailwind compiles the token into. If the band
    // ever stops naming it, the token has become decoration.
    expect(HEADER_BAND).toContain('h-header');
    // Centred, because the band's two sides hold text at different sizes — a
    // 13px nav row against a 26px title — and centring identical boxes is the
    // only rule that survives either of them changing.
    expect(HEADER_BAND).toContain('items-center');
  });
});

describe('the enumerations cannot go stale', () => {
  // Both directions, in one assertion each. A header row in a file nobody
  // listed is a page that quietly kept a private height; a listed file that
  // no longer renders one is a list describing an app that no longer exists,
  // and its `it.each` case would keep passing vacuously either way.
  it('the list of header rows is the whole list', () => {
    expect(sourcesMatching(ROW_MARKER)).toEqual([...HEADER_ROWS].sort());
  });

  it('the list of header columns is the whole list', () => {
    expect(sourcesMatching(COLUMN_MARKER)).toEqual([...HEADER_COLUMNS].sort());
  });
});

describe('every header row uses the shared band', () => {
  it.each(HEADER_ROWS)('%s imports HEADER_BAND', (file) => {
    expect(read(file)).toMatch(/import \{[^}]*\bHEADER_BAND\b[^}]*\} from '[^']*shared\/theme\/header'/);
  });

  it.each(HEADER_ROWS)('%s renders its header row on the band, and nothing else', (file) => {
    const rows = headerRowTagsIn(read(file));
    // Every file in this list renders one, or the list is out of date.
    expect(rows.length).toBeGreaterThan(0);
    for (const tag of rows) {
      expect(tag).toContain('HEADER_BAND');
      // A height, a vertical padding or a top margin ON THE ROW ITSELF is
      // the private-height regression coming back — `h-[52px]`, `py-2`, the
      // `mt-1.5` that used to nudge a title into place. The band decides all
      // three. A bottom margin is not on the list: it is the gap to whatever
      // comes next, which is the page's business and moves nothing above it.
      expect(tag).not.toMatch(/\b(?:min-)?h-(?:\[|\d)/);
      expect(tag).not.toMatch(/\b(?:mt|pt|pb|py)-/);
    }
  });

  it.each(HEADER_COLUMNS)('%s opens on the shared offset', (file) => {
    const source = read(file);
    expect(source).toMatch(
      /import \{[^}]*\bHEADER_COLUMN_TOP\b[^}]*\} from '[^']*shared\/theme\/header'/,
    );
    const columns = columnTagsIn(source);
    expect(columns.length).toBeGreaterThan(0);
    for (const tag of columns) {
      // Scoped to the column's own tag, the same way the rows are: a page is
      // allowed a `pt-[34px]` on some panel far below, and even a comment
      // quoting the class it used to open on. What it may not have is a
      // literal top padding on the element that opens the column — the 34px
      // the Library used to open on was the other half of the seam, and any
      // second number here re-creates it whatever its value.
      expect(tag).not.toMatch(/'[^']*\bpt-/);
      expect(tag).not.toMatch(/"[^"]*\bpt-/);
    }
  });

  it('states the column offset once', () => {
    expect(HEADER_COLUMN_TOP).toMatch(/^pt-[\w.[\]]+$/);
  });
});
