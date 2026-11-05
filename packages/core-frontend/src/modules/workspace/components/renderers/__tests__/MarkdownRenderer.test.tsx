import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';
import { makeWorkspaceFixture } from '../../../__tests__/testFixtures';
import { GitContext, type GitContextValue } from '../../../../git/state/git.context';
import { MarkdownRenderer } from '../MarkdownRenderer';

// Capture navigation so we can assert link clicks resolve + open the right
// file. The router's `navigate` is stubbed rather than the nav hook, so the
// real resolution (`resolveKbHref` → `kbFileUrl`) is exercised end to end.
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

/** The router's location, as text — what a link inside the file must not change. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

/** `window.open` answering with a tab, as a browser does when it opens one. */
function stubWindowOpen() {
  return vi.spyOn(window, 'open').mockImplementation(() => ({ opener: window }) as unknown as Window);
}

function makeGit(): GitContextValue {
  return {
    status: { branch: 'alice/draft', hasUpstream: true, unmergedFromUpstream: false },
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
  };
}

function makeWorkspace(): WorkspaceContextValue {
  const tab = {
    path: 'Knowledge/Foo.md',
    content: '# Hello',
    savedContent: '# Hello',
    isDirty: false,
    pendingFileContent: null,
  };
  return makeWorkspaceFixture({
    openTabs: [tab],
    activeTab: tab,
    openFilePath: 'Knowledge/Foo.md',
    openFileContent: '# Hello',
    openFileSavedContent: '# Hello',
  });
}

function renderMarkdown(
  onSave: (content: string) => Promise<void>,
  hooks: {
    onDirtyChange?: (dirty: boolean) => void;
    onSaveStateChange?: (state: 'idle' | 'saving' | 'error') => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <WorkspaceContext.Provider value={makeWorkspace()}>
        <GitContext.Provider value={makeGit()}>
          <MarkdownRenderer
            content="hello"
            filePath="Knowledge/Foo.md"
            onSave={onSave}
            onDirtyChange={hooks.onDirtyChange}
            onSaveStateChange={hooks.onSaveStateChange}
          />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

describe('MarkdownRenderer', () => {
  // Mode is now fully driven by the parent's `readOnly` prop. `renderMarkdown`
  // omits the prop, so the default (`readOnly={false}`) renders the textarea
  // directly — no internal "Edit" toggle to click. The renderer's old
  // edit/preview tabs were removed to avoid conflicting with the FileViewer's
  // top-level Edit/Done button.

  it('does NOT save on blur', async () => {
    // Auto-save-on-blur was removed when multi-tabs landed: with cache-per-tab,
    // every tab click blurs the textarea, and silently flushing to disk on
    // every switch is the wrong behavior. Saves must be explicit (Cmd+S or a
    // closeTab confirm).
    const onSave = vi.fn(async () => {});
    renderMarkdown(onSave);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.blur(textarea);

    // Wait a tick to make sure no async save fires.
    await new Promise((r) => setTimeout(r, 50));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves on Ctrl/Cmd+S', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    renderMarkdown(onSave);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, ' world');
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('hello world');
    });
  });

  it('keeps edits dirty and shows a stable error message after save failure (does not leak raw error)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      // Raw error contains text that would be unfriendly / leaky to render
      // — the renderer must not surface it; only a stable user-facing
      // message belongs in the DOM.
      throw new Error('lock-not-held: internal path /tmp/foo');
    });
    renderMarkdown(onSave);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, ' world');
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('hello world');
    });
    // Stable, user-facing message — backend detail is in console only.
    const errorNode = await screen.findByRole('alert');
    expect(errorNode).toHaveTextContent("Couldn't save your changes. Try again in a moment.");
    expect(screen.queryByText(/lock-not-held/)).toBeNull();
    expect(screen.queryByText(/\/tmp\/foo/)).toBeNull();
    // Dirty buffer survives — the user's edits are still in the textarea
    // so they can retry without losing work.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello world');
  });

  // --- Paste makes a link ---

  function paste(textarea: HTMLElement, text: string) {
    fireEvent.paste(textarea, { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  }

  function editorWith(value: string, selection: [number, number]) {
    const onValueChange = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer content={value} filePath="Knowledge/Foo.md" onSave={async () => {}} onValueChange={onValueChange} />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.setSelectionRange(...selection);
    return { textarea, onValueChange };
  }

  it('pasting a bare workspace path with no selection inserts a root-anchored link named after the file', () => {
    const { textarea, onValueChange } = editorWith('See  here', [4, 4]);
    paste(textarea, '/knowledge-base/KnowledgeBase/File Type examples/subfile.md');
    const expected = 'See [subfile](</knowledge-base/KnowledgeBase/File Type examples/subfile.md>) here';
    expect(textarea.value).toBe(expected);
    expect(onValueChange).toHaveBeenCalledWith(expected);
  });

  it('pasting a URL with no selection inserts a link labelled with host and path', () => {
    const { textarea } = editorWith('', [0, 0]);
    paste(textarea, 'https://example.com/docs/guide?x=1');
    expect(textarea.value).toBe('[example.com/docs/guide](https://example.com/docs/guide?x=1)');
  });

  it('pasting with a selection makes the selection the label', () => {
    const { textarea } = editorWith('read the guide now', [9, 14]);
    paste(textarea, '/knowledge-base/Knowledge/Guide.md');
    expect(textarea.value).toBe('read the [guide](/knowledge-base/Knowledge/Guide.md) now');
  });

  it('pasting ordinary text is left to the browser', () => {
    const { textarea, onValueChange } = editorWith('hello', [5, 5]);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { getData: () => 'just some words' } });
    fireEvent(textarea, event);
    expect(event.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('hello');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  // --- Link rendering in preview (readOnly) mode ---

  // `at` is the address this tab is on — a file page, or the same page in
  // full screen. The probe shows the router's location, which a link inside
  // the file must leave as it was.
  function renderPreview(content: string, filePath: string, at = `/workspace/alice%2Fdraft/${filePath}`) {
    return render(
      <MemoryRouter initialEntries={[at]}>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer content={content} filePath={filePath} onSave={async () => {}} readOnly />
            <LocationProbe />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
  }

  /**
   * A link inside the file opened `url` in a new tab, and this tab went
   * nowhere. The anchor names the same address with `target="_blank"`, so a
   * middle-click or the context menu opens what the click opened.
   */
  async function expectOpensInNewTab(name: string, url: string) {
    navigateMock.mockClear();
    const open = stubWindowOpen();
    const before = screen.getByTestId('location').textContent;
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
    await userEvent.setup().click(link);
    expect(open).toHaveBeenCalledWith(url, '_blank');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe(before);
    open.mockRestore();
  }

  it('opens a nodeType frontmatter link in a new tab', async () => {
    renderPreview(
      '---\nnodeType: "[Process](../NodeTypes/Process.md)"\n---\n\n# Body',
      'Knowledge/Sub/Foo.md',
    );
    await expectOpensInNewTab('Process', '/workspace/alice%2Fdraft/Knowledge/NodeTypes/Process.md');
  });

  it('opens a bare body link whose path contains spaces in a new tab', async () => {
    renderPreview('[Open](Some File.md)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Open', '/workspace/alice%2Fdraft/Knowledge/Some%20File.md');
  });

  it('opens an angle-bracketed body link with spaces in a new tab', async () => {
    renderPreview('[Open](<Some File.md>)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Open', '/workspace/alice%2Fdraft/Knowledge/Some%20File.md');
  });

  // The link a paste wraps a Copy path in: root-anchored, so it opens the same
  // file however deep the linking page sits.
  it('opens a pasted root-anchored link from a file in a different folder', async () => {
    renderPreview(
      '[subfile](</knowledge-base/KnowledgeBase/File Type examples/subfile.md>)',
      'knowledge-base/KnowledgeBase/Other/Deep/parent.md',
    );
    await expectOpensInNewTab(
      'subfile',
      '/workspace/alice%2Fdraft/knowledge-base/KnowledgeBase/File%20Type%20examples/subfile.md',
    );
  });

  it('keeps the branch of an absolute citation URL instead of resolving it against the file', async () => {
    renderPreview('[Cited](/workspace/target-company-state/knowledge-base/GTM/Bundle.md#status)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Cited', '/workspace/target-company-state/knowledge-base/GTM/Bundle.md#status');
  });

  // Once the hook resolves targets, a workspace link that is not a `.md` is
  // the app's too: left to the browser it was a relative URL that replaced
  // the page being read.
  it('opens a link to an HTML page of the workspace in a new tab', async () => {
    renderPreview('[Board](../Dashboards/Board.html)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Board', '/workspace/alice%2Fdraft/Dashboards/Board.html');
  });

  // A scheme is what makes a link external, not a name that starts `http`:
  // judged by prefix, this page of the workspace was left to the browser as a
  // relative URL that replaced the page being read.
  it('opens a relative link to a file whose name starts with http in a new tab', async () => {
    renderPreview('[Notes](http-notes.md)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Notes', '/workspace/alice%2Fdraft/Knowledge/http-notes.md');
  });

  it('opens an id-link in a new tab at the node URL, heading kept', async () => {
    renderPreview('[Plan](plan-node#goal)', 'Knowledge/Foo.md');
    await expectOpensInNewTab('Plan', '/workspace/alice%2Fdraft/plan-node#goal');
  });

  // Full screen is this tab's view, asked for by its query. The new tab gets
  // the target's plain address, and this one keeps `?fullscreen=1`.
  it('in full screen, opens the plain address in a new tab and stays full screen', async () => {
    renderPreview('[Open](Other.md)', 'Knowledge/Foo.md', '/workspace/alice%2Fdraft/Knowledge/Foo.md?fullscreen=1');
    expect(screen.getByTestId('location')).toHaveTextContent('?fullscreen=1');
    await expectOpensInNewTab('Open', '/workspace/alice%2Fdraft/Knowledge/Other.md');
    expect(screen.getByTestId('location')).toHaveTextContent('?fullscreen=1');
  });

  it('in full screen, opens an id-link in a new tab at the plain node URL', async () => {
    renderPreview('[Plan](plan-node)', 'Knowledge/Foo.md', '/workspace/alice%2Fdraft/foo-node?fullscreen=1');
    await expectOpensInNewTab('Plan', '/workspace/alice%2Fdraft/plan-node');
  });

  // A section link is the browser's: a plain fragment anchor, no new tab.
  it('leaves a same-file anchor to scroll in place', async () => {
    renderPreview('[Goal](#goal)', 'Knowledge/Foo.md');
    const open = stubWindowOpen();
    const link = screen.getByRole('link', { name: 'Goal' });
    expect(link).toHaveAttribute('href', '#goal');
    expect(link).not.toHaveAttribute('target');
    await userEvent.setup().click(link);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // The same section written as a path to this file: this tab moves by its
  // fragment only, on its own address and query — full screen stays.
  it('scrolls a link to a section of this file in place, keeping the address and query', async () => {
    navigateMock.mockClear();
    renderPreview('[Goal](Foo.md#goal)', 'Knowledge/Foo.md', '/workspace/alice%2Fdraft/foo-node?fullscreen=1');
    const open = stubWindowOpen();
    const link = screen.getByRole('link', { name: 'Goal' });
    expect(link).toHaveAttribute('href', '/workspace/alice%2Fdraft/foo-node?fullscreen=1#goal');
    expect(link).not.toHaveAttribute('target');
    await userEvent.setup().click(link);
    expect(navigateMock).toHaveBeenCalledWith('/workspace/alice%2Fdraft/foo-node?fullscreen=1#goal');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // ...and on that address the page scrolls the heading the fragment names
  // into view: the other half of "a section link scrolls in place".
  it('scrolls the heading a section address names into view, in full screen too', async () => {
    const original = Element.prototype.scrollIntoView;
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      renderPreview('# Intro\n\n## Goal\n\nText', 'Knowledge/Foo.md', '/workspace/alice%2Fdraft/foo-node?fullscreen=1#goal');
      await waitFor(() => expect(scrolled).toEqual(['goal']));
      expect(screen.getByTestId('location').textContent).toBe('/workspace/alice%2Fdraft/foo-node?fullscreen=1#goal');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  // Ctrl/⌘/Shift-click on a new-tab link is the browser's to answer, as for
  // any `target="_blank"` anchor: the app neither cancels it nor opens a tab.
  it('leaves a modifier-click on a link to the browser', () => {
    renderPreview('[Open](Other.md)', 'Knowledge/Foo.md');
    const open = stubWindowOpen();
    const link = screen.getByRole('link', { name: 'Open' });
    // Read once the app's handlers have all had the click, then cancelled so
    // the test DOM does not go and fetch the link itself.
    const leftToBrowser: boolean[] = [];
    const after = (e: Event) => {
      leftToBrowser.push(!e.defaultPrevented);
      e.preventDefault();
    };
    window.addEventListener('click', after);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifier }));
    }
    window.removeEventListener('click', after);
    expect(leftToBrowser).toEqual([true, true, true]);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // A section link carries this tab's own address too, so a Ctrl-click or a
  // middle-click on it is the browser's: it opens that section where the
  // reader asked, and this tab does not move.
  it('leaves a modified or middle click on a section link to the browser', () => {
    navigateMock.mockClear();
    renderPreview('[Goal](Foo.md#goal)', 'Knowledge/Foo.md', '/workspace/alice%2Fdraft/foo-node?fullscreen=1');
    const open = stubWindowOpen();
    const link = screen.getByRole('link', { name: 'Goal' });
    const leftToBrowser: boolean[] = [];
    const after = (e: Event) => {
      leftToBrowser.push(!e.defaultPrevented);
      e.preventDefault();
    };
    window.addEventListener('click', after);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    }
    window.removeEventListener('click', after);
    expect(leftToBrowser).toEqual([true, true, true, true]);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  // The node on screen is known by its id, not read off the address: a tab
  // still on the file's PATH URL (not canonicalized yet, or a library frame
  // that never canonicalizes) keeps an id-link to this node in place.
  it('scrolls an id-link to the node on screen in place while the tab is on its path URL', async () => {
    navigateMock.mockClear();
    const filePath = 'Knowledge/OnPath.md';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/resolve-path?')
        ? new Response(JSON.stringify({ id: 'on-path-node' }), { status: 200 })
        : new Response('', { status: 404 }),
    );
    try {
      renderPreview('[Goal](on-path-node#goal) [Plan](plan-node)', filePath, `/workspace/alice%2Fdraft/${filePath}?fullscreen=1`);
      const here = `/workspace/alice%2Fdraft/${filePath}?fullscreen=1#goal`;
      await waitFor(() => expect(screen.getByRole('link', { name: 'Goal' })).toHaveAttribute('href', here));
      expect(screen.getByRole('link', { name: 'Goal' })).not.toHaveAttribute('target');
      const open = stubWindowOpen();
      await userEvent.setup().click(screen.getByRole('link', { name: 'Goal' }));
      expect(navigateMock).toHaveBeenCalledWith(here);
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
      // Another node is still another tab.
      await expectOpensInNewTab('Plan', '/workspace/alice%2Fdraft/plan-node');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // --- Images in preview mode ---

  it('serves a relative image from the raw file route of the current workspace, resolved against the file', () => {
    renderPreview('![Shot](./assets/shot.png)', 'Knowledge/Sub/Foo.md');
    expect(screen.getByRole('img', { name: 'Shot' })).toHaveAttribute(
      'src',
      '/api/workspace/ws-1/file/raw?path=Knowledge%2FSub%2Fassets%2Fshot.png',
    );
  });

  it('serves an absolute workspace image URL by its path, from the current workspace (the branch rule)', () => {
    renderPreview('![Shot](/workspace/other-branch/knowledge-base/assets/shot.png)', 'Knowledge/Foo.md');
    expect(screen.getByRole('img', { name: 'Shot' })).toHaveAttribute(
      'src',
      '/api/workspace/ws-1/file/raw?path=knowledge-base%2Fassets%2Fshot.png',
    );
  });

  // --- Background autosave must not disturb the editing UI (BEVA ticket) ---

  // The autosave checkpoint round-trips the buffer back through the `content`
  // prop and advances `savedContent`; on commit the bytes can be line-ending-
  // normalized so they differ slightly from what's in the textarea. The editor
  // must treat itself as the source of truth while editing and NOT re-assign the
  // textarea from that echo — doing so yanked the caret to the end and scrolled
  // the document to the top ("it always jumped to the start of the document").
  function renderEditable(content: string, savedContent: string) {
    const onSave = vi.fn(async () => {});
    const ui = (c: string, s: string) => (
      <MemoryRouter>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer
              content={c}
              savedContent={s}
              filePath="Knowledge/Foo.md"
              onSave={onSave}
              readOnly={false}
            />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );
    const utils = render(ui(content, savedContent));
    return { ...utils, rerender: (c: string, s: string) => utils.rerender(ui(c, s)) };
  }

  it('keeps the editing caret and buffer stable when an autosave advances savedContent + re-emits normalized content', () => {
    const buffer = 'line A\nline B\nline C';
    const { rerender } = renderEditable(buffer, buffer);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    // Caret parked in the middle of "line B".
    textarea.setSelectionRange(9, 9);

    // Autosave round-trip: checkpoint commits the buffer, the parent re-renders
    // with savedContent advanced to match AND content re-emitted with a commit-
    // time trailing-newline normalization (bytes differ from the live buffer).
    const normalized = `${buffer}\n`;
    rerender(normalized, normalized);

    // The editor owns `value` while editing: no overwrite, no caret jump.
    expect(textarea.value).toBe(buffer);
    expect(textarea.selectionStart).toBe(9);
    expect(textarea.selectionEnd).toBe(9);
  });

  it('still mirrors new content into the buffer in read-only preview mode (external updates show immediately)', () => {
    const onSave = vi.fn(async () => {});
    const ui = (content: string) => (
      <MemoryRouter>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer content={content} filePath="Knowledge/Foo.md" onSave={onSave} readOnly />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );
    const { rerender } = render(ui('# One'));
    expect(screen.getByText('One')).toBeInTheDocument();
    rerender(ui('# Two'));
    expect(screen.getByText('Two')).toBeInTheDocument();
    expect(screen.queryByText('One')).toBeNull();
  });

  it('keeps the save-state strip while a manual save is pending, even when an autosave echo advances savedContent', async () => {
    // A background autosave checkpoint can advance `content`/`savedContent`
    // (the parent re-renders) while the user's explicit Ctrl/Cmd+S is still
    // in flight. The transient-save-UI reset effect must NOT flip 'saving'
    // back to 'idle' in that window — `save()` owns the exit from 'saving'.
    const user = userEvent.setup();
    let resolveSave!: () => void;
    const onSave = vi.fn(() => new Promise<void>((res) => { resolveSave = res; }));
    const onSaveStateChange = vi.fn();
    const buffer = 'draft body';
    const ui = (c: string, s: string) => (
      <MemoryRouter>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer
              content={c}
              savedContent={s}
              filePath="Knowledge/Foo.md"
              onSave={onSave}
              onSaveStateChange={onSaveStateChange}
              readOnly={false}
            />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );
    const { rerender } = render(ui(buffer, buffer));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, ' edit');
    const edited = textarea.value;

    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(edited));
    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith('saving'));

    // Autosave echo lands mid-save: savedContent advances, content re-emitted.
    // The strip must stay 'saving' — no premature 'idle'.
    rerender(ui(edited, edited));
    expect(onSaveStateChange).toHaveBeenLastCalledWith('saving');

    // Once the save settles, `save()` clears the strip to idle.
    resolveSave();
    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith('idle'));
  });

  it('clears dirty state after successful save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    const onDirtyChange = vi.fn();
    const onSaveStateChange = vi.fn();
    renderMarkdown(onSave, { onDirtyChange, onSaveStateChange });

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, ' world');

    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('hello world');
    });
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });
    expect(onSaveStateChange.mock.calls.map((c) => c[0])).toContain('saving');
    expect(onSaveStateChange).toHaveBeenLastCalledWith('idle');
    // Error live region should NOT render after a successful save.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
