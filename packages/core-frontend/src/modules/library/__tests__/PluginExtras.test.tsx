import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

/**
 * The client-extensions section's tree source. The section pins its listing to
 * the default branch; what is under test is WHERE that tree comes from — the
 * workspace context's already-loaded tree when the context sits on the default
 * branch (no request at all), the fetch only when it sits elsewhere.
 */

const apiMock = vi.hoisted(() => ({ listFiles: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listFiles: apiMock.listFiles,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigateMock,
}));

import { ClientExtensionsSection } from '../components/PluginExtras';

const dir = (name: string, children: FileTreeEntry[]): FileTreeEntry =>
  ({ name, relativePath: name, type: 'directory', children }) as FileTreeEntry;
const file = (name: string): FileTreeEntry =>
  ({ name, relativePath: name, type: 'file' }) as FileTreeEntry;

/** A tree whose GTM plugin carries one foreign namespace dir. */
const TREE: FileTreeEntry = dir('root', [
  dir('knowledge-base', [
    dir('Plugins', [
      dir('GTM', [
        dir('com.example.client', [dir('hooks', [file('on-save.js')])]),
        dir('outreach', [file('SKILL.md')]),
      ]),
      dir('Product', [dir('roadmap', [file('SKILL.md')])]),
    ]),
  ]),
]);

function renderSection(workspace: Partial<WorkspaceContextValue>, folder = 'GTM') {
  return render(
    <MemoryRouter>
      <WorkspaceContext.Provider value={workspace as WorkspaceContextValue}>
        <ClientExtensionsSection kbDirName="knowledge-base" folder={folder} />
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.listFiles.mockReset();
  navigateMock.mockReset();
});

describe('ClientExtensionsSection', () => {
  it('reuses the context tree when the workspace sits on the default branch — no fetch', async () => {
    renderSection({ workspaceId: encodeURIComponent(DEFAULT_BRANCH), fileTree: TREE });
    expect(await screen.findByText('com.example.client/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hooks/on-save.js' })).toBeInTheDocument();
    expect(apiMock.listFiles).not.toHaveBeenCalled();
  });

  it('fetches the default-branch tree when the context sits on a draft branch', async () => {
    // A draft's tree could list files the section's default-branch links
    // cannot open — the fetch is the correctness fallback, not the norm.
    apiMock.listFiles.mockResolvedValue(TREE);
    renderSection({ workspaceId: 'draft-my-changes', fileTree: dir('root', []) });
    expect(await screen.findByText('com.example.client/')).toBeInTheDocument();
    expect(apiMock.listFiles).toHaveBeenCalledWith(encodeURIComponent(DEFAULT_BRANCH));
  });

  /**
   * The fileTree can carry workspace/KB-clone wrapper levels above the kb dir
   * (`findKbRoot` exists for exactly this shape). The section must find the
   * plugin's namespace dirs through them, not assume the root's direct child
   * is the kb dir.
   */
  it('finds the namespace dirs through wrapper levels above the kb dir', async () => {
    const wrapped = dir('root', [dir('workspace-clone', TREE.children ?? [])]);
    renderSection({ workspaceId: encodeURIComponent(DEFAULT_BRANCH), fileTree: wrapped });
    expect(await screen.findByText('com.example.client/')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hooks/on-save.js' })).toBeInTheDocument();
  });

  /**
   * `rawFile` steps past the app gate into the Knowledge editor — right for
   * opaque client data, wrong for a `.tool`, which has a first-class tool
   * page in this app. The same URL without the state renders that page.
   */
  it('opens a .tool in the library (no rawFile), other files in the Knowledge editor', async () => {
    const withTool: FileTreeEntry = dir('root', [
      dir('knowledge-base', [
        dir('Plugins', [
          dir('GTM', [
            dir('com.example.client', [dir('hooks', [file('on-save.js')])]),
            dir('software.bevel.hexis', [dir('tools', [file('web-search.tool')])]),
          ]),
        ]),
      ]),
    ]);
    renderSection({ workspaceId: encodeURIComponent(DEFAULT_BRANCH), fileTree: withTool });
    fireEvent.click(await screen.findByRole('button', { name: 'tools/web-search.tool' }));
    expect(navigateMock).toHaveBeenLastCalledWith(
      expect.stringContaining('web-search.tool'),
      undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'hooks/on-save.js' }));
    expect(navigateMock).toHaveBeenLastCalledWith(
      expect.stringContaining('on-save.js'),
      { state: { rawFile: true } },
    );
  });

  it('renders nothing for a plugin with no namespace dirs, still without fetching', async () => {
    const { container } = renderSection(
      { workspaceId: encodeURIComponent(DEFAULT_BRANCH), fileTree: TREE },
      'Product',
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(apiMock.listFiles).not.toHaveBeenCalled();
  });
});
