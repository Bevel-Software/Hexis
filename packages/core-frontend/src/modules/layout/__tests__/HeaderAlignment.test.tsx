/**
 * The seam: the sidebar's header row and a page's title bar, measured.
 *
 * `shared/theme/__tests__/header-band.test.ts` checks that both sides go
 * through `HEADER_BAND`. That is the contract; this is the consequence — the
 * two rows RENDER to the same height, with the real token, in the same
 * document, at the widths the ticket names.
 *
 * The stylesheet below is not a mock of the design system. It is the two rules
 * Tailwind v4 compiles out of `--spacing-header` (verified against the
 * compiler: a `--spacing-header` in `@theme` emits exactly
 * `.h-header { height: var(--spacing-header) }`), and the token's value is
 * READ OUT of `tokens.css` rather than restated here — so editing the token
 * moves this test with it, and deleting the token fails it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { PAGE_HEADER_TESTID, SIDEBAR_HEADER_TESTID } from '../../../shared/theme/header';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(join(HERE, '..', '..', '..', 'shared', 'theme', 'tokens.css'), 'utf8');

/** The token's literal, off its declaration in the real stylesheet. */
function headerHeight(): string {
  const match = TOKENS.match(/^\s*--spacing-header:\s*([^;]+);/m);
  if (!match) throw new Error('--spacing-header not found in tokens.css');
  return match[1]!.trim();
}

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

beforeAll(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = `
    :root { --spacing-header: ${headerHeight()} }
    .h-header { height: var(--spacing-header) }
  `;
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
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight());
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
      expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight());
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
    expect(heightOf(SIDEBAR_HEADER_TESTID)).toBe(headerHeight());
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
