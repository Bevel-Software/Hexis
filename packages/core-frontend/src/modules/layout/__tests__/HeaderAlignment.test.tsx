/**
 * The seam: the sidebar's header row and a page's title bar, measured.
 *
 * `shared/theme/__tests__/header-band.test.ts` checks that both sides go
 * through `HEADER_BAND`. That is the contract; this is the consequence — the
 * two rows RENDER to the same height, with the real token, in the same
 * document, at the widths the ticket names.
 *
 * The stylesheet under these assertions is the PRODUCTION one. `src/index.css`
 * — the app's real entry, Tailwind and the design tokens and the typography
 * plugin — is handed to Tailwind's own compiler here and the CSS it emits is
 * what the document is measured against. Nothing about the height is restated
 * in this file: not the token's value, not the `.h-header` rule. A token
 * renamed, a token moved out of `@theme`, a `@import` dropped from the entry,
 * an upgrade that changes how a `--spacing-*` token compiles — each of those
 * is a real regression of this seam, and each of them fails here, because the
 * rule the browser would get is the rule this test gets.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'tailwindcss';
import { SidebarFrame } from '../components/SidebarFrame';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setSidebarCollapsed,
  setSidebarNarrow,
  setSidebarWidth,
  toggleSidebar,
} from '../state/sidebar';
import { KbPageHeader } from '../../workspace/components/KbPageHeader';
import {
  HEADER_BAND,
  HEADER_COLUMN_TOP,
  PAGE_HEADER_TESTID,
  SIDEBAR_HEADER_TESTID,
} from '../../../shared/theme/header';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/`, three levels up from `modules/layout/__tests__`. */
const SRC = join(HERE, '..', '..', '..');
/** The application's real stylesheet entry — what `apps/web` imports. */
const APP_STYLESHEET = join(SRC, 'index.css');
/** Resolved from the package root, so pnpm's symlinked tree answers. */
const requirePackage = createRequire(join(SRC, '..', 'package.json'));

/**
 * The app's CSS, compiled by Tailwind exactly as the build does it.
 *
 * `build()` takes the class names the app uses; a utility nobody names is a
 * utility Tailwind does not emit, which is the whole point of the engine and
 * the reason this has to be told what the band wears. It is told by READING
 * `HEADER_BAND` — so the classes compiled here can never drift from the
 * classes rendered below.
 */
async function compileAppStylesheet(candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(APP_STYLESHEET, 'utf8'), {
    base: dirname(APP_STYLESHEET),
    loadStylesheet: async (id, base) => {
      // `@import 'tailwindcss'` is a package, not a path; everything else in
      // this tree is relative to the file that imported it.
      const path =
        id === 'tailwindcss' ? requirePackage.resolve('tailwindcss/index.css') : resolve(base, id);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
    loadModule: async (id, base) => {
      const path = requirePackage.resolve(id, { paths: [base] });
      const loaded: { default?: unknown } = await import(path);
      return { path, base: dirname(path), module: loaded.default ?? loaded };
    },
  });
  return compiler.build(candidates);
}

/**
 * Unwrap `@layer` — the one edit this file makes to the compiler's output.
 *
 * happy-dom does not implement cascade layers: it parses `@layer utilities {
 * … }` and then matches nothing inside it, so every rule Tailwind emits would
 * be invisible and every height would read `''`. Unwrapping is safe to do
 * here and nowhere else, because the compiled sheet is the ONLY stylesheet in
 * the document — layers order rules against each other, and with one sheet
 * and one rule per property there is nothing to order. The declarations
 * themselves are untouched; this moves braces, never values.
 */
function flattenCascadeLayers(css: string): string {
  // `@layer theme, base, components, utilities;` — the ordering statement,
  // which has no block and nothing to unwrap.
  let out = css.replace(/@layer[^;{]*;/g, '');
  for (;;) {
    const opener = /@layer[^;{]*\{/.exec(out);
    if (!opener) return out;
    // Walk to the matching close brace: the block holds nested rules, so the
    // first `}` after it is almost never the right one.
    let depth = 0;
    let end = -1;
    for (let i = opener.index + opener[0].length - 1; i < out.length; i++) {
      if (out[i] === '{') depth++;
      else if (out[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error('unbalanced @layer block in the compiled stylesheet');
    out =
      out.slice(0, opener.index) +
      out.slice(opener.index + opener[0].length, end) +
      out.slice(end + 1);
  }
}

/**
 * `--spacing-header` as the BUILD resolves it, read back out of the compiled
 * CSS. Not out of `tokens.css`: a value a test parses from source is a value
 * the test has decided for itself, and what the seam depends on is the one
 * the browser is served. Every assertion below compares against this, so
 * there is no second copy of the number anywhere in the file.
 */
function tokenHeightIn(css: string): string {
  const match = css.match(/--spacing-header:\s*([^;]+);/);
  if (!match) throw new Error('the compiled stylesheet declares no --spacing-header');
  return match[1]!.trim();
}

let headerHeight: string;

/** The ticket's three desktop widths. */
const WIDTHS = [1280, 1440, 1920];

/**
 * Move the viewport. happy-dom answers `matchMedia` out of `innerWidth`, so
 * this is how a test reaches a given desktop width — there is no window to
 * resize. Same helper `SidebarFrameResponsive` uses to cross the narrow
 * breakpoint.
 */
function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

let stylesheet: HTMLStyleElement;

beforeAll(async () => {
  // The candidates are the band's own classes, read off the constant the app
  // renders — `flex h-header flex-none items-center` today, whatever it says
  // tomorrow. `HEADER_COLUMN_TOP` rides along because the column's offset is
  // the other half of the seam.
  const css = await compileAppStylesheet(`${HEADER_BAND} ${HEADER_COLUMN_TOP}`.split(/\s+/));

  // The compiled output has to CONTAIN the height utility, or the rest of
  // this file is measuring an element with no rule behind it and every
  // `auto === auto` comparison passes. This is the assertion that catches a
  // Tailwind or configuration regression rather than a markup one.
  expect(css).toMatch(/\.h-header\s*\{[^}]*height:\s*var\(--spacing-header\)/);
  headerHeight = tokenHeightIn(css);

  stylesheet = document.createElement('style');
  stylesheet.textContent = flattenCascadeLayers(css);
  document.head.appendChild(stylesheet);
});

afterAll(() => stylesheet.remove());

beforeEach(() => {
  // A desktop width, an open sidebar, the default column — the state the seam
  // is about. The store is module-global, so a case that collapses or drags
  // the sidebar would otherwise hand the next one a narrow drawer.
  setViewportWidth(WIDTHS[1]!);
  setSidebarNarrow(false);
  setSidebarCollapsed(false);
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
});

function renderSeam() {
  return render(
    <>
      <SidebarFrame label="File explorer" header={<div>Connect your agent</div>}>
        <nav>tree</nav>
      </SidebarFrame>
      <KbPageHeader
        path="Knowledge/Onboarding.md"
        canWrite
        editMode={false}
        entering={false}
        proposeMode={false}
        proposalBusy={false}
        onPropose={() => {}}
        onSendProposal={() => {}}
        onDiscardProposal={() => {}}
        lockedBy={null}
        historyAvailable
        isDirty={false}
        waitingOnAgentUpdate={false}
        isReviewingPending={false}
        activeTab="content"
        onEdit={() => {}}
        onDone={() => {}}
        onOpenHistory={() => {}}
        onShare={() => {}}
        onCopyLink={async () => true}
      />
    </>,
  );
}

const heightOf = (testId: string) =>
  window.getComputedStyle(screen.getByTestId(testId)).height;

describe('the sidebar header row and the page title bar', () => {
  it.each(WIDTHS)('are the same height at %ipx wide', (width) => {
    setViewportWidth(width);
    renderSeam();

    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(heightOf(PAGE_HEADER_TESTID));
    // And it is the TOKEN's height, not two elements agreeing on `auto`:
    // `auto === auto` would pass the line above while the page rendered as
    // broken as it did before the fix.
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight);
  });

  it('keeps the page title bar the same height while the sidebar collapses and reopens', () => {
    renderSeam();
    const open = heightOf(PAGE_HEADER_TESTID);

    // Collapsing is a WIDTH change on the frame; nothing about it may reach
    // the height of either header. The sidebar's own row goes with it, so the
    // assertion that matters on the way through is the page's.
    toggleSidebar();
    expect(heightOf(PAGE_HEADER_TESTID)).toBe(open);
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(open);

    toggleSidebar();
    expect(heightOf(PAGE_HEADER_TESTID)).toBe(open);
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(open);
  });

  it('keeps both heights while the sidebar is being resized', () => {
    renderSeam();

    // The narrowest the frame allows, a width in the middle, and the widest —
    // the span a drag covers. The header row is `w-full` inside the column,
    // so a width that changed its height would mean the row had started
    // wrapping: the failure the band and the title's `truncate` prevent.
    // `false` is the mid-drag write, the one that does not persist.
    for (const width of [SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH]) {
      setSidebarWidth(width, false);
      expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(heightOf(PAGE_HEADER_TESTID));
      expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight);
    }
  });

  it('reserves the row for a header that draws nothing', () => {
    // Knowledge and the Library both pass the connect-your-agent pill, which
    // renders NOTHING once onboarding is done. If the row collapsed with it,
    // the page's title bar would be left lined up against a nav that had
    // moved a band's height up — the seam would break for exactly the people
    // who have finished setting the product up.
    const DismissedPill = () => null;
    render(
      <SidebarFrame label="File explorer" header={<DismissedPill />}>
        <nav>tree</nav>
      </SidebarFrame>,
    );
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight);
  });

  it('renders no band for a surface that declares no header', () => {
    // Settings fills the same frame with no header slot and has no title bar
    // on the other side of the seam. A band there would be a band's worth of
    // empty space above its nav, holding a line with nothing.
    render(
      <SidebarFrame label="Settings">
        <nav>settings</nav>
      </SidebarFrame>,
    );
    expect(screen.queryByTestId(SIDEBAR_HEADER_TESTID)).toBeNull();
  });
});
