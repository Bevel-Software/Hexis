import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { GroupSummary } from '../services/groups.api';

/**
 * The all-groups index: which section a group lands in, what each row says, and
 * where it goes. The locked section is the reason this page exists, so most of
 * what is asserted here is about groups the caller cannot enter.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock('../services/groups.api', () => ({ listGroups: groupsMock.listGroups }));

import { LibraryProvider } from '../state/library-data';
import { GroupsIndexPage } from '../components/GroupsIndexPage';

const tool = (over: Partial<ToolSecrets> = {}): ToolSecrets => ({
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Groups/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
  ...over,
});

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [
    { name: 'outreach', description: '', path: 'Groups/GTM/outreach' },
    { name: 'scratch', description: '', path: 'Skills/scratch' },
  ],
  tools: [
    tool(),
    // An ungrouped sign-in — `Tools/slack.tool` is two segments, so no group.
    tool({
      slug: 'slack',
      name: 'slack',
      path: 'Tools/slack.tool',
      variables: [
        {
          name: 'API_KEY',
          scope: 'user',
          label: null,
          key: 'slack_API_KEY',
          adminConfigured: false,
          userConfigured: false,
        },
      ],
    }),
  ],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const summary = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  name: 'GTM',
  folders: ['Groups/GTM'],
  canRead: true,
  canWrite: false,
  skillCount: 4,
  toolCount: 2,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: { restricted: true, roles: ['GTM Team'], users: [] },
  hasRequested: false,
  ...over,
});

const LOCKED = summary({
  name: 'Finance',
  folders: ['Groups/Finance'],
  canRead: false,
  skillCount: 3,
  toolCount: 1,
  readers: null,
});

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname + location.search}</div>;
}

function renderIndex() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools/groups']}>
      <LibraryProvider>
        <Routes>
          <Route path="/skills-and-tools/groups" element={<GroupsIndexPage />} />
          <Route path="*" element={<div />} />
        </Routes>
        <LocationProbe />
      </LibraryProvider>
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;
const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('GroupsIndexPage', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue([summary(), LOCKED]);
  });

  it('names itself and its three sections', async () => {
    renderIndex();
    expect(await screen.findByRole('heading', { name: 'All groups', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText('A group carries skills and tools for the people in it.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yours' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: "Groups you're in" })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ask to join' })).toBeInTheDocument();
  });

  it('offers the two personal views with their own copy', async () => {
    renderIndex();
    expect(await screen.findByText('The skills you answer for')).toBeInTheDocument();
    expect(screen.getByText('Your sign-ins and the skills no group carries')).toBeInTheDocument();
    fireEvent.click(row(/^Owned by me/));
    await waitFor(() => expect(href()).toBe('/skills-and-tools/owned'));
  });

  it('hides Yours alone when nothing sits outside a group', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'outreach', description: '', path: 'Groups/GTM/outreach' }],
      tools: [tool()],
    });
    renderIndex();
    await screen.findByRole('heading', { name: 'All groups', level: 1 });
    expect(screen.queryByRole('button', { name: /^Yours alone/ })).not.toBeInTheDocument();
  });

  it("puts a readable group under Groups you're in, with its run-by line and totals", async () => {
    renderIndex();
    const gtm = await screen.findByRole('button', { name: /^GTM/ });
    expect(gtm).toHaveAccessibleName('GTM Run by Olga Ivanova 4 skills · 2 tools');
    fireEvent.click(gtm);
    await waitFor(() => expect(href()).toBe('/skills-and-tools/groups/GTM'));
  });

  it('marks a group the caller can change with an Owner badge', async () => {
    groupsMock.listGroups.mockResolvedValue([summary({ canWrite: true })]);
    renderIndex();
    expect(await screen.findByRole('button', { name: /^GTM Owner/ })).toBeInTheDocument();
  });

  it('shows the amber count when a group has integrations to set up', async () => {
    groupsMock.listGroups.mockResolvedValue([
      summary({
        name: 'Yours',
        folders: ['Groups/Yours'],
      }),
      summary(),
    ]);
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [
        tool({
          variables: [
            {
              name: 'API_KEY',
              scope: 'user',
              label: null,
              key: 'heyreach_API_KEY',
              adminConfigured: false,
              userConfigured: false,
            },
          ],
        }),
      ],
    });
    renderIndex();
    expect(await screen.findByRole('button', { name: /^GTM .* 1$/ })).toBeInTheDocument();
  });

  it('lists a group the caller cannot read under Ask to join, marked Locked', async () => {
    renderIndex();
    const finance = await screen.findByRole('button', { name: /^Finance/ });
    expect(finance).toHaveAccessibleName('Finance Run by Olga Ivanova 3 skills · 1 tools Locked');
    expect(screen.getByTitle('Locked')).toBeInTheDocument();
    fireEvent.click(finance);
    await waitFor(() => expect(href()).toBe('/skills-and-tools/groups/Finance'));
  });

  it('says Requested instead of Locked once the caller has asked to join', async () => {
    groupsMock.listGroups.mockResolvedValue([summary(), { ...LOCKED, hasRequested: true }]);
    renderIndex();
    // The one thing this row can tell you that you did not already know is
    // whether you have already asked — so it says that instead of the obvious.
    expect(await screen.findByTitle('Requested')).toBeInTheDocument();
    expect(screen.queryByTitle('Locked')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Finance/ })).toHaveAccessibleName(
      'Finance Run by Olga Ivanova 3 skills · 1 tools Requested',
    );
  });

  it('moves a locked group into Groups you’re in when an item grant reaches inside', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'budget', description: '', path: 'Groups/Finance/budget' }],
    });
    renderIndex();
    await screen.findByRole('button', { name: /^Finance/ });
    expect(screen.queryByRole('heading', { name: 'Ask to join' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Locked')).not.toBeInTheDocument();
  });

  it('drops the Ask to join section when every group is readable', async () => {
    groupsMock.listGroups.mockResolvedValue([summary()]);
    renderIndex();
    await screen.findByRole('button', { name: /^GTM/ });
    expect(screen.queryByRole('heading', { name: 'Ask to join' })).not.toBeInTheDocument();
  });

  it('lists a catalog-derived group with counts alone when no summary vouches for it', async () => {
    groupsMock.listGroups.mockResolvedValue([]);
    renderIndex();
    // One skill and one tool in Groups/GTM, and nothing claiming to know who
    // runs it — so the row states what it can count, not what it cannot.
    expect(await screen.findByRole('button', { name: 'GTM 1 skills · 1 tools' })).toBeInTheDocument();
  });

  it('offers a retry when the groups endpoint fails, and keeps Yours', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderIndex();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't load groups.");
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Groups you're in" })).not.toBeInTheDocument();

    groupsMock.listGroups.mockResolvedValue([summary()]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });

  it('says it is loading before the first group index arrives', () => {
    groupsMock.listGroups.mockReturnValue(new Promise(() => {}));
    renderIndex();
    expect(screen.getByText('Loading groups…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toBeInTheDocument();
  });
});
