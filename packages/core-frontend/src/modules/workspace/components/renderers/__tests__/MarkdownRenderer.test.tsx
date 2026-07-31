import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../state/workspace.context';
import { makeWorkspaceFixture } from '../../../__tests__/testFixtures';
import { GitContext, type GitContextValue } from '../../../../git/state/git.context';
import { MarkdownRenderer } from '../MarkdownRenderer';

// Capture navigation so we can assert link clicks resolve + open the right file.
const navMock = vi.hoisted(() => ({ openFile: vi.fn() }));
vi.mock('../../../routing/kb-routes', async (importActual) => ({
  // Keep the real `resolveRelativePath` (and any other pure helpers) so link
  // resolution is exercised for real; only the navigation hook is stubbed.
  ...(await importActual<typeof import('../../../routing/kb-routes')>()),
  useFileNav: () => ({ openFile: navMock.openFile }),
  KB_ROUTE_PREFIX: '/workspace',
}));

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
    revert: async () => ({ sha: 'a', authorName: 'n', authorEmail: 'e', subject: 's', committedAt: '2026-04-20T00:00:00.000Z' }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
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

  // --- Link rendering in preview (readOnly) mode ---

  function renderPreview(content: string, filePath: string) {
    return render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={makeWorkspace()}>
          <GitContext.Provider value={makeGit()}>
            <MarkdownRenderer content={content} filePath={filePath} onSave={async () => {}} readOnly />
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </MemoryRouter>,
    );
  }

  it('renders a nodeType frontmatter value as a clickable link that navigates', async () => {
    navMock.openFile.mockClear();
    const user = userEvent.setup();
    renderPreview(
      '---\nnodeType: "[Process](../NodeTypes/Process.md)"\n---\n\n# Body',
      'Knowledge/Sub/Foo.md',
    );
    const link = screen.getByRole('link', { name: 'Process' });
    await user.click(link);
    expect(navMock.openFile).toHaveBeenCalledWith('Knowledge/NodeTypes/Process.md');
  });

  it('renders a bare body link whose path contains spaces as a working link', async () => {
    navMock.openFile.mockClear();
    const user = userEvent.setup();
    renderPreview('[Open](Some File.md)', 'Knowledge/Foo.md');
    const link = screen.getByRole('link', { name: 'Open' });
    await user.click(link);
    expect(navMock.openFile).toHaveBeenCalledWith('Knowledge/Some File.md');
  });

  it('renders an angle-bracketed body link with spaces as a working link', async () => {
    navMock.openFile.mockClear();
    const user = userEvent.setup();
    renderPreview('[Open](<Some File.md>)', 'Knowledge/Foo.md');
    const link = screen.getByRole('link', { name: 'Open' });
    await user.click(link);
    expect(navMock.openFile).toHaveBeenCalledWith('Knowledge/Some File.md');
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
