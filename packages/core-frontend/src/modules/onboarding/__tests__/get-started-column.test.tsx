import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { GetStartedColumn } from '../components/GetStartedColumn';
import { InviteDialogProvider } from '../state/invite-dialog';
import { resetOnboardingForTests } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';
import type { AccountSummary } from '../../auth/services/account.api';
import type { PluginSummary } from '../../library/services/plugins.api';

/**
 * The "Get set up" column: every tick is derived from state the app already
 * has, the admin-only steps stay out of a member's list, and the column gets
 * out of the way — on the welcome page, when narrow, when done, when closed.
 */

const { listAccountsMock, listPluginsMock, openWorkspacePathMock } = vi.hoisted(() => ({
  listAccountsMock: vi.fn<() => Promise<AccountSummary[]>>(),
  listPluginsMock: vi.fn<() => Promise<PluginSummary[]>>(),
  openWorkspacePathMock: vi.fn<(path: string, options?: { edit?: boolean }) => void>(),
}));

vi.mock('../../../lib/api', () => ({ authFetch: vi.fn() }));
vi.mock('../../auth/services/account.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/account.api')>()),
  listAccounts: listAccountsMock,
}));
vi.mock('../../library/services/plugins.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../library/services/plugins.api')>()),
  listPlugins: listPluginsMock,
}));
// The real hook needs the git context for its branch; the column only ever
// asks it to open a workspace path, which is the call these tests assert.
vi.mock('../../workspace/routing/kb-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/routing/kb-routes')>()),
  useFileNav: () => ({
    openFile: vi.fn(),
    openLink: vi.fn(),
    openWorkspacePath: openWorkspacePathMock,
    closeFile: vi.fn(),
  }),
}));

const KB = 'kb';
const GUIDE = `${KB}/KnowledgeBase/How to get started.md`;

/** A workspace tree holding exactly `files` (workspace-relative paths). */
function treeOf(files: string[]): FileTreeEntry {
  const root: FileTreeEntry = { name: '', relativePath: '', type: 'directory', children: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    parts.forEach((name, i) => {
      const relativePath = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      let child = node.children!.find((c) => c.name === name);
      if (!child) {
        child = isFile
          ? { name, relativePath, type: 'file' }
          : { name, relativePath, type: 'directory', children: [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  return root;
}

const STARTER_TREE = [GUIDE, `${KB}/KnowledgeBase/.gitkeep`, `${KB}/Plugins/.gitkeep`];

function account(email: string, over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: email,
    email,
    name: email,
    hasPassword: false,
    isEnvAdmin: false,
    deactivatedAt: null,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function plugin(folder: string): PluginSummary {
  return {
    name: folder.split('/').pop()!,
    folders: [folder],
    canRead: true,
    canWrite: true,
    isOwner: true,
    skillCount: 0,
    toolCount: 0,
    owners: { roles: [], users: [] },
    writers: { roles: [], users: [] },
    readers: { roles: [], users: [], restricted: false },
    hasRequested: false,
    requestNumber: null,
  };
}

function adminValue(isAdmin: boolean): AdminContextValue {
  return {
    isAdmin,
    isAdminLoading: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: () => {},
    refresh: () => {},
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: async () => {},
  };
}

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function setViewportWidth(width: number): void {
  (window as typeof window & { happyDOM: { setInnerWidth(v: number): void } }).happyDOM.setInnerWidth(width);
}

function mount({
  admin = false,
  onboardingDone = false,
  files = STARTER_TREE,
  openFilePath = null as string | null,
  route = '/workspace',
  createFile = async () => {},
}: {
  admin?: boolean;
  onboardingDone?: boolean;
  files?: string[];
  openFilePath?: string | null;
  route?: string;
  createFile?: (relativePath: string, content?: string) => Promise<void>;
} = {}) {
  const auth = authValue({
    user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone },
  });
  const ui = (
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <AdminContext.Provider value={adminValue(admin)}>
          <WorkspaceContext.Provider
            value={makeWorkspaceFixture({ kbDirName: KB, fileTree: treeOf(files), openFilePath, createFile })}
          >
            <InviteDialogProvider>
              <GetStartedColumn />
              <LocationProbe />
            </InviteDialogProvider>
          </WorkspaceContext.Provider>
        </AdminContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { ...render(ui), ui };
}

/** The checklist row titled `title`, or null when the column does not list it. */
function row(title: RegExp | string) {
  const column = screen.getByRole('complementary', { name: 'Get set up' });
  const heading = within(column).queryByText(title);
  return heading ? (heading.closest('li') as HTMLElement) : null;
}

const isDone = (title: RegExp | string) => within(row(title)!).queryByText('(done)') !== null;

beforeEach(() => {
  resetOnboardingForTests();
  setViewportWidth(1400);
  listAccountsMock.mockReset().mockResolvedValue([account('juan@bevel.software')]);
  listPluginsMock.mockReset().mockResolvedValue([]);
  openWorkspacePathMock.mockReset();
});

describe('GetStartedColumn: what a member sees', () => {
  it('lists the four member steps, hides the admin-only ones, and asks the server nothing', () => {
    mount();
    expect(screen.getByText('1 of 4')).toBeInTheDocument();
    expect(row('Create your workspace')).not.toBeNull();
    expect(row('Connect your agent')).not.toBeNull();
    expect(row('Read “How to get started”')).not.toBeNull();
    expect(row('Write your first page')).not.toBeNull();
    expect(row('Choose where your knowledge lives')).toBeNull();
    expect(row('Create a plugin for your team')).toBeNull();
    expect(row('Invite your team')).toBeNull();
    expect(listAccountsMock).not.toHaveBeenCalled();
    expect(listPluginsMock).not.toHaveBeenCalled();
  });

  it('ticks "Connect your agent" from the server onboarding flag', () => {
    mount({ onboardingDone: true });
    expect(isDone('Connect your agent')).toBe(true);
    expect(isDone('Create your workspace')).toBe(true);
    expect(screen.getByText('2 of 4')).toBeInTheDocument();
  });

  it('sends "Connect" to the welcome page', async () => {
    mount();
    await userEvent.click(within(row('Connect your agent')!).getByRole('button', { name: 'Connect' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  it('opens the starter guide and ticks it', async () => {
    mount();
    expect(isDone('Read “How to get started”')).toBe(false);
    await userEvent.click(within(row('Read “How to get started”')!).getByRole('button', { name: 'Open it' }));
    expect(openWorkspacePathMock).toHaveBeenCalledWith(GUIDE);
    expect(isDone('Read “How to get started”')).toBe(true);
  });

  it('ticks the guide when it is opened by any route, and remembers it', () => {
    const { unmount } = mount({ openFilePath: GUIDE });
    expect(isDone('Read “How to get started”')).toBe(true);
    unmount();
    mount();
    expect(isDone('Read “How to get started”')).toBe(true);
  });

  it('leaves the guide step out when the knowledge base has no such page', () => {
    mount({ files: [`${KB}/KnowledgeBase/.gitkeep`] });
    expect(row('Read “How to get started”')).toBeNull();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('ticks "Write your first page" only for content other than the starter page', () => {
    const { unmount } = mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/access.md`] });
    expect(isDone('Write your first page')).toBe(false);
    expect(
      within(row('Write your first page')!).getByText(
        'Start one here, or drop files into the file tree.',
      ),
    ).toBeInTheDocument();
    unmount();
    mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/Product/Roadmap.md`] });
    expect(isDone('Write your first page')).toBe(true);
  });

  it('"New page" creates Untitled.md in the Knowledge folder and opens it for editing', async () => {
    const createFile = vi.fn(async () => {});
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(createFile).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled.md`, '# Untitled\n\n');
    expect(openWorkspacePathMock).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled.md`, { edit: true });
  });

  it('"New page" takes the next free name when Untitled.md is taken', async () => {
    const createFile = vi.fn(async () => {});
    // Any page would already tick the step and hide the button, so what holds
    // the name here is an (otherwise empty) folder called `Untitled.md` and
    // `Untitled 2.md` — a name the tree has is taken, whatever it is.
    mount({
      createFile,
      files: [
        ...STARTER_TREE,
        `${KB}/KnowledgeBase/Untitled.md/.gitkeep`,
        `${KB}/KnowledgeBase/Untitled 2.md/.gitkeep`,
      ],
    });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(createFile).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled 3.md`, '# Untitled\n\n');
    expect(openWorkspacePathMock).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled 3.md`, { edit: true });
  });

  it('"New page" says "Creating…" while it works, and says why it failed on the step', async () => {
    let refuse!: (err: Error) => void;
    const createFile = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        }),
    );
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(within(row('Write your first page')!).getByRole('button', { name: 'Creating…' })).toBeDisabled();

    await act(async () => {
      refuse(new Error('You don’t have permission to write to "KnowledgeBase/Untitled.md".'));
    });
    expect(within(row('Write your first page')!).getByRole('alert')).toHaveTextContent(
      'Couldn’t create the page: You don’t have permission to write to "KnowledgeBase/Untitled.md".',
    );
    expect(within(row('Write your first page')!).getByRole('button', { name: 'New page' })).toBeEnabled();
    expect(openWorkspacePathMock).not.toHaveBeenCalled();
    expect(isDone('Write your first page')).toBe(false);
  });
});

describe('GetStartedColumn: what an admin sees', () => {
  it('lists all seven steps, storage already done', async () => {
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(screen.getByText('2 of 7')).toBeInTheDocument();
    expect(isDone('Choose where your knowledge lives')).toBe(true);
    expect(isDone('Create a plugin for your team')).toBe(false);
    expect(isDone('Invite your team')).toBe(false);
  });

  it('ticks the plugin step for a team plugin, not a personal shelf', async () => {
    listPluginsMock.mockResolvedValue([plugin('Plugins/personal-juan')]);
    const { unmount } = mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(isDone('Create a plugin for your team')).toBe(false);
    unmount();

    listPluginsMock.mockResolvedValue([plugin('Plugins/GTM')]);
    mount({ admin: true });
    await waitFor(() => expect(isDone('Create a plugin for your team')).toBe(true));
  });

  it('ticks the invite step for a second person, never for a system account', async () => {
    listAccountsMock.mockResolvedValue([
      account('juan@bevel.software'),
      account('recovery-bot@bevel.local', { isSystem: true }),
    ]);
    const { unmount } = mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(isDone('Invite your team')).toBe(false);
    unmount();

    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('ana@bevel.software')]);
    mount({ admin: true });
    await waitFor(() => expect(isDone('Invite your team')).toBe(true));
  });

  it('opens the invite dialog from the invite step', async () => {
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    await userEvent.click(within(row('Invite your team')!).getByRole('button', { name: 'Invite people' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
  });

  it('goes away once every step is done', async () => {
    listPluginsMock.mockResolvedValue([plugin('Plugins/GTM')]);
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('ana@bevel.software')]);
    const everythingBut = { admin: true, onboardingDone: true, openFilePath: GUIDE };
    // One step short, the settled column shows the six it has...
    const { unmount } = mount(everythingBut);
    expect(await screen.findByText('6 of 7')).toBeInTheDocument();
    unmount();
    // ...and with the last one done, the same answers leave nothing to show.
    mount({ ...everythingBut, files: [...STARTER_TREE, `${KB}/KnowledgeBase/Notes.md`] });
    await act(async () => {});
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });
});

describe('GetStartedColumn: getting out of the way', () => {
  it('stays dismissed once closed, across remounts', async () => {
    const { unmount } = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss Get set up' }));
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('bevel.onboarding.setupDismissed.juan@bevel.software')).toBe('1');
    unmount();
    mount();
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('is not shown on the welcome page', () => {
    mount({ route: WELCOME_PATH });
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('is shown in an ordinary laptop window', () => {
    setViewportWidth(1000);
    mount();
    expect(screen.getByRole('complementary', { name: 'Get set up' })).toBeInTheDocument();
  });

  it('is not shown at or below 900px, where the sidebar turns into a drawer', () => {
    setViewportWidth(900);
    mount();
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });
});
