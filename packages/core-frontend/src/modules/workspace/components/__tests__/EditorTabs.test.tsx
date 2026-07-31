import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { EditorTabs } from '../EditorTabs';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
  type OpenTab,
} from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';

function makeTab(path: string, overrides: Partial<OpenTab> = {}): OpenTab {
  const content = overrides.content ?? `content:${path}`;
  return {
    path,
    content,
    savedContent: content,
    isDirty: false,
    pendingFileContent: null,
    ...overrides,
  };
}

function makeWorkspace(
  tabs: OpenTab[],
  activePath: string | null,
  overrides: Partial<WorkspaceContextValue> = {},
): WorkspaceContextValue {
  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  return makeWorkspaceFixture({
    openTabs: tabs,
    activeTab,
    dirtyTabFilenames: tabs.filter((t) => t.isDirty).map((t) => {
      const i = t.path.lastIndexOf('/');
      return i >= 0 ? t.path.slice(i + 1) : t.path;
    }),
    openFilePath: activeTab?.path ?? null,
    openFileContent: activeTab?.content ?? null,
    openFileSavedContent: activeTab?.savedContent ?? null,
    hasUnsavedFileChanges: tabs.some((t) => t.isDirty),
    pendingFileContent: activeTab?.pendingFileContent ?? null,
    ...overrides,
  });
}

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// useFileNav reads gitState.status.branch from GitContext. To keep these
// tests focused on the tab strip, stub useFileNav directly.
vi.mock('../../routing/kb-routes', () => ({
  useFileNav: () => ({
    openFile: (path: string) => mockNavigate(path),
    closeFile: () => mockNavigate(null),
  }),
}));

function Wrap({ workspace, children }: { workspace: WorkspaceContextValue; children: ReactNode }) {
  return (
    <MemoryRouter>
      <WorkspaceContext.Provider value={workspace}>
        {children}
      </WorkspaceContext.Provider>
    </MemoryRouter>
  );
}

describe('EditorTabs', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no tabs are open', () => {
    const ws = makeWorkspace([], null);
    const { container } = render(<Wrap workspace={ws}><EditorTabs /></Wrap>);
    expect(container.firstChild).toBeNull();
  });

  it('renders all tabs in order with the active one highlighted', () => {
    const tabs = [makeTab('a.md'), makeTab('Knowledge/b.md'), makeTab('c.md')];
    const ws = makeWorkspace(tabs, 'Knowledge/b.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    const allTabs = screen.getAllByRole('tab');
    const filenames = allTabs.map((el) => el.querySelector('.truncate')?.textContent ?? '');
    expect(filenames).toEqual(['a.md', 'b.md', 'c.md']);
    const activeTab = allTabs[1];
    expect(activeTab.getAttribute('aria-selected')).toBe('true');
  });

  it('shows a dirty dot when a tab has unsaved changes', () => {
    const tabs = [makeTab('a.md', { isDirty: true })];
    const ws = makeWorkspace(tabs, 'a.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
  });

  it('shows the AI badge when a tab has pending agent content', () => {
    const tabs = [makeTab('a.md', { pendingFileContent: 'agent says hi' })];
    const ws = makeWorkspace(tabs, 'a.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);
    expect(screen.getByLabelText('Agent has pending changes')).toBeInTheDocument();
  });

  it('clicking a tab navigates via useFileNav', async () => {
    const user = userEvent.setup();
    const tabs = [makeTab('a.md'), makeTab('b.md')];
    const ws = makeWorkspace(tabs, 'a.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    const tabB = screen.getAllByRole('tab')[1];
    await user.click(tabB);
    expect(mockNavigate).toHaveBeenCalledWith('b.md');
  });

  it('clicking the close button closes that tab', async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn<WorkspaceContextValue['closeTab']>(async () => ({ closed: true, newActivePath: null }));
    const tabs = [makeTab('a.md'), makeTab('b.md')];
    const ws = makeWorkspace(tabs, 'a.md', { closeTab });
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    const closeBtn = screen.getByLabelText('Close b.md');
    await user.click(closeBtn);
    expect(closeTab).toHaveBeenCalledWith(tabs[1]);
    // The tab onClick (activate) should NOT fire when clicking close.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('right-click opens the context menu with bulk-close actions', async () => {
    const tabs = [makeTab('a.md'), makeTab('b.md'), makeTab('c.md')];
    const ws = makeWorkspace(tabs, 'b.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    const tabB = screen.getAllByRole('tab')[1];
    fireEvent.contextMenu(tabB);

    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Close')).toBeInTheDocument();
    expect(within(menu).getByText('Close others')).toBeInTheDocument();
    expect(within(menu).getByText('Close tabs to the right')).toBeInTheDocument();
    expect(within(menu).getByText('Close all')).toBeInTheDocument();
  });

  it('Escape closes the context menu', async () => {
    const tabs = [makeTab('a.md')];
    const ws = makeWorkspace(tabs, 'a.md');
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('"Close others" closes every other tab via skipConfirm', async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn<WorkspaceContextValue['closeTab']>(async () => ({ closed: true, newActivePath: null }));
    const tabs = [makeTab('a.md'), makeTab('b.md'), makeTab('c.md')];
    const ws = makeWorkspace(tabs, 'b.md', { closeTab });
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    fireEvent.contextMenu(screen.getAllByRole('tab')[1]); // right-click on b
    await user.click(screen.getByText('Close others'));

    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab.mock.calls[0]).toEqual([tabs[0], { skipConfirm: true }]);
    expect(closeTab.mock.calls[1]).toEqual([tabs[2], { skipConfirm: true }]);
  });

  it('"Close tabs to the right" only closes tabs after the target', async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn<WorkspaceContextValue['closeTab']>(async () => ({ closed: true, newActivePath: null }));
    const tabs = [makeTab('a.md'), makeTab('b.md'), makeTab('c.md')];
    const ws = makeWorkspace(tabs, 'a.md', { closeTab });
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    fireEvent.contextMenu(screen.getAllByRole('tab')[0]); // right-click on a
    await user.click(screen.getByText('Close tabs to the right'));

    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab.mock.calls[0][0]).toEqual(tabs[1]);
    expect(closeTab.mock.calls[1][0]).toEqual(tabs[2]);
  });

  it('bulk close shows ONE confirm when multiple tabs are dirty', async () => {
    const user = userEvent.setup();
    const closeTab = vi.fn<WorkspaceContextValue['closeTab']>(async () => ({ closed: true, newActivePath: null }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tabs = [
      makeTab('a.md', { isDirty: true }),
      makeTab('b.md'),
      makeTab('c.md', { isDirty: true }),
    ];
    const ws = makeWorkspace(tabs, 'b.md', { closeTab });
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    fireEvent.contextMenu(screen.getAllByRole('tab')[1]); // right-click on b
    await user.click(screen.getByText('Close all'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/a\.md/);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/c\.md/);
    // All three tabs requested for close, with skipConfirm.
    expect(closeTab).toHaveBeenCalledTimes(3);
  });

  it('reorders via drag and drop', () => {
    const reorderTab = vi.fn();
    const tabs = [makeTab('a.md'), makeTab('b.md'), makeTab('c.md')];
    const ws = makeWorkspace(tabs, 'a.md', { reorderTab });
    render(<Wrap workspace={ws}><EditorTabs /></Wrap>);

    const [tabA, , tabC] = screen.getAllByRole('tab');
    const dataTransfer = {
      setData: vi.fn(),
      getData: vi.fn(() => 'a.md'),
      types: ['application/x-bevel-tab-path'],
      effectAllowed: 'move',
      dropEffect: 'move',
    };

    fireEvent.dragStart(tabA, { dataTransfer });
    fireEvent.dragEnter(tabC, { dataTransfer });
    fireEvent.dragOver(tabC, { dataTransfer });
    fireEvent.drop(tabC, { dataTransfer });

    expect(reorderTab).toHaveBeenCalledWith(tabs[0], 2);
  });
});
