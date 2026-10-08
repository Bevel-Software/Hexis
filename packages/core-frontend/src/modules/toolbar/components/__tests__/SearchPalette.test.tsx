import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import { SearchPalette } from '../SearchPalette';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext } from '../../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../../workspace/__tests__/testFixtures';

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
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPalette({ compact = false }: { compact?: boolean } = {}) {
  const git = {
    status: { branch: 'main', hasUpstream: true, unmergedFromUpstream: false },
  } as unknown as GitContextValue;
  return render(
    <MemoryRouter initialEntries={['/workspace/main']}>
      <WorkspaceContext.Provider value={makeWorkspaceFixture({ fileTree: TREE })}>
        <GitContext.Provider value={git}>
          <button type="button">Elsewhere</button>
          <SearchPalette compact={compact} />
          <LocationProbe />
        </GitContext.Provider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

const trigger = () => screen.getByRole('button', { name: /search pages, skills, tools and plugins/i });
const input = () => screen.getByRole('combobox', { name: /search pages, skills, tools and plugins/i });
const options = () => within(screen.getByRole('listbox')).queryAllByRole('option');

beforeEach(() => {
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
    expect(screen.queryByRole('button', { name: /search pages/i })).toBeNull();
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
    expect(screen.getByRole('status')).toHaveTextContent('No pages or items match “zzz”');
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
      'No pages match “zzz”, and skills, tools and plugins couldn’t be loaded.',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('No pages or items match');
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
