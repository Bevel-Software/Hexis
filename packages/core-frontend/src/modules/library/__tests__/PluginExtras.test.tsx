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

const apiMock = vi.hoisted(() => ({ listFiles: vi.fn(), readFile: vi.fn() }));
vi.mock('../../workspace/services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listFiles: apiMock.listFiles,
  readFile: apiMock.readFile,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigateMock,
}));

import { ClientExtensionsSection, ManifestSection } from '../components/PluginExtras';

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
  apiMock.readFile.mockReset();
  navigateMock.mockReset();
});

describe('ManifestSection', () => {
  const MANIFEST = '{"name":"gtm","version":"1.2.0","extensions":{"software.bevel.hexis":{"skills":["Skills/Sales"]}}}';

  it('is closed by default and reads nothing until opened; open, it shows the manifest laid out as JSON', async () => {
    apiMock.readFile.mockResolvedValue(MANIFEST);
    render(
      <MemoryRouter>
        <ManifestSection kbDirName="knowledge-base" folder="GTM" managed canWrite={false} />
      </MemoryRouter>,
    );
    const header = screen.getByRole('button', { name: /^Manifest plugin\.json$/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(apiMock.readFile).not.toHaveBeenCalled();

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(apiMock.readFile).toHaveBeenCalledWith(
      encodeURIComponent(DEFAULT_BRANCH),
      'knowledge-base/Plugins/GTM/plugin.json',
    );
    await waitFor(() => expect(screen.getByText(/"version": "1\.2\.0"/)).toBeInTheDocument());
    // A reader gets no editor link.
    expect(screen.queryByRole('button', { name: 'Edit the manifest' })).not.toBeInTheDocument();
  });

  it("reads the bundle dialect's file for an unmanaged plugin, and offers no editor even to a writer", async () => {
    apiMock.readFile.mockResolvedValue('{"name":"example"}');
    render(
      <MemoryRouter>
        <ManifestSection kbDirName="knowledge-base" folder="functional/cluster/example" managed={false} canWrite />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Manifest plugin\.bundle\.json$/ }));
    expect(apiMock.readFile).toHaveBeenCalledWith(
      encodeURIComponent(DEFAULT_BRANCH),
      'knowledge-base/Plugins/functional/cluster/example/plugin.bundle.json',
    );
    await waitFor(() => expect(screen.getByText(/"name": "example"/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Edit the manifest' })).not.toBeInTheDocument();
  });

  it('a writer gets "Edit the manifest", which asks for the raw file by state', async () => {
    apiMock.readFile.mockResolvedValue(MANIFEST);
    render(
      <MemoryRouter>
        <ManifestSection kbDirName="knowledge-base" folder="GTM" managed canWrite />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Manifest plugin\.json$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit the manifest' }));
    expect(navigateMock).toHaveBeenLastCalledWith(
      expect.stringContaining('Plugins/GTM/plugin.json'),
      { state: { rawFile: true } },
    );
  });

  it('shows the file as written when it is not JSON, and says so when it cannot be read', async () => {
    apiMock.readFile.mockResolvedValue('not json {');
    const { unmount } = render(
      <MemoryRouter>
        <ManifestSection kbDirName="knowledge-base" folder="GTM" managed canWrite={false} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Manifest plugin\.json$/ }));
    await waitFor(() => expect(screen.getByText('not json {')).toBeInTheDocument());
    unmount();

    apiMock.readFile.mockRejectedValue(new Error('403'));
    render(
      <MemoryRouter>
        <ManifestSection kbDirName="knowledge-base" folder="GTM" managed canWrite={false} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Manifest plugin\.json$/ }));
    await waitFor(() => expect(screen.getByText("Couldn't read plugin.json.")).toBeInTheDocument());
  });
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

  it('finds the namespace dirs of a plugin nested below the root — the folder is a path, walked a segment at a time', async () => {
    const nested: FileTreeEntry = dir('root', [
      dir('knowledge-base', [
        dir('Plugins', [dir('teams', [dir('deep', [dir('com.example.client', [dir('hooks', [file('on-open.js')])])])])]),
      ]),
    ]);
    renderSection({ workspaceId: encodeURIComponent(DEFAULT_BRANCH), fileTree: nested }, 'teams/deep');
    expect(await screen.findByText('com.example.client/')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'hooks/on-open.js' }));
    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringContaining('/knowledge-base/Plugins/teams/deep/com.example.client/hooks/on-open.js'),
      expect.anything(),
    );
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
