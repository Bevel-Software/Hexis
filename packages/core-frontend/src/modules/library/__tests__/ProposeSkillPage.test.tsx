import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { LibraryData } from '../hooks/useLibraryData';
import type { GroupSummary } from '../services/groups.api';

/**
 * The propose seam. The ROUTE and its `?group=` query are the frozen contract
 * (master plan §1) — everything the page renders is a placeholder the
 * change-request flow replaces — so what is pinned here is the contract: the
 * query is read, the group reaches the prompt, and the way back works.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock('../services/groups.api', () => ({ listGroups: groupsMock.listGroups }));

import { LibraryProvider } from '../state/library-data';
import { LibraryToastProvider } from '../state/toast';
import { ProposeSkillPage } from '../components/ProposeSkillPage';

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [],
  tools: [],
  ownedSkills: new Set<string>(),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const GTM: GroupSummary = {
  name: 'GTM',
  folders: ['Groups/GTM'],
  canRead: true,
  canWrite: false,
  skillCount: 1,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: { restricted: true, roles: ['GTM Team'], users: [] },
  hasRequested: false,
};

const GROUP_PROMPT =
  'Help me build a new skill or tool and propose it for the GTM group at Bevel. ' +
  'Ask me what it should do, draft it, then send it to the group for review.';

const GENERIC_PROMPT =
  'Help me build a new skill or tool at Bevel. ' +
  'Ask me what it should do, draft it, then send it for review.';

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname + location.search}</div>;
}

function renderPropose(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/skills-and-tools/propose${search}`]}>
      <LibraryToastProvider>
        <LibraryProvider>
          <Routes>
            <Route path="/skills-and-tools/propose" element={<ProposeSkillPage />} />
            <Route path="*" element={<div />} />
          </Routes>
          <LocationProbe />
        </LibraryProvider>
      </LibraryToastProvider>
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;
const writeText = vi.fn<(text: string) => Promise<void>>();

describe('ProposeSkillPage', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue([GTM]);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reads the group out of the query and builds the prompt around it', async () => {
    renderPropose('?group=GTM');
    expect(
      screen.getByRole('heading', { name: 'Propose a skill or tool for GTM', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(GROUP_PROMPT)).toBeInTheDocument();
    expect(
      screen.getByText(
        'You build with your agent, not here. Tell it what you need — it drafts the skill or tool and sends it to this group.',
      ),
    ).toBeInTheDocument();
    // The reviewer comes from the group's owners, once they arrive.
    expect(
      await screen.findByText('Olga Ivanova reviews it before it joins GTM.'),
    ).toBeInTheDocument();
  });

  it('walks back to the group it came from', async () => {
    renderPropose('?group=GTM');
    expect(screen.getByRole('link', { name: 'GTM' })).toHaveAttribute(
      'href',
      '/skills-and-tools/groups/GTM',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to GTM' }));
    await waitFor(() => expect(href()).toBe('/skills-and-tools/groups/GTM'));
  });

  it('names no reviewer when the group is unknown', async () => {
    groupsMock.listGroups.mockResolvedValue([]);
    renderPropose('?group=Finance');
    await waitFor(() => expect(screen.queryByText(/reviews it before/)).not.toBeInTheDocument());
    expect(
      screen.getByRole('heading', { name: 'Propose a skill or tool for Finance', level: 1 }),
    ).toBeInTheDocument();
  });

  it('has a group-less variant with its own prompt and its own way back', async () => {
    renderPropose('');
    expect(
      screen.getByRole('heading', { name: 'Propose a skill or tool', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(GENERIC_PROMPT)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    expect(screen.queryByText(/reviews it before/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }));
    await waitFor(() => expect(href()).toBe('/skills-and-tools'));
  });

  it('copies the prompt and says so', async () => {
    renderPropose('?group=GTM');
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(GROUP_PROMPT));
    expect(await screen.findByText('Prompt copied.')).toBeInTheDocument();
  });
});
