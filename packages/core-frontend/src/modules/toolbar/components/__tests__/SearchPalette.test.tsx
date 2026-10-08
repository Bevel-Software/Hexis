import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { SearchPalette } from '../SearchPalette';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext } from '../../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../../workspace/__tests__/testFixtures';
import { AdminContext, type AdminContextValue } from '../../../admin/state/admin.context';
import { AuthContext } from '../../../auth/state/auth.context';
import { authValue } from '../../../library/__tests__/auth-harness';
import { InviteDialogContext } from '../../../onboarding/state/invite-dialog.context';
import { resetOnboardingForTests } from '../../../onboarding/state/onboarding';
import { WELCOME_PATH } from '../../../onboarding/paths';
import { publishEditablePage } from '../../../workspace/state/editable-page';
import {
  ActiveAppIdContext,
  AppRegistryContext,
  makeRegistry,
  type AdminMenuItem,
  type AppDef,
} from '../../../../core/registry';
import type { CommandAction } from '../../commands/actions';

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listToolSecrets: vi.fn(),
  listPlugins: vi.fn(),
}));
vi.mock('../../../library/services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../library/services/library.api')>()),
  listSkills: api.listSkills,
}));
vi.mock('../../../secrets-vault/services/tool-secrets.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../secrets-vault/services/tool-secrets.api')>()),
  listToolSecrets: api.listToolSecrets,
}));
vi.mock('../../../library/services/plugins.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../library/services/plugins.api')>()),
  listPlugins: api.listPlugins,
}));
// New page's own naming and retrying is `useCreatePage`'s, pinned by the Get
// set up column's suite; here it is the command that calls it.
const createPage = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../../../workspace/hooks/useCreatePage', () => ({
  useCreatePage: () => ({ knowledgeRoot: 'knowledge-base/KnowledgeBase', createPage }),
}));
// The onboarding write is not what these tests are about.
vi.mock('../../../../lib/api', () => ({ authFetch: vi.fn(async () => ({ ok: true, status: 200 })) }));

const KB = 'knowledge-base';
const file = (relativePath: string): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'file',
});
const dir = (relativePath: string, children: FileTreeEntry[]): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'directory',
  children,
});

const TREE = dir('', [
  dir(KB, [
    file(`${KB}/access.md`),
    dir(`${KB}/KnowledgeBase`, [
      file(`${KB}/KnowledgeBase/Onboarding.md`),
      dir(`${KB}/KnowledgeBase/GTM`, [
        file(`${KB}/KnowledgeBase/GTM/access.md`),
        file(`${KB}/KnowledgeBase/GTM/Pricing.md`),
        file(`${KB}/KnowledgeBase/GTM/Team pricing.md`),
      ]),
    ]),
    dir(`${KB}/Plugins`, [dir(`${KB}/Plugins/GTM`, [file(`${KB}/Plugins/GTM/Pricing notes.md`)])]),
  ]),
]);

function LocationProbe() {
  const location = useLocation();
  return (
    <>
      <div data-testid="location">{location.pathname + location.search}</div>
      <div data-testid="location-state">{JSON.stringify(location.state)}</div>
    </>
  );
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

/** The two core apps, as the shell merges them into the registry. */
const APPS: AppDef[] = [
  { id: 'knowledge', label: 'Knowledge', path: '/workspace', order: 10, element: <></> },
  { id: 'skills-tools', label: 'Skills & Tools', path: '/skills-and-tools', order: 20, element: <></> },
];

const inviteOpen = vi.fn();

interface PaletteOptions {
  compact?: boolean;
  admin?: boolean;
  /** The connect-your-agent onboarding is still open. */
  onboardingPending?: boolean;
  openFilePath?: string | null;
  adminMenuItems?: AdminMenuItem[];
  commandActions?: CommandAction[];
}

function renderPalette({
  compact = false,
  admin = true,
  onboardingPending = false,
  openFilePath = null,
  adminMenuItems = [],
  commandActions,
}: PaletteOptions = {}) {
  const git = {
    status: { branch: 'main', hasUpstream: true, unmergedFromUpstream: false },
  } as unknown as GitContextValue;
  const auth = authValue({
    user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: !onboardingPending },
  });
  const registry = makeRegistry({ apps: APPS, adminMenuItems, commandActions });
  return render(
    <MemoryRouter initialEntries={['/workspace/main']}>
      <AppRegistryContext.Provider value={registry}>
        <ActiveAppIdContext.Provider value="knowledge">
          <AuthContext.Provider value={auth}>
            <AdminContext.Provider value={adminValue(admin)}>
              <InviteDialogContext.Provider value={{ open: inviteOpen, invitedRevision: 0 }}>
                <WorkspaceContext.Provider value={makeWorkspaceFixture({ fileTree: TREE, openFilePath })}>
                  <GitContext.Provider value={git}>
                    <button type="button">Elsewhere</button>
                    <SearchPalette compact={compact} />
                    <LocationProbe />
                  </GitContext.Provider>
                </WorkspaceContext.Provider>
              </InviteDialogContext.Provider>
            </AdminContext.Provider>
          </AuthContext.Provider>
        </ActiveAppIdContext.Provider>
      </AppRegistryContext.Provider>
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: /search or run a command/i });
const input = () => screen.getByRole('combobox', { name: /search or run a command/i });
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');
const group = (name: string) => screen.queryByRole('group', { name });
const groupRows = (name: string) =>
  within(screen.getByRole('group', { name })).getAllByRole('option').map((o) => o.textContent);

beforeEach(() => {
  resetOnboardingForTests();
  publishEditablePage(null);
  inviteOpen.mockReset();
  createPage.mockReset().mockResolvedValue('knowledge-base/KnowledgeBase/Untitled.md');
  api.listSkills.mockReset().mockResolvedValue([
    { name: 'pricing-calculator', description: '', path: 'Plugins/GTM/skills/pricing-calculator' },
  ]);
  api.listToolSecrets.mockReset().mockResolvedValue([
    { slug: 'linear', name: 'Linear', path: 'Plugins/GTM/linear.tool', type: 'http', setup: null, canWrite: false, variables: [] },
  ]);
  api.listPlugins.mockReset().mockResolvedValue([]);
});

describe('SearchPalette', () => {
  it('opens on click with the input focused, and Escape closes it back to the trigger', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(screen.queryByRole('combobox')).toBeNull();

    await user.click(trigger());
    expect(input()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('opens on Ctrl+K from anywhere, and Escape returns focus to where it was', async () => {
    const user = userEvent.setup();
    renderPalette();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();

    await user.keyboard('{Control>}k{/Control}');
    expect(input()).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  it('is reachable by Ctrl+K on a compact toolbar, where the box itself is not drawn', async () => {
    const user = userEvent.setup();
    renderPalette({ compact: true });
    expect(screen.queryByRole('button', { name: /search or run a command/i })).toBeNull();
    await user.keyboard('{Control>}k{/Control}');
    expect(input()).toHaveFocus();
  });

  it('ignores the shortcut while a modal dialog is up', () => {
    renderPalette();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
      expect(screen.queryByRole('combobox')).toBeNull();
    } finally {
      modal.remove();
    }
  });

  it('filters pages from the Knowledge tree by name, best match first, and never offers access rules or Plugins/', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'pric');

    const pages = within(screen.getByRole('group', { name: 'Pages' })).getAllByRole('option');
    expect(pages.map((o) => o.textContent)).toEqual(['PricingGTM', 'Team pricingGTM']);
    expect(screen.queryByText('access')).toBeNull();
    expect(screen.queryByText('Pricing notes')).toBeNull();
  });

  it('opens the highlighted page on Enter via its workspace path, after arrowing to it', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'pric');
    await waitFor(() => expect(options().length).toBeGreaterThan(2));

    // Nothing but pages and items match `pric`, so the first row is a page.
    expect(group('Actions')).toBeNull();
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);
    await user.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[1].id);

    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/workspace/main/${KB}/KnowledgeBase/GTM/Team%20pricing.md`,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('fetches skills and tools only once the palette opens, and opens one at its item URL', async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(api.listSkills).not.toHaveBeenCalled();
    expect(api.listToolSecrets).not.toHaveBeenCalled();
    expect(api.listPlugins).not.toHaveBeenCalled();

    await user.click(trigger());
    expect(api.listSkills).toHaveBeenCalledTimes(1);
    expect(api.listToolSecrets).toHaveBeenCalledTimes(1);
    expect(api.listPlugins).toHaveBeenCalledTimes(1);

    await user.type(input(), 'linear');
    const row = await screen.findByRole('option', { name: /linear/i });
    await user.click(row);
    expect(screen.getByTestId('location')).toHaveTextContent(
      `/workspace/${DEFAULT_BRANCH}/${KB}/Plugins/GTM/linear.tool`,
    );
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await screen.findByRole('option', { name: /linear/i });
    await user.type(input(), 'zzz');
    expect(options()).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing matches “zzz”');
  });

  it('closes on Tab with focus on the search box, for the Tab to move on from', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    // `fireEvent`, not `user.keyboard`: user-event computes the Tab
    // destination from the unmounted input and throws. What is pinned here is
    // the half the palette owns — focus is on the box when the keydown ends,
    // which is where the browser's own Tab then starts from.
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('closes on an outside click without moving focus', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });
});

describe('SearchPalette: commands', () => {
  it('suggests a few commands above the pages before anything is typed', async () => {
    const user = userEvent.setup();
    renderPalette({ onboardingPending: true });
    await user.click(trigger());

    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Actions');
    expect(groups[1]).toHaveAccessibleName('Pages');
    expect(groupRows('Actions')).toEqual([
      'New pageC (shortcut C)',
      'Invite people',
      'Connect your agent',
      'Go to Skills & ToolsGS (shortcut G then S)',
    ]);
    // Nothing is highlighted until a row is picked (see the next test).
    expect(input()).not.toHaveAttribute('aria-activedescendant');
  });

  it('runs nothing on Enter with an empty query, until a row is picked with the arrows', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.keyboard('{Enter}');
    expect(createPage).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();
    expect(options().some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);

    // ↑ from no row starts at the bottom; ↓ from no row at the top.
    await user.keyboard('{ArrowUp}');
    expect(options()[options().length - 1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    await user.click(trigger());
    await user.keyboard('{ArrowDown}');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);
    await user.keyboard('{Enter}');
    expect(createPage).toHaveBeenCalledTimes(1);
  });

  it('highlights a hovered row with an empty query, and takes the best match again once something is typed', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.hover(screen.getByRole('option', { name: 'Invite people' }));
    expect(screen.getByRole('option', { name: 'Invite people' })).toHaveAttribute('aria-selected', 'true');

    await user.type(input(), 'invite');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);
    // Clearing the query clears the highlight with it.
    await user.clear(input());
    expect(input()).not.toHaveAttribute('aria-activedescendant');
    await user.keyboard('{Enter}');
    expect(inviteOpen).not.toHaveBeenCalled();
  });

  it('suggests no agent connection once that onboarding is over', async () => {
    const user = userEvent.setup();
    renderPalette({ onboardingPending: false });
    await user.click(trigger());
    expect(groupRows('Actions')).toEqual([
      'New pageC (shortcut C)',
      'Invite people',
      'Go to Skills & ToolsGS (shortcut G then S)',
    ]);
    // ...but it is still there to be typed for.
    await user.type(input(), 'connect');
    expect(groupRows('Actions')).toEqual(['Connect your agent']);
  });

  it('ranks commands by label and keywords, listed before the pages that match too', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());

    await user.type(input(), 'go to');
    expect(groupRows('Actions')).toEqual([
      'Go to KnowledgeGK (shortcut G then K)',
      'Go to Skills & ToolsGS (shortcut G then S)',
    ]);

    await user.clear(input());
    await user.type(input(), 'team');
    expect(groupRows('Actions')).toEqual(['Invite people']);

    await user.clear(input());
    await user.type(input(), 'on');
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Actions');
    expect(groupRows('Pages')).toContain('OnboardingKnowledge');
  });

  it('keeps admin-only commands from members', async () => {
    const user = userEvent.setup();
    renderPalette({ admin: false });
    await user.click(trigger());
    expect(groupRows('Actions')).toEqual(['New pageC (shortcut C)', 'Go to Skills & ToolsGS (shortcut G then S)']);
    await user.type(input(), 'invite');
    expect(group('Actions')).toBeNull();
    await user.clear(input());
    await user.type(input(), 'app roles');
    expect(group('Actions')).toBeNull();
  });

  it('New page creates the page through the shared hook and closes the palette', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'new page');
    await user.keyboard('{Enter}');
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says why a command failed, in the palette it reopens', async () => {
    createPage.mockRejectedValue(new Error('Couldn’t create the page: refused'));
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /^New page/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t create the page: refused');
    expect(input()).toHaveFocus();
    await user.keyboard('{Escape}');
    await user.click(trigger());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Invite people opens the invite dialog', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'Invite people' }));
    expect(inviteOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('Connect your agent and Go to … navigate', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'connect');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(WELCOME_PATH);

    await user.click(trigger());
    await user.type(input(), 'go to skills');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/skills-and-tools');
  });

  it('offers a settings command per profile-menu row: the default rows for members, the admin rows for admins', async () => {
    const adminMenuItems: AdminMenuItem[] = [
      { id: 'stub-path', label: 'Stub page', path: '/stub-page', order: 95 },
      { id: 'stub-admin', section: 'admin', label: 'Stub admin page', path: '/stub-admin' },
      {
        id: 'stub-dialog',
        label: 'Stub dialog',
        dialog: () => <></>,
      },
    ];
    const user = userEvent.setup();
    const { unmount } = renderPalette({ admin: false, adminMenuItems });
    await user.click(trigger());
    await user.type(input(), 'settings');
    expect(groupRows('Actions')).toEqual([
      'Settings: Account',
      'Settings: Secrets',
      'Settings: Audit log',
      'Settings: Stub page',
      'Settings: External agent access',
      'Settings: Browse available tools',
    ]);
    unmount();

    renderPalette({ admin: true, adminMenuItems });
    await user.click(trigger());
    // Six default rows, five admin rows: past the eight a page group gets.
    await user.type(input(), 'settings');
    expect(groupRows('Actions')).toHaveLength(11);
    await user.clear(input());
    await user.type(input(), 'settings: stub');
    expect(groupRows('Actions')).toEqual(['Settings: Stub page', 'Settings: Stub admin page']);
    await user.clear(input());
    await user.type(input(), 'app roles');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/roles-and-members');
  });

  it('offers Edit this page only while the page on screen can be opened for editing', async () => {
    const page = 'knowledge-base/KnowledgeBase/Onboarding.md';
    const user = userEvent.setup();
    renderPalette({ openFilePath: page });
    await user.click(trigger());
    await user.type(input(), 'edit');
    expect(group('Actions')).toBeNull();
    await user.keyboard('{Escape}');

    act(() => publishEditablePage(page));
    await user.click(trigger());
    await user.type(input(), 'edit');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/workspace/main/knowledge-base/KnowledgeBase/Onboarding.md',
    );
    expect(screen.getByTestId('location-state')).toHaveTextContent('{"startEditing":true}');
  });

  it('merges the registry’s commands after core’s, and runs them with the menu’s context', async () => {
    const run = vi.fn();
    const commandActions: CommandAction[] = [
      {
        id: 'new-ontology',
        label: 'New ontology',
        group: 'Graph',
        shortcut: ['O'],
        visible: (ctx) => ctx.isAdmin,
        run,
      },
      // Core's id: dropped rather than doubled.
      { id: 'new-page', label: 'Impostor page', visible: () => true, run: vi.fn() },
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    renderPalette({ commandActions });
    await user.click(trigger());
    await user.type(input(), 'new');
    expect(groupRows('Actions')).toEqual(['New pageC (shortcut C)', 'New ontologyGraphO (shortcut O)']);
    expect(screen.queryByText('Impostor page')).toBeNull();

    const row = screen.getByRole('option', { name: /new ontology/i });
    expect(within(row).getByText('O', { selector: 'kbd' }).parentElement).toHaveAttribute('aria-hidden');
    await user.click(row);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true, activeAppId: 'knowledge' }));
    error.mockRestore();
  });

  it('says why a command failed when it threw on the spot, not only when it rejected', async () => {
    const commandActions: CommandAction[] = [
      {
        id: 'explode',
        label: 'Explode',
        visible: () => true,
        run: () => {
          throw new Error('Couldn’t do that: refused');
        },
      },
    ];
    const user = userEvent.setup();
    renderPalette({ commandActions });
    await user.click(trigger());
    await user.type(input(), 'explode');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t do that: refused');
    expect(input()).toHaveFocus();
  });

  it('says that skills and tools could not load even while the suggested commands fill the list', async () => {
    api.listSkills.mockRejectedValue(new Error('down'));
    api.listPlugins.mockRejectedValue(new Error('down'));
    api.listToolSecrets.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    expect(groupRows('Actions').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Couldn’t load skills and tools.'));
  });
});

/**
 * C, G then K, G then S: the commonest commands without the palette — and
 * never at the expense of somebody typing.
 */
describe('SearchPalette: single-key shortcuts', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
    fireEvent.keyDown(target, { key, ...init });

  it('C creates a new page', () => {
    renderPalette();
    press('c');
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('G then K goes to Knowledge, G then S to Skills & Tools', () => {
    renderPalette();
    press('g');
    press('s');
    expect(screen.getByTestId('location')).toHaveTextContent('/skills-and-tools');
    press('g');
    press('k');
    expect(screen.getByTestId('location').textContent).toBe('/workspace');
  });

  it('shows the keys on the commands they run', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    const newPage = screen.getByRole('option', { name: 'New page (shortcut C)' });
    expect(within(newPage).getByText('C', { selector: 'kbd' }).parentElement).toHaveAttribute('aria-hidden');
    expect(screen.getByRole('option', { name: 'Go to Skills & Tools (shortcut G then S)' })).toBeInTheDocument();
    // Commands with no binding advertise none.
    expect(screen.getByRole('option', { name: 'Invite people' })).toBeInTheDocument();
  });

  it('leaves keys alone in a field or an editor', () => {
    renderPalette();
    const field = document.createElement('input');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('p');
    editor.appendChild(line);
    document.body.append(field, editor);
    try {
      press('c', {}, field);
      press('c', {}, line);
      press('g', {}, line);
      press('k', {}, line);
      expect(createPage).not.toHaveBeenCalled();
      expect(screen.getByTestId('location')).toHaveTextContent('/workspace/main');
    } finally {
      field.remove();
      editor.remove();
    }
  });

  it('leaves keys alone with a modifier held', () => {
    renderPalette();
    press('c', { ctrlKey: true });
    press('c', { metaKey: true });
    press('C', { shiftKey: true });
    press('c', { altKey: true });
    expect(createPage).not.toHaveBeenCalled();
  });

  it('leaves keys alone while a modal dialog is up', () => {
    renderPalette();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      press('c');
      expect(createPage).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
  });

  it('leaves keys to the query while the palette is open', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'c');
    expect(createPage).not.toHaveBeenCalled();
    expect(input()).toHaveValue('c');
  });

  it('forgets a G that waited more than a second for its K', () => {
    vi.useFakeTimers();
    try {
      renderPalette();
      press('g');
      act(() => {
        vi.advanceTimersByTime(1001);
      });
      press('k');
      expect(screen.getByTestId('location')).toHaveTextContent('/workspace/main');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries the second key on its own when it did not complete a sequence: G then C makes a page', () => {
    renderPalette();
    press('g');
    press('c');
    expect(createPage).toHaveBeenCalledTimes(1);
    // And G then G re-arms: the second G is the first key of a new sequence.
    press('g');
    press('g');
    press('s');
    expect(screen.getByTestId('location')).toHaveTextContent('/skills-and-tools');
  });

  it('forgets a pending G when the palette opens, so a K typed after Escape goes nowhere', async () => {
    const user = userEvent.setup();
    renderPalette();
    press('g');
    await user.click(trigger());
    await user.keyboard('{Escape}');
    press('k');
    expect(screen.getByTestId('location')).toHaveTextContent('/workspace/main');
  });

  // A distribution's command gets a working key for the `shortcut` it set,
  // under the same guards: the hint on its row is never a key that does
  // nothing.
  it('binds a registry command’s own keys, and leaves them alone in a field', () => {
    const run = vi.fn();
    renderPalette({
      commandActions: [{ id: 'new-ontology', label: 'New ontology', shortcut: ['O'], visible: () => true, run }],
    });
    press('o');
    expect(run).toHaveBeenCalledTimes(1);
    const field = document.createElement('input');
    document.body.appendChild(field);
    try {
      press('o', {}, field);
    } finally {
      field.remove();
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('drops a registry shortcut that collides with keys already bound, hint and all, and keeps the core key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn();
    const user = userEvent.setup();
    renderPalette({
      commandActions: [
        // The same key as New page.
        { id: 'clash', label: 'Clash', shortcut: ['C'], visible: () => true, run },
        // A bare G would swallow G then K.
        { id: 'swallow', label: 'Swallow', shortcut: ['g'], visible: () => true, run },
      ],
    });
    press('c');
    expect(createPage).toHaveBeenCalledTimes(1);
    press('g');
    press('k');
    expect(screen.getByTestId('location').textContent).toBe('/workspace');
    expect(run).not.toHaveBeenCalled();
    // The rows stay, with no key shown.
    await user.click(trigger());
    await user.type(input(), 'clash');
    expect(groupRows('Actions')).toEqual(['Clash']);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
