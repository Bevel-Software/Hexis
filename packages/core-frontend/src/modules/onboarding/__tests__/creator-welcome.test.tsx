import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { LibraryContext } from '../../library/state/library-context';
import type { LibraryContextValue } from '../../library/state/library-data';
import { LibraryToastProvider } from '../../library/state/toast';
import { setSidebarCollapsed, useSidebar } from '../../layout/state/sidebar';
import { WelcomeRoute } from '../components/WelcomeRoute';
import { WELCOME_PATH } from '../paths';
import { resetOnboardingForTests } from '../state/onboarding';

const serviceMocks = vi.hoisted(() => ({
  createGroup: vi.fn(),
  createEmptySkill: vi.fn(),
}));

vi.mock('../../library/services/groups.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../library/services/groups.api')>();
  return { ...actual, createGroup: serviceMocks.createGroup };
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
    tools: [],
    ownedSkills: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload: vi.fn(),
    items: [],
    groupSummaries: [],
    groupsLoading: false,
    groupsError: null,
    reloadGroups: vi.fn(),
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
        <LibraryContext.Provider value={library(options.library)}>
          <LibraryToastProvider>{children}</LibraryToastProvider>
        </LibraryContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>
  );
}

function renderWelcome(
  options: {
    greeted?: boolean;
    admin?: Partial<AdminContextValue>;
    library?: Partial<LibraryContextValue>;
  } = {},
) {
  const entry = options.greeted === false
    ? WELCOME_PATH
    : { pathname: WELCOME_PATH, state: { greeting: true } };

  return render(
    <MemoryRouter initialEntries={[entry]}>
      {providers(
        <>
          <Routes>
            <Route path={WELCOME_PATH} element={<WelcomeRoute />} />
            <Route path="/skills-and-tools/groups/:group" element={<div>group page</div>} />
            <Route path="/skills-and-tools/skills/:skill" element={<div>skill page</div>} />
          </Routes>
          <LocationProbe />
        </>,
        options,
      )}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetOnboardingForTests();
  setSidebarCollapsed(false, true);
  serviceMocks.createGroup.mockReset();
  serviceMocks.createGroup.mockResolvedValue({ folder: 'Design' });
  serviceMocks.createEmptySkill.mockReset();
  serviceMocks.createEmptySkill.mockResolvedValue({
    repoRelativePath: 'Groups/personal-u1/weekly-report/SKILL.md',
    workspacePath: 'knowledge-base/Groups/personal-u1/weekly-report/SKILL.md',
    branch: 'dev',
    direct: true,
  });
});

describe('creator welcome routing', () => {
  it('welcomes an admin to build a truly empty library', () => {
    renderWelcome();

    expect(screen.getByRole('heading', { name: 'Welcome, Juan' })).toBeInTheDocument();
    expect(screen.getByText(/Build the shared library/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a group' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a skill' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Your agent' })).toBeNull();
  });

  it('keeps the external-agent welcome for non-admin users', () => {
    renderWelcome({ admin: { isAdmin: false } });

    expect(screen.getByRole('radiogroup', { name: 'Your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a group' })).toBeNull();
  });

  it('keeps the external-agent welcome when the admin already has content', () => {
    renderWelcome({
      library: {
        items: [
          {
            kind: 'skill',
            id: 'roadmap',
            name: 'roadmap',
            description: 'Keeps the roadmap current.',
            owned: true,
            status: { state: 'ok', text: 'Ready' },
            group: null,
            path: 'Skills/roadmap',
          },
        ],
      },
    });

    expect(screen.getByRole('radiogroup', { name: 'Your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a group' })).toBeNull();
  });

  it('does not mistake loading or failed group data for an empty library', () => {
    const { rerender } = renderWelcome({ admin: { isAdminLoading: true } });
    expect(screen.getByText('Preparing your library…')).toBeInTheDocument();

    rerender(
      <MemoryRouter
        initialEntries={[{ pathname: WELCOME_PATH, state: { greeting: true } }]}
      >
        {providers(
          <Routes>
            <Route path={WELCOME_PATH} element={<WelcomeRoute />} />
          </Routes>,
          { library: { groupsError: "Couldn't load groups." } },
        )}
      </MemoryRouter>,
    );

    expect(screen.getByRole('radiogroup', { name: 'Your agent' })).toBeInTheDocument();
  });

  it('uses the external-agent welcome for later visits from its reminder', () => {
    renderWelcome({ greeted: false });

    expect(screen.getByRole('radiogroup', { name: 'Your agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a group' })).toBeNull();
  });

  it('collapses the sidebar before the creator welcome is shown', () => {
    renderWelcome();
    expect(renderHook(() => useSidebar()).result.current).toMatchObject({
      collapsed: true,
      instant: true,
    });
  });
});

describe('creator welcome actions', () => {
  it('creates a group through the shared dialog and refreshes both indexes', async () => {
    const data = library();
    const user = userEvent.setup();
    renderWelcome({ library: data });

    await user.click(screen.getByRole('button', { name: 'Create a group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'Design');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(serviceMocks.createGroup).toHaveBeenCalledWith('Design'));
    expect(data.reload).toHaveBeenCalledOnce();
    expect(data.reloadGroups).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('pathname')).toHaveTextContent(
      '/skills-and-tools/groups/Design',
    );
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
    expect(data.reload).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('pathname')).toHaveTextContent(
      '/skills-and-tools/skills/weekly-report',
    );
  });
});
