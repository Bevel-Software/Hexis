import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({ listPullRequestsForMe: vi.fn() }));
vi.mock('../../git/services/pr.api', () => ({
  listPullRequestsForMe: api.listPullRequestsForMe,
}));

import { SidebarFrame } from '../components/SidebarFrame';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setSidebarCollapsed,
  setSidebarNarrow,
  setSidebarWidth,
} from '../state/sidebar';
import { PluginsSidebar } from '../../library/components/PluginsSidebar';
import { IntegrationsSetupReminder } from '../../library/components/IntegrationsSetupReminder';
import { PullRequestsForMe } from '../../git/components/PullRequestsForMe';
import { GitContext, type GitContextValue } from '../../git/state/git.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

/**
 * The sidebar's bottom-left rows, measured against the tree rows above them,
 * at the two widths the ticket names: the default (212px) and the narrowest
 * the drag handle allows (180px).
 *
 * This is the visual regression test, and it is arithmetic rather than a
 * screenshot because there is no CSS engine here: happy-dom parses the
 * markup and resolves no styles at all, so a pixel read off `getBoundingClientRect`
 * would be zero for every element on the page and would agree with any
 * regression whatsoever. What IS in the DOM is the utility classes, and they
 * carry the measure: `px-2.5` is ten pixels wherever it appears. So the test
 * resolves the spacing utilities on the chain from a row up to the sidebar
 * column and compares the sums — the same number a ruler on the screenshot
 * would give, arrived at from the source of the number.
 */

/** Tailwind's spacing scale: one step is 4px, and `[29px]` says what it is. */
function spacingPx(value: string): number {
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value);
  if (arbitrary) return Number(arbitrary[1]);
  return Number(value) * 4;
}

/**
 * How far this element's content sits from the sidebar's left edge: its own
 * left padding plus every ancestor's, up to and including the column that
 * `SidebarFrame` draws (the one carrying the frame's `px-3.5`).
 */
function leftInset(el: Element): number {
  let total = 0;
  for (let node: Element | null = el; node; node = node.parentElement) {
    for (const cls of node.classList) {
      const px = /^p([xl])-(.+)$/.exec(cls);
      if (px) total += spacingPx(px[2]!);
    }
    if (node.hasAttribute('data-sidebar-column')) break;
  }
  return total;
}

/**
 * Every element from `el` up to the sidebar column that would clip a focus
 * ring drawn on `el` — named rather than counted, so a failure says which one
 * appeared. The column itself is the ceiling: what the frame does above it is
 * the collapse animation's business and predates the footer rows.
 */
function clipsBetweenRowAndColumn(el: Element): string[] {
  const found: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('data-sidebar-column')) break;
    for (const cls of node.classList) {
      if (/^overflow(-[xy])?-(hidden|clip|auto|scroll)$/.test(cls)) found.push(cls);
    }
  }
  return found;
}

/** The single spacing utility of a kind on an element, in pixels. */
function spacingOf(el: Element, prefix: string): number | null {
  for (const cls of el.classList) {
    if (cls.startsWith(`${prefix}-`)) return spacingPx(cls.slice(prefix.length + 1));
  }
  return null;
}

function pr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 32,
    title: 'Restate the enforcement wording so it reads as a rule',
    author: { login: 'bevel-bot' },
    appAuthor: { name: 'Ali Raza' },
    branch: 'ali/wording',
    base: 'main',
    state: 'open',
    createdAt: '2026-07-27T00:00:00.000Z',
    touchedNodePaths: ['Knowledge/Foo.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://example.com/pr/32',
    ...over,
  };
}

const git = {
  status: { branch: 'main', hasUpstream: true, unmergedFromUpstream: false },
  branches: [],
  availability: 'ready',
  lastError: null,
  refreshStatus: async () => null,
  refreshBranches: async () => {},
  createBranch: async () => {},
  deleteBranch: async () => {},
  pull: async () => {},
  fetchForkBase: async () => null,
  fetchFileHistory: async () => [],
  fetchFileDiff: async () => '',
  fetchFileAtChange: async () => ({ baseline: null, current: null }),
  fetchFileComparison: async () => '',
} as unknown as GitContextValue;

/**
 * The Library sidebar as it is actually composed: the nav in the frame, the
 * setup reminder and the change-request dock in the frame's footer slot —
 * the arrangement `LibraryLayout` builds.
 */
async function renderSidebarAt(width: number) {
  setSidebarWidth(width);
  const view = render(
    <MemoryRouter>
      <WorkspaceContext.Provider
        value={{ kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue}
      >
        <GitContext.Provider value={git}>
          <SidebarFrame
            label="Library navigation"
            footer={
              <>
                <IntegrationsSetupReminder count={2} onFinishSetup={() => {}} />
                <PullRequestsForMe />
              </>
            }
          >
            <PluginsSidebar
              filter={{ kind: 'all' }}
              onSelect={() => {}}
              ownedCount={2}
              ownedAttention={0}
              teams={[{ name: 'Engineering', count: 4, urgent: 0 }]}
              onCreatePlugin={() => {}}
            />
          </SidebarFrame>
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
  // The dock only exists once the queue has arrived.
  await screen.findByRole('button', { name: 'Change requests for you' });
  return view;
}

const treeRow = () => screen.getByRole('button', { name: /^Everything/ });
const reminder = () => screen.getByRole('button', { name: /setup/ });
const dockHeader = () => screen.getByRole('button', { name: 'Change requests for you' });
const request = () => screen.getByRole('button', { name: /Restate the enforcement/ });
/** Where a request's title actually lands — the row's inset plus its indent. */
const requestText = () => screen.getByText('Restate the enforcement wording so it reads as a rule');

beforeEach(() => {
  api.listPullRequestsForMe.mockReset();
  api.listPullRequestsForMe.mockResolvedValue([
    pr({ number: 32 }),
    pr({ number: 41, title: 'Name the folder after what is in it' }),
  ]);
  window.localStorage.removeItem('bevel-library-sidebar-view');
  setSidebarNarrow(false);
  setSidebarCollapsed(false);
  setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
});

describe.each([
  ['the default width', SIDEBAR_DEFAULT_WIDTH],
  ['the narrowest width', SIDEBAR_MIN_WIDTH],
])('the sidebar footer at %s', (_name, width) => {
  it('puts both footer rows on the tree rows own left inset', async () => {
    await renderSidebarAt(width);

    const tree = leftInset(treeRow());
    // 14px of column padding + the 10px row inset. Stated as a number as
    // well as a comparison: if the grid itself moves, the comparison alone
    // would still pass with all three rows wrong together.
    expect(tree).toBe(24);
    expect(leftInset(reminder())).toBe(tree);
    expect(leftInset(dockHeader())).toBe(tree);
    // A request is a CHILD of that row, indented by the caret slot (12px)
    // and its gap (7px) so it starts under the word "Change". Measured from
    // its TEXT rather than its row: the row sits on the shared inset like
    // every other row, and the indent is inside it.
    expect(leftInset(requestText())).toBe(tree + 19);
    expect(leftInset(request())).toBe(tree);
  });

  it('separates the two rows by one gap, owned by the frame', async () => {
    const { container } = await renderSidebarAt(width);
    const group = container.querySelector('[data-sidebar-footer]') as HTMLElement;

    expect(group).toContainElement(reminder());
    expect(group).toContainElement(dockHeader());
    // One gap for the group, and one rule above it, at a fixed distance from
    // the tree. Each row bringing its own was the reported bug: two hairlines
    // with nothing between them.
    expect(spacingOf(group, 'gap')).toBe(6);
    expect(spacingOf(group, 'mt')).toBe(8);
    expect(spacingOf(group, 'pt')).toBe(8);
    expect(group).toHaveClass('border-t');
    for (const row of [reminder(), dockHeader().parentElement!]) {
      expect(row.className).not.toMatch(/\bborder-t\b|\bmt-\d/);
    }
  });

  it('keeps the count on the CHANGE REQUESTS row hard against the right edge', async () => {
    await renderSidebarAt(width);
    const header = dockHeader();
    const count = within(header).getByText('2');

    expect(header).toHaveClass('flex', 'items-center');
    // Last in the row, and unable to be pushed out of it: the label gives way
    // (`min-w-0 truncate`) and the count does not (`flex-none`).
    expect(header.lastElementChild).toBe(count);
    expect(count).toHaveClass('flex-none');
    expect(screen.getByText('Change requests')).toHaveClass('min-w-0', 'flex-1', 'truncate');
  });

  it('truncates the reminder to an ellipsis and a tooltip, never the link', async () => {
    await renderSidebarAt(width);

    expect(screen.getByText('2 integrations need setup.')).toHaveClass('truncate', 'min-w-0');
    expect(screen.getByText('Finish now')).toHaveClass('flex-none');
    expect(screen.getByText('Finish now')).not.toHaveClass('truncate');
    expect(reminder()).toHaveAttribute('title', '2 integrations need setup. Finish now');
  });

  /**
   * The hit areas the ticket asks to leave alone. Both footer rows are still
   * whole rows — the button IS the row, the way a tree row's is — and neither
   * has grown a nested control or a new clip between itself and the sidebar's
   * column.
   *
   * "Between itself and the column" is the whole claim, and it stops there on
   * purpose. The frame's `<aside>` is `overflow-hidden` and always was: that
   * is what lets the column keep its width and slide out intact while the
   * frame animates to zero, and it clips the tree rows exactly as much as
   * these two. What this PR must not do is add a clip BELOW it, inside the
   * column, where only the footer rows would lose their ring.
   */
  it('leaves both rows as one focusable control each', async () => {
    await renderSidebarAt(width);

    for (const row of [reminder(), dockHeader()]) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.querySelector('button, a, [tabindex]')).toBeNull();
      expect(clipsBetweenRowAndColumn(row)).toEqual([]);
    }
    expect(request()).toHaveAttribute('tabindex', '0');
  });
});

/**
 * The sidebar's own width is the one thing that moves between the two runs
 * above, so it is worth stating that it really did move — otherwise the whole
 * suite could be passing twice at the same width.
 */
it('is measured at two genuinely different widths', async () => {
  const { container, unmount } = await renderSidebarAt(SIDEBAR_DEFAULT_WIDTH);
  expect(container.querySelector('aside')).toHaveStyle({ width: '212px' });
  unmount();

  await waitFor(() => expect(screen.queryByText('Change requests')).toBeNull());
  const narrow = await renderSidebarAt(SIDEBAR_MIN_WIDTH);
  expect(narrow.container.querySelector('aside')).toHaveStyle({ width: '180px' });
});
