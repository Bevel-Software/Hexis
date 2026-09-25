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
import type { ReactNode } from 'react';
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
import { KbDocumentShell } from '../../workspace/components/KbDocumentShell';
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
 * Every class a tree actually renders, harvested off the DOM.
 *
 * The candidate list has to hold every utility these assertions depend on —
 * Tailwind emits no rule for a class nobody names — and the band wears more
 * than `HEADER_BAND`. The sidebar's row adds `empty:hidden`, which is
 * `SidebarFrame`'s own and the whole of the "a header that draws nothing
 * reserves no band" rule; a list that named it by hand would keep compiling it
 * long after the frame stopped using it, and every assertion below it would
 * pass against a stylesheet describing an app that no longer exists.
 *
 * So the list is READ off a render instead. Rendered here before the
 * stylesheet is in the document, which is fine: this only wants the class
 * attributes, and unmounts before any test runs.
 */
function classesRendered(tree: ReactNode): string[] {
  const { container, unmount } = render(tree);
  const found = new Set<string>();
  for (const element of container.querySelectorAll<HTMLElement>('*')) {
    for (const cls of element.classList) found.add(cls);
  }
  unmount();
  return [...found];
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
  // tomorrow — plus every class a real `SidebarFrame` puts on the row, which
  // is where `empty:hidden` comes from. `HEADER_COLUMN_TOP` rides along
  // because the column's offset is the other half of the seam.
  const css = await compileAppStylesheet([
    ...`${HEADER_BAND} ${HEADER_COLUMN_TOP}`.split(/\s+/),
    ...classesRendered(
      <SidebarFrame label="File explorer" header={<div>Connect your agent</div>}>
        <nav>tree</nav>
      </SidebarFrame>,
    ),
  ]);

  // The compiled output has to CONTAIN the height utility, or the rest of
  // this file is measuring an element with no rule behind it and every
  // `auto === auto` comparison passes. This is the assertion that catches a
  // Tailwind or configuration regression rather than a markup one.
  expect(css).toMatch(/\.h-header\s*\{[^}]*height:\s*var\(--spacing-header\)/);
  // Same for the rule that TAKES the band away again. Without it, the
  // empty-header case below would read an element with no display rule on it
  // and call the band gone on the strength of a default.
  expect(css).toMatch(/:empty\s*\{[^}]*display:\s*none/);
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

/**
 * Both sides of the seam, each in the frame that owns it.
 *
 * The page header goes through `KbDocumentShell`, not straight into the
 * document. That is not ceremony: the header rendered bare is exactly what
 * this file used to assert, and it is why a 54px misalignment on the file
 * page reached staging. A bare header has no column above it, so it cannot
 * be anything but the first row — the test could not see the tab strip that
 * was pushing it down, because in the test the tab strip did not exist.
 *
 * `children` is a stand-in for that tab strip: something the page renders
 * inside the column BESIDE the title bar. If the band ever stops opening the
 * column, this is where it shows.
 */
function renderSeam() {
  return render(
    <>
      <SidebarFrame label="File explorer" header={<div>Connect your agent</div>}>
        <nav>tree</nav>
      </SidebarFrame>
      <KbDocumentShell header={<PageHeader />}>
        <div role="tablist" aria-label="Open files">
          <span>Onboarding.md</span>
        </div>
        <p>The document</p>
      </KbDocumentShell>
    </>,
  );
}

function PageHeader() {
  return (
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
  );
}

const heightOf = (testId: string) =>
  window.getComputedStyle(screen.getByTestId(testId)).height;

/** The column a band opens — the element the band is the first row of. */
const columnOf = (testId: string) => screen.getByTestId(testId).parentElement!;

/**
 * A column's top-padding classes — what decides where its first row starts.
 *
 * Compared between the two columns rather than against a literal: the number
 * lives in `HEADER_COLUMN_TOP` and moving it is allowed, moving it on one
 * side only is the bug.
 */
const offsetClassesOf = (column: Element) =>
  [...column.classList].filter((cls) => cls.startsWith('pt-'));

/**
 * Everything drawn above a band inside its own column.
 *
 * Zero is the contract. Anything here is vertical space between the column's
 * top edge and the band's, which moves the band down by exactly that much and
 * breaks the seam however precisely the two heights agree.
 */
function drawnAbove(testId: string): Element[] {
  const band = screen.getByTestId(testId);
  const siblings: Element[] = [];
  for (let node = band.previousElementSibling; node; node = node.previousElementSibling) {
    siblings.push(node);
  }
  return siblings;
}

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

  it('spends the row on a header that draws', () => {
    render(
      <SidebarFrame label="File explorer" header={<div>Connect your agent</div>}>
        <nav>tree</nav>
      </SidebarFrame>,
    );
    const band = screen.getByTestId(SIDEBAR_HEADER_TESTID);
    expect(band).not.toBeEmptyDOMElement();
    expect(window.getComputedStyle(band).display).not.toBe('none');
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight);
  });

  it('reserves no row for a header that draws nothing', () => {
    // Knowledge and the Library both pass the connect-your-agent pill, which
    // draws NOTHING once onboarding is done. The band used to stay anyway, on
    // the theory that a row coming and going would break the seam — and what
    // it actually did was open the nav a band's height BELOW the page title
    // beside it, for everyone who had finished setting the product up.
    //
    // Measured against the real sheet, not read off the class list: what this
    // has to be true of is the box the browser lays out, and a `hidden`
    // variant that Tailwind stopped emitting would leave the class in place
    // and the strip on the screen.
    const DismissedPill = () => null;
    render(
      <SidebarFrame label="File explorer" header={<DismissedPill />}>
        <nav>tree</nav>
      </SidebarFrame>,
    );
    const band = screen.getByTestId(SIDEBAR_HEADER_TESTID);
    expect(band).toBeEmptyDOMElement();
    expect(window.getComputedStyle(band).display).toBe('none');
  });

  it('opens the nav on the page title band once the header is done drawing', () => {
    // The consequence, in the seam's own terms: with the band gone, the
    // sidebar's first ROW is the first thing in the sidebar's column, and the
    // page's title bar is the first thing in the page's. Both columns open on
    // `HEADER_COLUMN_TOP`, so both start at the same offset — which is AC1's
    // "their top edges align", as structurally as a DOM with no layout engine
    // can put it.
    const DismissedPill = () => null;
    render(
      <>
        <SidebarFrame label="File explorer" header={<DismissedPill />}>
          <nav>Company Context</nav>
        </SidebarFrame>
        <KbDocumentShell header={<PageHeader />}>
          <p>The document</p>
        </KbDocumentShell>
      </>,
    );
    const nav = screen.getByText('Company Context');
    const titleBar = screen.getByTestId(PAGE_HEADER_TESTID);
    const offset = offsetClassesOf(nav.parentElement!);
    // Non-empty first: two columns that have both lost their offset agree
    // about nothing, and an `[] === []` pass is exactly how this assertion
    // would stop noticing.
    expect(offset).toEqual(HEADER_COLUMN_TOP.split(/\s+/));
    expect(offsetClassesOf(titleBar.parentElement!)).toEqual(offset);
    // And nothing between the sidebar column's top edge and that first row
    // takes any height: the collapsed band is all there is, and it is gone.
    for (let node = nav.previousElementSibling; node; node = node.previousElementSibling) {
      expect(window.getComputedStyle(node).display).toBe('none');
    }
    expect(drawnAbove(PAGE_HEADER_TESTID)).toEqual([]);
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

/**
 * The other half of AC1, and the half that reached staging: the two bands
 * have to START at the same place, not merely be the same height.
 *
 * These assertions are STRUCTURAL, and deliberately so. happy-dom has no
 * layout engine — `getBoundingClientRect` answers an all-zero rect for every
 * element — so a top edge is not a thing this suite can measure, and a test
 * that pretended to would compare 0 with 0 and pass through anything. What
 * IS checkable is the two facts that together fix the top edge: each column
 * opens on the same offset, and the band is the first thing in it. Break
 * either and the seam moves; hold both and it cannot.
 *
 * A real browser measured the consequence: Staging Testing put the sidebar
 * band and the library band at y=61 and the file page's at y=115.13, because
 * the file page held the second fact and nothing checked it.
 */
describe('the two bands open at the same offset', () => {
  it('each opens the column it is in — nothing is drawn above either', () => {
    renderSeam();
    expect(drawnAbove(SIDEBAR_HEADER_TESTID)).toEqual([]);
    expect(drawnAbove(PAGE_HEADER_TESTID)).toEqual([]);
  });

  it('the page column holds what used to sit above the band, below it', () => {
    renderSeam();
    const band = screen.getByTestId(PAGE_HEADER_TESTID);
    const tabs = screen.getByRole('tablist', { name: 'Open files' });
    // Same column — the tab strip did not move out of the measure, it moved
    // under the title (proto:700-705 keeps one column; this changes the order
    // inside it).
    expect(tabs.parentElement).toBe(band.parentElement);
    expect(band.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('both columns open on the one shared offset', () => {
    renderSeam();
    // Not "both contain pt-3": both contain the SAME constant, read from the
    // module the app renders, so a change to it moves this test with it.
    for (const testId of [SIDEBAR_HEADER_TESTID, PAGE_HEADER_TESTID]) {
      expect(columnOf(testId).className.split(/\s+/)).toContain(HEADER_COLUMN_TOP);
    }
  });

  it('a full-bleed page opens on that offset too', () => {
    // The variant a PDF, an image or a spreadsheet gets. It gives up the
    // measure and the gutters — it used to give up the offset with them, and
    // its title bar sat a column-offset higher than the sidebar's row.
    render(
      <KbDocumentShell variant="full-bleed" header={<PageHeader />}>
        <iframe title="A PDF" />
      </KbDocumentShell>,
    );
    expect(drawnAbove(PAGE_HEADER_TESTID)).toEqual([]);
    expect(columnOf(PAGE_HEADER_TESTID).className.split(/\s+/)).toContain(HEADER_COLUMN_TOP);
  });

  it('a page with a rail opens on it as well', () => {
    render(
      <KbDocumentShell header={<PageHeader />} rail={<p>About this file</p>}>
        <p>The document</p>
      </KbDocumentShell>,
    );
    expect(drawnAbove(PAGE_HEADER_TESTID)).toEqual([]);
    // Here the offset is on the grid the article sits in, so the band's own
    // parent is the article and the offset is one level up.
    const article = columnOf(PAGE_HEADER_TESTID);
    expect(article.tagName).toBe('ARTICLE');
    expect(article.parentElement!.className.split(/\s+/)).toContain(HEADER_COLUMN_TOP);
  });
});
