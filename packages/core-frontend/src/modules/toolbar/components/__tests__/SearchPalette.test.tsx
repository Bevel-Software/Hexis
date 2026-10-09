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
      `/workspace/${encodeURIComponent(DEFAULT_BRANCH)}/${KB}/Plugins/GTM/linear.tool`,
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

  it('says the catalog failed, not that nothing matched, when every catalog request fails', async () => {
    api.listSkills.mockRejectedValue(new Error('down'));
    api.listToolSecrets.mockRejectedValue(new Error('down'));
    api.listPlugins.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Couldn’t load skills, tools and plugins.'));

    await user.type(input(), 'zzz');
    expect(options()).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nothing matches “zzz”. Couldn’t load skills, tools and plugins.',
    );
  });

  it('groups plugins with skills and tools', async () => {
    api.listPlugins.mockResolvedValue([
      { name: 'gtm', displayName: 'GTM', folders: ['Plugins/GTM'], canRead: true, canWrite: false, isOwner: false, skillCount: 0, toolCount: 0 },
    ]);
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'gtm');
    const group = await screen.findByRole('group', { name: 'Skills, tools & plugins' });
    expect(within(group).getByRole('option', { name: /GTM/ })).toBeInTheDocument();
  });

  it('keeps focus in the input when the panel around the rows is pressed, so the keyboard still drives it', async () => {
    const user = userEvent.setup();
    const elsewhere = () => screen.getByRole('button', { name: 'Elsewhere' });
    renderPalette();
    elsewhere().focus();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('option', { name: /linear/i });

    await user.click(screen.getByRole('status'));
    await user.click(screen.getByRole('listbox'));
    expect(input()).toHaveFocus();

    // Escape is still the input's, so focus goes back to where it was.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(elsewhere()).toHaveFocus();
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
      'Create new pageC (shortcut C)',
      'Invite peopleShift I (shortcut Shift I)',
      'Connect your agent',
      'Go to Skills & ToolsShift S (shortcut Shift S)',
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
    await user.hover(screen.getByRole('option', { name: 'Invite people (shortcut Shift I)' }));
    const invite = screen.getByRole('option', { name: 'Invite people (shortcut Shift I)' });
    expect(invite).toHaveAttribute('aria-selected', 'true');

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
      'Create new pageC (shortcut C)',
      'Invite peopleShift I (shortcut Shift I)',
      'Go to Skills & ToolsShift S (shortcut Shift S)',
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
      'Go to KnowledgeShift K (shortcut Shift K)',
      'Go to Skills & ToolsShift S (shortcut Shift S)',
    ]);

    await user.clear(input());
    await user.type(input(), 'team');
    expect(groupRows('Actions')).toEqual(['Invite peopleShift I (shortcut Shift I)']);

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
    expect(groupRows('Actions')).toEqual([
      'Create new pageC (shortcut C)',
      'Go to Skills & ToolsShift S (shortcut Shift S)',
    ]);
    await user.type(input(), 'invite');
    expect(group('Actions')).toBeNull();
    await user.clear(input());
    await user.type(input(), 'app roles');
    expect(group('Actions')).toBeNull();
  });

  it('Create new page creates the page through the shared hook and closes the palette', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'new page');
    await user.keyboard('{Enter}');
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('calls the page command "Create new page", and finds it by "new", "create" or "new page"', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    expect(screen.queryByRole('option', { name: /^New page/ })).toBeNull();
    for (const query of ['new', 'create', 'new page']) {
      await user.clear(input());
      await user.type(input(), query);
      expect(groupRows('Actions')[0]).toBe('Create new pageC (shortcut C)');
    }
  });

  it('says why a command failed, in the palette it reopens', async () => {
    createPage.mockRejectedValue(new Error('Couldn’t create the page: refused'));
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /^Create new page/ }));
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
    await user.click(screen.getByRole('option', { name: 'Invite people (shortcut Shift I)' }));
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

  it('asks a settings row’s isShown again on each open, so a row its own command switched off is gone', async () => {
    // The shape of git's "Ask before deleting branches": shown while a stored
    // preference is off, and its command turns the preference back on.
    let skipped = true;
    const adminMenuItems: AdminMenuItem[] = [
      {
        id: 'ask-again',
        label: 'Ask again',
        isShown: () => skipped,
        onSelect: ({ closeMenu }) => {
          skipped = false;
          closeMenu();
        },
      },
    ];
    const user = userEvent.setup();
    renderPalette({ adminMenuItems });
    await user.click(trigger());
    await user.type(input(), 'ask again');
    expect(groupRows('Actions')).toEqual(['Settings: Ask again']);
    await user.keyboard('{Enter}');
    expect(skipped).toBe(false);

    await user.click(trigger());
    await user.type(input(), 'ask again');
    expect(group('Actions')).toBeNull();
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
    expect(screen.getByTestId('location-state')).toHaveTextContent(
      '{"startEditing":true,"startEditingPath":"knowledge-base/KnowledgeBase/Onboarding.md"}',
    );
  });

  it('merges the registry’s commands after core’s, and runs them with the menu’s context', async () => {
    const run = vi.fn();
    const commandActions: CommandAction[] = [
      {
        id: 'new-ontology',
        label: 'New ontology',
        group: 'Graph',
        shortcut: { key: 'o' },
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
    expect(groupRows('Actions')).toEqual(['New ontologyGraphO (shortcut O)', 'Create new pageC (shortcut C)']);
    expect(screen.queryByText('Impostor page')).toBeNull();

    const row = screen.getByRole('option', { name: /new ontology/i });
    expect(within(row).getByText('O', { selector: 'kbd' })).toHaveAttribute('aria-hidden');
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

  it('says that skills, tools and plugins could not load even while the suggested commands fill the list', async () => {
    api.listSkills.mockRejectedValue(new Error('down'));
    api.listPlugins.mockRejectedValue(new Error('down'));
    api.listToolSecrets.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    expect(groupRows('Actions').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Couldn’t load skills, tools and plugins.'));
  });
});

/**
 * C, ⇧I, ⇧K, ⇧S: the commonest commands without the palette — and never at
 * the expense of somebody typing.
 */
describe('SearchPalette: shortcuts', () => {
  const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
    fireEvent.keyDown(target, { key, ...init });
  /** A Shift key as the browser reports it: the capital, with `shiftKey`. */
  const shift = (letter: string, init: KeyboardEventInit = {}, target?: Element) =>
    press(letter.toUpperCase(), { shiftKey: true, ...init }, target);
  const location = () => screen.getByTestId('location').textContent;

  it('C creates a new page', () => {
    renderPalette();
    expect(press('c')).toBe(false); // handled: its default is prevented
    expect(createPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('⇧I opens Invite', () => {
    renderPalette();
    shift('i');
    expect(inviteOpen).toHaveBeenCalledTimes(1);
  });

  it('⇧S goes to Skills & Tools, ⇧K to Knowledge', () => {
    renderPalette();
    shift('s');
    expect(location()).toBe('/skills-and-tools');
    shift('k');
    expect(location()).toBe('/workspace');
  });

  it('runs C only without Shift, and the Shift keys only with it', () => {
    renderPalette();
    expect(shift('c')).toBe(true); // let through: a capital C
    press('i');
    press('k');
    press('s');
    expect(createPage).not.toHaveBeenCalled();
    expect(inviteOpen).not.toHaveBeenCalled();
    expect(location()).toBe('/workspace/main');
  });

  it('does nothing for G then K, G then S, ⇧E or ⇧A', () => {
    publishEditablePage('knowledge-base/KnowledgeBase/Onboarding.md');
    renderPalette({ openFilePath: 'knowledge-base/KnowledgeBase/Onboarding.md', onboardingPending: true });
    press('g');
    press('k');
    press('g');
    press('s');
    shift('e');
    shift('a');
    expect(location()).toBe('/workspace/main');
    expect(screen.getByTestId('location-state').textContent).toBe('null');
  });

  it('shows each key as one keycap on the command it runs, all of one width, and says it as words', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    const row = (name: string) => screen.getByRole('option', { name });
    const keycap = (name: string) => row(name).querySelector('kbd')!;

    // Not an Apple device under jsdom: "Shift K", not "⇧K".
    expect(row('Create new page (shortcut C)')).toHaveAttribute('aria-keyshortcuts', 'C');
    expect(row('Invite people (shortcut Shift I)')).toHaveAttribute('aria-keyshortcuts', 'Shift+I');
    expect(row('Go to Skills & Tools (shortcut Shift S)')).toHaveAttribute('aria-keyshortcuts', 'Shift+S');
    expect(keycap('Create new page (shortcut C)').textContent).toBe('C');
    expect(keycap('Invite people (shortcut Shift I)').textContent).toBe('Shift I');
    expect(keycap('Go to Skills & Tools (shortcut Shift S)').textContent).toBe('Shift S');
    const caps = screen.getAllByRole('option').flatMap((o) => [...o.querySelectorAll('kbd')]);
    expect(caps).toHaveLength(3);
    for (const cap of caps) {
      expect(cap).toHaveAttribute('aria-hidden', 'true');
      expect(cap).toHaveClass('w-14', 'inline-flex', 'justify-center');
    }

    await user.type(input(), 'knowledge');
    expect(keycap('Go to Knowledge (shortcut Shift K)').textContent).toBe('Shift K');
  });

  it('gives Edit this page, Connect your agent and the settings rows no key', async () => {
    publishEditablePage('knowledge-base/KnowledgeBase/Onboarding.md');
    const user = userEvent.setup();
    renderPalette({
      openFilePath: 'knowledge-base/KnowledgeBase/Onboarding.md',
      adminMenuItems: [{ id: 'stub-path', label: 'Stub page', path: '/stub-page', order: 95 }],
    });
    await user.click(trigger());
    for (const query of ['edit', 'connect', 'settings']) {
      await user.clear(input());
      await user.type(input(), query);
      for (const option of within(screen.getByRole('group', { name: 'Actions' })).getAllByRole('option')) {
        expect(option.querySelector('kbd')).toBeNull();
        expect(option).not.toHaveAttribute('aria-keyshortcuts');
      }
    }
  });

  it('leaves keys alone in a field, a select or an editor', () => {
    renderPalette();
    const field = document.createElement('input');
    const select = document.createElement('select');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const line = document.createElement('p');
    editor.appendChild(line);
    document.body.append(field, select, editor);
    try {
      for (const target of [field, select, line]) {
        expect(press('c', {}, target)).toBe(true);
        expect(shift('i', {}, target)).toBe(true);
        expect(shift('k', {}, target)).toBe(true);
        expect(shift('s', {}, target)).toBe(true);
      }
      expect(createPage).not.toHaveBeenCalled();
      expect(inviteOpen).not.toHaveBeenCalled();
      expect(location()).toBe('/workspace/main');
    } finally {
      field.remove();
      select.remove();
      editor.remove();
    }
  });

  it('leaves keys alone with Ctrl, ⌘ or Alt held', () => {
    renderPalette();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      press('c', { [modifier]: true });
      shift('i', { [modifier]: true });
      shift('k', { [modifier]: true });
      shift('s', { [modifier]: true });
    }
    expect(createPage).not.toHaveBeenCalled();
    expect(inviteOpen).not.toHaveBeenCalled();
    expect(location()).toBe('/workspace/main');
  });

  it('leaves keys alone while a modal dialog is up', () => {
    renderPalette();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    try {
      press('c');
      shift('i');
      shift('k');
      shift('s');
      expect(createPage).not.toHaveBeenCalled();
      expect(inviteOpen).not.toHaveBeenCalled();
      expect(location()).toBe('/workspace/main');
    } finally {
      modal.remove();
    }
  });

  it('leaves every key to the query while the palette is open', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(trigger());
    await user.type(input(), 'cSIK');
    expect(input()).toHaveValue('cSIK');
    expect(createPage).not.toHaveBeenCalled();
    expect(inviteOpen).not.toHaveBeenCalled();
    expect(location()).toBe('/workspace/main');
    // A key on the panel around the input is the query's too, not a command's.
    shift('s', {}, screen.getByRole('listbox'));
    expect(location()).toBe('/workspace/main');
  });

  it('lets the key through where its command is not on offer: ⇧I for someone who is not an admin', () => {
    renderPalette({ admin: false });
    expect(shift('i')).toBe(true);
    expect(inviteOpen).not.toHaveBeenCalled();
  });

  // A distribution's command gets a working key for the `shortcut` it set,
  // under the same guards: the hint on its row is never a key that does
  // nothing.
  it('binds a registry command’s letter, with or without Shift, and leaves it alone in a field', () => {
    const plain = vi.fn();
    const shifted = vi.fn();
    renderPalette({
      commandActions: [
        { id: 'new-ontology', label: 'New ontology', shortcut: { key: 'o' }, visible: () => true, run: plain },
        { id: 'open-graph', label: 'Open graph', shortcut: { key: 'O', shift: true }, visible: () => true, run: shifted },
      ],
    });
    press('o');
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).not.toHaveBeenCalled();
    shift('o');
    expect(shifted).toHaveBeenCalledTimes(1);
    expect(plain).toHaveBeenCalledTimes(1);
    const field = document.createElement('input');
    document.body.appendChild(field);
    try {
      press('o', {}, field);
      shift('o', {}, field);
    } finally {
      field.remove();
    }
    expect(plain).toHaveBeenCalledTimes(1);
    expect(shifted).toHaveBeenCalledTimes(1);
  });

  it('drops a registry shortcut that is taken or not one letter, hint and all, and keeps the core key', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn();
    const user = userEvent.setup();
    renderPalette({
      commandActions: [
        // The same key as Create new page, and as Go to Knowledge.
        { id: 'clash', label: 'Clash', shortcut: { key: 'C' }, visible: () => true, run },
        { id: 'clash-shift', label: 'Clash shift', shortcut: { key: 'k', shift: true }, visible: () => true, run },
        // Two keys: not one letter.
        { id: 'two-keys', label: 'Two keys', shortcut: { key: 'gk' }, visible: () => true, run },
      ],
    });
    press('c');
    expect(createPage).toHaveBeenCalledTimes(1);
    shift('s');
    shift('k');
    expect(location()).toBe('/workspace');
    press('g');
    press('k');
    expect(run).not.toHaveBeenCalled();
    // The rows stay, with no key shown.
    await user.click(trigger());
    await user.type(input(), 'clash');
    expect(groupRows('Actions')).toEqual(['Clash', 'Clash shift']);
    await user.clear(input());
    await user.type(input(), 'two keys');
    expect(groupRows('Actions')).toEqual(['Two keys']);
    expect(error).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });
});
