import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PluginSummary } from '../services/plugins.api';
import type { PluginEntry } from '../utils/plugin-entries';

/**
 * The Library's Owner pill says what Owner lets someone do: as its tooltip,
 * and as the accessible description of the card or plugin row that carries it
 * (a button, whose children assistive tech does not describe). On a plugin it
 * also says that an owner may delete it. One component draws the pill on the
 * cards, the plugin rows and the skill page.
 */

vi.mock('../state/library-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/library-data')>()),
  useLibrary: () => ({
    pluginsLoading: false,
    pluginsError: null,
    pluginSummaries: [],
    reload: vi.fn(),
    reloadPlugins: vi.fn(),
  }),
}));
vi.mock('../../admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../admin')>()),
  useAdmin: () => ({ isAdmin: false }),
}));

import { OwnerPill } from '../components/OwnerPill';
import { LibraryCard, type LibraryCardProps } from '../components/LibraryCard';
import { PluginRows } from '../components/PluginRows';

const OWNER = 'Edit, download, and be its contact';
const PLUGIN_OWNER = 'Edit, download, delete it, and be its contact';
const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'components');

function card(owned: boolean) {
  render(
    <LibraryCard
      {...({
        kind: 'skill',
        id: 'rfi',
        name: 'rfi',
        description: 'Answers an RFI.',
        owned,
        status: { state: 'ok', text: 'Ready' },
        onOpen: vi.fn(),
      } as LibraryCardProps)}
    />,
  );
}

const summary = (isOwner: boolean): PluginSummary => ({
  name: 'gtm',
  displayName: 'GTM',
  folders: ['Plugins/GTM'],
  linksAreManaged: true,
  canRead: true,
  canWrite: true,
  isOwner,
  skillCount: 2,
  toolCount: 0,
  brokenLinks: 0,
  owners: { roles: [], users: [] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  isPrivate: false,
  hasRequested: false,
  requestNumber: null,
});

function pluginRow(isOwner: boolean) {
  const entry: PluginEntry = {
    name: 'gtm',
    label: 'GTM',
    summary: summary(isOwner),
    skillCount: 2,
    toolCount: 0,
    attention: 0,
    urgent: false,
    member: true,
  };
  render(
    <MemoryRouter>
      <PluginRows entries={[entry]} />
    </MemoryRouter>,
  );
}

describe('the Owner pill', () => {
  it('carries what Owner means as its tooltip and accessible description', () => {
    render(<OwnerPill />);
    const pill = screen.getByText('Owner');
    expect(pill).toHaveAttribute('title', OWNER);
    expect(pill).toHaveAccessibleDescription(OWNER);
  });

  it('describes the card it sits on to assistive tech', () => {
    card(true);
    expect(screen.getByRole('button', { name: /rfi/, description: OWNER })).toBeInTheDocument();
  });

  it('leaves a card the reader does not own undescribed', () => {
    card(false);
    expect(screen.getByRole('button', { name: /rfi/ })).not.toHaveAttribute('aria-describedby');
  });

  it('on a plugin row says an owner may also delete it, as the row button\'s description', () => {
    pluginRow(true);
    expect(screen.getByRole('button', { name: /^GTM/, description: PLUGIN_OWNER })).toBeInTheDocument();
    expect(screen.getByText('Owner')).toHaveAttribute('title', PLUGIN_OWNER);
  });

  it('is the only Owner pill the cards, the plugin rows and the skill page draw', () => {
    for (const file of ['LibraryCard.tsx', 'PluginRows.tsx', 'skill-page/SkillPage.tsx']) {
      const source = readFileSync(join(COMPONENTS, file), 'utf8');
      expect(source, file).toContain('<OwnerPill');
      // No second, bare pill beside it.
      expect(source, file).not.toMatch(/>\s*Owner\s*</);
    }
  });
});
