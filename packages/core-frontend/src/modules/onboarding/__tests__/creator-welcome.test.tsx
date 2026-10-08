import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { LibraryContext } from '../../library/state/library-context';
import type { LibraryContextValue } from '../../library/state/library-data';
import { LibraryToastProvider } from '../../library/state/toast';
import { LibraryPage } from '../../library/components/LibraryPage';
import { LIBRARY_ROOT } from '../../library/routes/library-paths';
import type { LibraryFilter } from '../../library/utils/status';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { resetOnboardingForTests } from '../state/onboarding';

/**
 * The creator welcome: Skills & Tools' empty state for an admin. The page the
 * Library opens on (Everything) offers a first plugin and a first skill in
 * place of an empty gallery — only for an admin, only once both indexes have
 * answered empty, and only there.
 */

const serviceMocks = vi.hoisted(() => ({
  createPlugin: vi.fn(),
  createEmptySkill: vi.fn(),
}));

vi.mock('../../library/services/plugins.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../library/services/plugins.api')>();
  // The gallery asks for join requests to show; nobody is asking here.
  return { ...actual, createPlugin: serviceMocks.createPlugin, listJoinRequests: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../library/services/library.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../library/services/library.api')>();
  return { ...actual, createEmptySkill: serviceMocks.createEmptySkill };
});

function library(over: Partial<LibraryContextValue> = {}): LibraryContextValue {
  return {
    loading: false,
    error: null,
    skills: [],
    pendingSkills: [],
    pendingTools: [],
    tools: [],
    ownedSkills: new Set(),
    writableSkills: new Set(),
    ownedTools: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload: vi.fn(),
    items: [],
    pluginSummaries: [],
    pluginsLoading: false,
    pluginsError: null,
    teams: [],
    teamsLoading: false,
    teamsError: null,
    reloadPlugins: vi.fn(),
    ...over,
  };
}

function admin(over: Partial<AdminContextValue> = {}): AdminContextValue {
  return {
    isAdmin: true,
    isAdminLoading: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: vi.fn(),
    refresh: vi.fn(),
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: vi.fn(),
    ...over,
  };
}

function LocationProbe() {
  return <div aria-label="pathname">{useLocation().pathname}</div>;
}

function providers(
  children: ReactNode,
  options: { admin?: Partial<AdminContextValue>; library?: Partial<LibraryContextValue> } = {},
) {
  return (
    <AuthContext.Provider
      value={authValue({
        user: {
          id: 'u1',
          email: 'juan@bevel.software',
          name: 'Juan Viera',
          onboardingDone: false,
        },
      })}
    >
      <AdminContext.Provider value={admin(options.admin)}>
        <WorkspaceContext.Provider value={makeWorkspaceFixture()}>
          <LibraryContext.Provider value={library(options.library)}>
            <LibraryToastProvider>{children}</LibraryToastProvider>
          </LibraryContext.Provider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>
  );
}

interface WelcomeOptions {
  /** The Library view on screen; Everything, the page it opens on, unless said. */
  filter?: LibraryFilter;
  admin?: Partial<AdminContextValue>;
  library?: Partial<LibraryContextValue>;
}

/**
 * The whole tree, as one builder — so a test that re-renders with different
 * options reuses the exact router + provider composition instead of
 * hand-assembling a second copy that can drift from this one.
 */
function welcomeUi(options: WelcomeOptions = {}) {
  return (
    <MemoryRouter initialEntries={[LIBRARY_ROOT]}>
      {providers(
        <>
          <Routes>
            <Route path={LIBRARY_ROOT} element={<LibraryPage filter={options.filter ?? { kind: 'all' }} />} />
            <Route path="/skills-and-tools/plugins/:plugin" element={<div>plugin page</div>} />
            <Route path="/skills-and-tools/skills/:skill" element={<div>skill page</div>} />
          </Routes>
          <LocationProbe />
        </>,
        options,
      )}
    </MemoryRouter>
  );
}

function renderWelcome(options: WelcomeOptions = {}) {
  return render(welcomeUi(options));
}

const ROADMAP_SKILL: LibraryContextValue['items'][number] = {
  kind: 'skill',
  id: 'roadmap',
  name: 'roadmap',
  description: 'Keeps the roadmap current.',
  owned: true,
  canWrite: true,
  status: { state: 'ok', text: 'Ready' },
  plugin: null,
  path: 'Skills/roadmap',
};

const isCreatorWelcome = () => screen.queryByText(/Build the shared library/) !== null;
const isGallery = () => screen.queryByRole('heading', { name: 'Everything', level: 1 }) !== null;

beforeEach(() => {
  resetOnboardingForTests();
  serviceMocks.createPlugin.mockReset();
  serviceMocks.createPlugin.mockResolvedValue({ folder: 'Design', name: 'design' });
  serviceMocks.createEmptySkill.mockReset();
  serviceMocks.createEmptySkill.mockResolvedValue({
    repoRelativePath: 'Plugins/personal-u1/weekly-report/SKILL.md',
    workspacePath: 'knowledge-base/Plugins/personal-u1/weekly-report/SKILL.md',
    branch: 'dev',
    direct: true,
  });
});

describe('creator welcome: the empty state of Skills & Tools', () => {
  it('welcomes an admin to build a truly empty library, in place of the gallery', () => {
    renderWelcome();

    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
    expect(screen.getByText(/Build the shared library/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a plugin' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a skill' })).toBeInTheDocument();
    expect(isGallery()).toBe(false);
  });

  it('keeps the gallery for members, whose job is not the shared structure', () => {
    renderWelcome({ admin: { isAdmin: false } });

    expect(isGallery()).toBe(true);
    expect(isCreatorWelcome()).toBe(false);
  });

  it('keeps the gallery once the catalog holds anything — a skill, or a plugin', () => {
    const { rerender } = renderWelcome({ library: { items: [ROADMAP_SKILL] } });
    expect(isGallery()).toBe(true);
    expect(isCreatorWelcome()).toBe(false);

    rerender(
      welcomeUi({
        library: {
          pluginSummaries: [
            {
              name: 'GTM',
              folders: ['Plugins/GTM'],
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
            },
          ],
        },
      }),
    );
    expect(isCreatorWelcome()).toBe(false);
  });

  it('does not mistake an unsettled admin verdict, or loading or failed indexes, for an empty library', () => {
    const { rerender } = renderWelcome({ admin: { isAdminLoading: true } });
    expect(isCreatorWelcome()).toBe(false);

    rerender(welcomeUi({ library: { loading: true } }));
    expect(isCreatorWelcome()).toBe(false);

    rerender(welcomeUi({ library: { pluginsLoading: true } }));
    expect(isCreatorWelcome()).toBe(false);

    rerender(welcomeUi({ library: { pluginsError: "Couldn't load plugins." } }));
    expect(isCreatorWelcome()).toBe(false);

    rerender(welcomeUi({ library: { error: "Couldn't load the library." } }));
    expect(isCreatorWelcome()).toBe(false);
  });

  it('is the empty state of Everything alone, not of every view', () => {
    renderWelcome({ filter: { kind: 'owned' } });

    expect(screen.getByRole('heading', { name: 'Owned by me', level: 1 })).toBeInTheDocument();
    expect(isCreatorWelcome()).toBe(false);
  });
});

describe('creator welcome actions', () => {
  it('creates a plugin through the shared dialog and refreshes both indexes', async () => {
    const data = library();
    const user = userEvent.setup();
    renderWelcome({ library: data });

    await user.click(screen.getByRole('button', { name: 'Create a plugin' }));
    await user.type(screen.getByRole('textbox', { name: 'Plugin name' }), 'Design');
    await user.click(screen.getByRole('button', { name: 'Create plugin' }));

    await waitFor(() => expect(serviceMocks.createPlugin).toHaveBeenCalledWith('Design', ''));
    // The navigation is the LAST link of the create chain (create -> refresh
    // indexes -> navigate), so it is the settled state to wait for; asserting
    // it immediately races the refresh microtasks and flakes under CI load.
    await waitFor(() =>
      // The new plugin's page is addressed by its identity, not its folder.
      expect(screen.getByLabelText('pathname')).toHaveTextContent(
        '/skills-and-tools/plugins/design',
      ),
    );
    expect(data.reload).toHaveBeenCalledOnce();
    expect(data.reloadPlugins).toHaveBeenCalledOnce();
  });

  it('creates a personal skill and opens its skill page', async () => {
    const data = library();
    const user = userEvent.setup();
    renderWelcome({ library: data });

    await user.click(screen.getByRole('button', { name: 'Create a skill' }));
    expect(screen.getByRole('dialog', { name: 'New skill' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Skill name' }), 'weekly-report');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(serviceMocks.createEmptySkill).toHaveBeenCalledWith({
        personal: true,
        name: 'weekly-report',
        userEmail: 'juan@bevel.software',
        userName: 'Juan Viera',
      }),
    );
    // The skill's canonical address is its workspace FILE url, not the legacy
    // `skills/:name` route — that one survives only as a redirect. The dialog
    // owns this navigation, so the welcome page inherits whatever the rest of
    // the Library does, which is the point of routing through it. Waited for,
    // not asserted immediately: navigation is the last link of the create
    // chain and racing its microtasks is what made this test flake in CI.
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent(
        '/workspace/target-company-state/knowledge-base/Plugins/personal-u1/weekly-report/SKILL.md',
      ),
    );
    expect(data.reload).toHaveBeenCalledOnce();
  });

  it('holds the New skill dialog open while creation is pending', async () => {
    // A create that has started finishes even if the dialog goes away — and
    // then NAVIGATES. Every way out must be barred until it settles, or a
    // dismissal turns into being carried to a page you closed the door on.
    let release!: () => void;
    serviceMocks.createEmptySkill.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              repoRelativePath: 'Plugins/personal-u1/weekly-report/SKILL.md',
              workspacePath: 'knowledge-base/Plugins/personal-u1/weekly-report/SKILL.md',
              branch: 'dev',
              direct: true,
            });
        }),
    );
    const user = userEvent.setup();
    renderWelcome();

    await user.click(screen.getByRole('button', { name: 'Create a skill' }));
    await user.type(screen.getByRole('textbox', { name: 'Skill name' }), 'weekly-report');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    for (const door of screen.getAllByRole('button', { name: /close/i })) {
      expect(door).toBeDisabled();
    }

    release();
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent(
        '/workspace/target-company-state/knowledge-base/Plugins/personal-u1/weekly-report/SKILL.md',
      ),
    );
  });
});
