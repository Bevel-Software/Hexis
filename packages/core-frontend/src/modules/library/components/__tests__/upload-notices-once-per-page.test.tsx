import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { FileTreeEntry } from '@bevel-software/platform-shared';

const accessMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../../access/api', () => ({
  fetchFileAccess: accessMock.fetchFileAccess,
  fetchFileAccessBatch: vi.fn(async () => ({ results: {} })),
}));
vi.mock('../../../../lib/api', () => ({ authFetch: vi.fn() }));

import { PluginsTree, SkillsTree } from '../SkillsTree';
import {
  WorkspaceContext,
  libraryUploadTarget,
  type UploadError,
  type UploadNotice,
  type WorkspaceContextValue,
} from '../../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../../workspace/__tests__/testFixtures';
import { OpenChangeRequestsContext } from '../../../workspace/state/open-change-requests.context';
import { AuthContext } from '../../../auth/state/auth.context';

/**
 * The reported duplicate: one upload, the same "the upload became a
 * suggestion" notice at the top of the sidebar AND further down it.
 *
 * The Library's sidebar holds TWO of the app's file trees — `Skills/` and
 * `Plugins/` — and each renders the pair of upload banners, over one shared
 * piece of workspace state. Untargeted, a single drop painted its notice in
 * both. Each tree names itself now, and a banner is drawn only by the tree
 * whose name it carries.
 */

const KB = 'knowledge-base';

const TREE: FileTreeEntry = {
  name: '.',
  relativePath: '.',
  type: 'directory',
  children: [{
    name: KB,
    relativePath: KB,
    type: 'directory',
    children: [
      { name: 'Skills', relativePath: `${KB}/Skills`, type: 'directory', children: [] },
      { name: 'Plugins', relativePath: `${KB}/Plugins`, type: 'directory', children: [] },
    ],
  }],
};

function renderSidebar(over: Partial<WorkspaceContextValue>) {
  const workspace = makeWorkspaceFixture({ kbDirName: KB, fileTree: TREE, ...over });
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{ user: null, token: null, isLoading: false, login: async () => {}, logout: () => {} }}
      >
        <WorkspaceContext.Provider value={workspace}>
          <OpenChangeRequestsContext.Provider
            value={{
              paths: new Set(),
              forPath: () => [],
              minePaths: new Map(),
              mineNumbers: new Set(),
            }}
          >
            {/* Both of the Library sidebar's trees, as `PluginsSidebar` mounts them. */}
            <SkillsTree />
            <PluginsTree />
          </OpenChangeRequestsContext.Provider>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

/** The two trees name themselves through the same helper the trees use. */
const SKILLS = libraryUploadTarget('Skills');
const PLUGINS = libraryUploadTarget('Plugins');

const SUGGESTION: UploadNotice = {
  kind: 'suggestion',
  message:
    "You can't write to that folder, so the upload became a suggestion: "
    + 'it is now a change request for the folder’s owners to review.',
};

const REFUSAL: UploadError = {
  filename: 'report.pdf',
  reason: 'You do not have permission to write to Skills/house-writing-standards',
  status: 403,
};

describe('the Library sidebar shows one upload banner, in the tree that took the drop', () => {
  beforeEach(() => {
    cleanup();
    accessMock.fetchFileAccess.mockReset().mockResolvedValue({ canRead: true, canWrite: true });
  });

  it('renders the suggestion notice once, inside the Skills tree', () => {
    renderSidebar({ uploadNotices: new Map([[SKILLS, SUGGESTION]]) });
    const notices = screen.getAllByTestId('upload-notice');
    expect(notices).toHaveLength(1);
    expect(within(screen.getByTestId('skills-tree')).getByTestId('upload-notice')).toBe(notices[0]);
    expect(within(screen.getByTestId('plugins-tree')).queryByTestId('upload-notice')).toBeNull();
  });

  it('renders the error banner once, inside the Skills tree, reason and all', () => {
    renderSidebar({ uploadErrors: new Map([[SKILLS, REFUSAL]]) });
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent("Couldn't add report.pdf");
    expect(alerts[0].textContent).toContain(REFUSAL.reason);
    expect(alerts[0]).toHaveTextContent('Try another folder or ask its owner.');
    expect(within(screen.getByTestId('plugins-tree')).queryByRole('alert')).toBeNull();
  });

  // Two drops in flight at once, one per tree. Over a single shared notice
  // the second drop's dispatch replaced the first's and the first to settle
  // cleared the second's — either way one of the two uploads went silent,
  // which is the failure this page exists to prevent.
  it('shows both trees their own drop when two are in flight at once', () => {
    renderSidebar({
      uploadNotices: new Map([
        [SKILLS, { kind: 'progress', message: 'Adding report.pdf to Skills…' } as UploadNotice],
        [PLUGINS, SUGGESTION],
      ]),
    });
    expect(screen.getAllByTestId('upload-notice')).toHaveLength(2);
    expect(within(screen.getByTestId('skills-tree')).getByTestId('upload-notice'))
      .toHaveTextContent('Adding report.pdf to Skills');
    expect(within(screen.getByTestId('plugins-tree')).getByTestId('upload-notice'))
      .toHaveTextContent('became a suggestion');
  });

  it('puts a Plugins drop’s banner in the Plugins tree instead', () => {
    renderSidebar({ uploadNotices: new Map([[PLUGINS, SUGGESTION]]) });
    expect(screen.getAllByTestId('upload-notice')).toHaveLength(1);
    expect(within(screen.getByTestId('plugins-tree')).getByTestId('upload-notice')).toBeDefined();
    expect(within(screen.getByTestId('skills-tree')).queryByTestId('upload-notice')).toBeNull();
  });
});
