import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { ToolDependents, ToolManualDetail } from '../services/tools.api';

/**
 * Deleting a tool from its page: who is offered it, what the confirmation says
 * before anybody presses anything, and where the page goes afterwards.
 *
 * The owner gate is asserted on the RENDERED menu rather than on a prop,
 * because "a non-owner does not see Delete" is the acceptance criterion and a
 * prop check would pass with the item still on screen.
 */

const secretsMock = vi.hoisted(() => ({
  listToolSecrets: vi.fn(),
  setAdminVar: vi.fn(),
  setUserVar: vi.fn(),
  deleteAdminVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
}));
vi.mock('../../secrets-vault/services/tool-secrets.api', () => secretsMock);

const toolsMock = vi.hoisted(() => ({
  getToolDetail: vi.fn(),
  getMcpServer: vi.fn(async () => null),
  getToolDependents: vi.fn(),
  deleteTool: vi.fn(),
}));
vi.mock('../services/tools.api', () => ({
  getToolDetail: toolsMock.getToolDetail,
  getMcpServer: toolsMock.getMcpServer,
  putMcpServer: vi.fn(),
  getToolDependents: toolsMock.getToolDependents,
  deleteTool: toolsMock.deleteTool,
}));

const libraryMock = vi.hoisted(() => ({ listSkills: vi.fn(), getSkill: vi.fn() }));
vi.mock('../services/library.api', () => ({
  listSkills: libraryMock.listSkills,
  getSkill: libraryMock.getSkill,
}));

/** The plugin catalog the page's owner verdict comes from. */
const libraryData = vi.hoisted(() => ({
  isOwner: true,
  linksAreManaged: true,
  reload: vi.fn(),
  reloadPlugins: vi.fn(),
}));
vi.mock('../state/library-data', () => ({
  useLibrary: () => ({
    pluginSummaries: [
      {
        name: 'gtm',
        displayName: 'GTM',
        folders: ['Plugins/GTM'],
        isOwner: libraryData.isOwner,
        linksAreManaged: libraryData.linksAreManaged,
        canRead: true,
        canWrite: true,
      },
    ],
    reload: libraryData.reload,
    reloadPlugins: libraryData.reloadPlugins,
  }),
}));

vi.mock('../../change-requests/services/change-requests.api', () => ({ readFileOnBranch: vi.fn() }));
vi.mock('../../secrets-vault/services/connect.api', () => ({ startToolOAuth: vi.fn() }));
vi.mock('../utils/navigate-external', () => ({ navigateExternal: vi.fn() }));

import { ToolPage } from '../components/tool-page/ToolPage';
import { DeleteToolDialog } from '../components/tool-page/DeleteToolDialog';
import { expectMenuAtTheEndOfTheTitleRow } from './title-row-actions';

const TOOL: ToolSecrets = {
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: true,
  variables: [],
};

const DETAIL: ToolManualDetail = {
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  description: 'Runs LinkedIn outreach campaigns.',
  capabilities: [],
};

const DEPENDENTS: ToolDependents = {
  slug: 'heyreach',
  name: 'heyreach',
  source: 'manual',
  plugin: { name: 'gtm', displayName: 'GTM' },
  skills: [
    { name: 'outreach', path: 'Plugins/GTM/outreach' },
    { name: 'follow-up', path: 'Plugins/GTM/follow-up' },
  ],
  plugins: [{ name: 'sales', displayName: 'Sales' }],
  storedKeys: 1,
  signIns: 3,
};

const workspace = {
  workspaceId: 'ws',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

const AUTH = {
  user: { email: 'owner@x.com', name: 'Ola' },
  token: 't',
  isLoading: false,
  login: vi.fn(),
  logout: vi.fn(),
} as unknown as AuthContextValue;

const ADMIN = {
  isAdmin: false,
  unreadCount: 0,
  lastSeen: null,
  markSeen: vi.fn(),
  refresh: vi.fn(),
  rolesConfigCorrupted: false,
  rolesConfigErrors: [],
  runRolesRecovery: vi.fn(),
};

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function wrap(children: ReactNode) {
  return (
    <AuthContext.Provider value={AUTH}>
      <AdminContext.Provider value={ADMIN}>
        <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools/tools/heyreach']}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/tools/:slug" element={<ToolPage />} />
          <Route path="/skills-and-tools/plugins/:plugin" element={<div>Plugin page</div>} />
        </Routes>,
      )}
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Type the tool's name into the dialog's confirm field — what arms Delete. */
function confirmName(name = 'heyreach') {
  fireEvent.change(screen.getByLabelText(/Type .* to confirm/), { target: { value: name } });
}

/** Render the page, open the `⋯` menu, and hand back its Delete item, if it has one. */
async function openMenu() {
  renderPage();
  await screen.findByRole('heading', { name: 'heyreach', level: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  return screen.queryByRole('menuitem', { name: /Delete tool/ });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/skills-and-tools/tools/heyreach');
  libraryData.isOwner = true;
  libraryData.linksAreManaged = true;
  libraryData.reload.mockClear();
  libraryData.reloadPlugins.mockClear();
  secretsMock.listToolSecrets.mockReset().mockResolvedValue([TOOL]);
  toolsMock.getToolDetail.mockReset().mockResolvedValue(DETAIL);
  toolsMock.getMcpServer.mockClear();
  toolsMock.getToolDependents.mockReset().mockResolvedValue(DEPENDENTS);
  toolsMock.deleteTool.mockReset().mockResolvedValue({ plugin: 'gtm' });
  libraryMock.listSkills.mockReset().mockResolvedValue([]);
  libraryMock.getSkill.mockReset().mockResolvedValue({ allowedTools: [] });
});

describe('who is offered Delete', () => {
  /**
   * The menu's PLACE does not depend on what is in it. The same assertion
   * `ToolPage.test.tsx` makes for a reader, here for the one caller that
   * really owns the plugin — the spec's "with and without Delete".
   */
  it('keeps the ⋯ at the right end of the title row for the owner too', async () => {
    expect(await openMenu()).toBeInTheDocument();
    expectMenuAtTheEndOfTheTitleRow();
  });

  it('offers it to an owner of the plugin holding the tool', async () => {
    expect(await openMenu()).toBeInTheDocument();
  });

  it('does not offer it to a non-owner', async () => {
    libraryData.isOwner = false;
    expect(await openMenu()).toBeNull();
    // And nothing else in the menu went with it.
    expect(screen.getByRole('menuitem', { name: /Copy link/ })).toBeInTheDocument();
  });

  it('does not offer it for a plugin managed in another format, even to its owner', async () => {
    // That plugin is edited in its own repository and the DELETE route
    // refuses one (422) — the item would be a button whose only outcome is
    // that refusal.
    libraryData.linksAreManaged = false;
    expect(await openMenu()).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Copy link/ })).toBeInTheDocument();
  });
});

describe('the confirmation', () => {
  it('names the dependent skills, the plugins that carry it, and the secret counts', async () => {
    fireEvent.click((await openMenu())!);

    expect(await screen.findByRole('heading', { name: 'Delete heyreach?' })).toBeInTheDocument();
    await waitFor(() => expect(toolsMock.getToolDependents).toHaveBeenCalledWith('heyreach'));
    expect(await screen.findByText('outreach, follow-up')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(
      screen.getByText('1 stored key and 3 sign-ins stored under its name are wiped.'),
    ).toBeInTheDocument();
    // A count, never a value.
    expect(screen.queryByText(/sk-|Bearer /)).toBeNull();
  });

  it('says plainly when nothing depends on it', async () => {
    toolsMock.getToolDependents.mockResolvedValue({
      ...DEPENDENTS,
      skills: [],
      plugins: [],
      storedKeys: 0,
      signIns: 0,
    });
    fireEvent.click((await openMenu())!);

    expect(await screen.findByText('No skill you can see names it in its allowed tools.')).toBeInTheDocument();
    expect(screen.getByText('No other plugin carries it.')).toBeInTheDocument();
    expect(screen.getByText('Nothing is stored under its name.')).toBeInTheDocument();
  });

  it('will not delete on a dependents read it could not make', async () => {
    toolsMock.getToolDependents.mockRejectedValue(new Error('Network is down.'));
    fireEvent.click((await openMenu())!);

    expect(await screen.findByText('Network is down.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete tool' })).toBeDisabled();
  });

  it('keeps Delete disabled until the tool\'s name is typed exactly', async () => {
    fireEvent.click((await openMenu())!);
    await screen.findByText('outreach, follow-up');
    const del = screen.getByRole('button', { name: 'Delete tool' });
    // Loaded, dependents shown — and still not armed.
    expect(del).toBeDisabled();
    confirmName('heyreac');
    expect(del).toBeDisabled();
    confirmName('HEYREACH');
    expect(del).toBeDisabled();
    confirmName();
    expect(del).toBeEnabled();
    // Typing is not doing: nothing has been deleted yet.
    expect(toolsMock.deleteTool).not.toHaveBeenCalled();
  });

  it('deletes nothing until it is confirmed, and nothing at all on Cancel', async () => {
    fireEvent.click((await openMenu())!);
    await screen.findByText('outreach, follow-up');
    confirmName();
    expect(toolsMock.deleteTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete heyreach?' })).toBeNull());
    expect(toolsMock.deleteTool).not.toHaveBeenCalled();
  });
});

describe('confirming', () => {
  it("deletes the tool, then lands on the tool's plugin and reloads the library", async () => {
    fireEvent.click((await openMenu())!);
    await screen.findByText('outreach, follow-up');
    confirmName();
    fireEvent.click(screen.getByRole('button', { name: 'Delete tool' }));

    await waitFor(() => expect(toolsMock.deleteTool).toHaveBeenCalledWith('heyreach'));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent('/skills-and-tools/plugins/gtm'),
    );
    expect(screen.getByText('Plugin page')).toBeInTheDocument();
    // The cards and the sidebar are stale the moment the tool is gone.
    expect(libraryData.reload).toHaveBeenCalled();
    expect(libraryData.reloadPlugins).toHaveBeenCalled();
  });

  it("keeps the page and shows the backend's refusal verbatim", async () => {
    toolsMock.deleteTool.mockRejectedValue(new Error("Only the owners of this tool's plugin can delete it."));
    fireEvent.click((await openMenu())!);
    await screen.findByText('outreach, follow-up');
    confirmName();
    fireEvent.click(screen.getByRole('button', { name: 'Delete tool' }));

    expect(
      await screen.findByText("Only the owners of this tool's plugin can delete it."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('pathname')).toHaveTextContent('/skills-and-tools/tools/heyreach');
  });
});

/**
 * The dialog outlives a navigation: a tool page can route to ANOTHER tool with
 * it still open, and the dependents read for the new slug does not resolve
 * instantly. What must not survive that is the confirmation — a name typed for
 * the old tool arming Delete against the new one.
 */
describe('when the tool changes underneath it', () => {
  function renderDialog(slug: string, name: string) {
    return render(
      <DeleteToolDialog slug={slug} name={name} onClose={vi.fn()} onDeleted={vi.fn()} />,
    );
  }

  it('drops the typed confirmation and the old dependents', async () => {
    let resolveSecond: ((d: ToolDependents) => void) | undefined;
    toolsMock.getToolDependents
      .mockResolvedValueOnce(DEPENDENTS)
      .mockImplementationOnce(() => new Promise<ToolDependents>((r) => (resolveSecond = r)));

    const { rerender } = renderDialog('heyreach', 'heyreach');
    await screen.findByText('outreach, follow-up');
    confirmName();
    expect(screen.getByRole('button', { name: 'Delete tool' })).toBeEnabled();

    // The page navigates; the new tool's dependents have not arrived yet.
    rerender(<DeleteToolDialog slug="other" name="other" onClose={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Delete tool' })).toBeDisabled();
    expect(screen.queryByText('outreach, follow-up')).toBeNull();
    expect(screen.getByText('Checking what depends on this tool…')).toBeInTheDocument();

    // And once they do, it is the NEW tool's name that arms it.
    resolveSecond!({ ...DEPENDENTS, slug: 'other', name: 'other', skills: [], plugins: [] });
    await screen.findByText('No other plugin carries it.');
    confirmName('heyreach');
    expect(screen.getByRole('button', { name: 'Delete tool' })).toBeDisabled();
    confirmName('other');
    expect(screen.getByRole('button', { name: 'Delete tool' })).toBeEnabled();
    expect(toolsMock.deleteTool).not.toHaveBeenCalled();
  });
});
