import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirectoryGroupsPage } from '../components/DirectoryGroupsPage';
import { AdminContext } from '../state/admin.context';
import { AppRegistryContext, EMPTY_REGISTRY } from '../../../core/registry';
import { addGroupMember, getGroupsRoster, type GroupsRoster } from '../services/groups.api';
import { suggestPrincipals, type SuggestResponse } from '../../access/api';

vi.mock('../services/groups.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/groups.api')>();
  return { ...actual, getGroupsRoster: vi.fn(), addGroupMember: vi.fn() };
});
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, suggestPrincipals: vi.fn() };
});

/** The component's debounce, plus slack — how long "no request" has to hold. */
const PAST_DEBOUNCE_MS = 350;

const ALICE = { name: 'Alice Green', email: 'alice@example.com' };
const PAT = { name: 'Pat Kim', email: 'pat@example.com' };

function people(...list: { name: string; email: string }[]): SuggestResponse {
  return { roles: [], groups: [], people: list, peopleWithheld: false };
}

const MANUAL_ROSTER: GroupsRoster = {
  mode: 'manual',
  groups: [
    {
      canonical: 'product',
      displayName: 'Product',
      members: ['pat@example.com'],
      referencedBy: [],
      assignedToRoles: [],
    },
    {
      canonical: 'design',
      displayName: 'Design',
      members: [],
      referencedBy: [],
      assignedToRoles: [],
    },
  ],
  groupsHealth: { ok: true },
};

function renderPage() {
  return render(
    <AppRegistryContext.Provider value={EMPTY_REGISTRY}>
      <AdminContext.Provider
        value={{
          isAdmin: true,
          unreadCount: 0,
          lastSeen: null,
          markSeen: () => {},
          refresh: () => {},
          rolesConfigCorrupted: false,
          rolesConfigErrors: [],
          runRolesRecovery: async () => {},
        }}
      >
        <DirectoryGroupsPage />
      </AdminContext.Provider>
    </AppRegistryContext.Provider>,
  );
}

/** The Add button belonging to a member input's row. */
function addButtonFor(input: HTMLElement) {
  return within(input.closest('div')!.parentElement!).getByRole('button', { name: 'Add' });
}

beforeEach(() => {
  vi.mocked(getGroupsRoster).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(addGroupMember).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(suggestPrincipals).mockReset().mockResolvedValue(people(ALICE));
});

describe('DirectoryGroupsPage: add-member people suggestions', () => {
  it('suggests people by name and email, from the same source the roles page uses', async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'al');

    expect(await screen.findByText('Alice Green')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    // The access suggest endpoint on the default-branch workspace — exactly
    // what Roles & Members and the access dialog ask.
    expect(suggestPrincipals).toHaveBeenCalledWith('target-company-state', 'al');
  });

  it("excludes the group's current members from the suggestions", async () => {
    vi.mocked(suggestPrincipals).mockResolvedValue(people(PAT, ALICE));
    renderPage();
    // Product already has pat@example.com — suggesting him would offer a no-op.
    const input = await screen.findByRole('textbox', { name: 'Add member to Product' });
    await userEvent.type(input, 'ex');

    expect(await screen.findByText('Alice Green')).toBeInTheDocument();
    expect(screen.queryByText('Pat Kim')).not.toBeInTheDocument();
  });

  it('choosing a suggestion adds the person exactly as typing the email would', async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'ali');
    await userEvent.click(await screen.findByText('Alice Green'));

    await waitFor(() =>
      expect(addGroupMember).toHaveBeenCalledWith('design', 'alice@example.com'),
    );
    // The input is cleared, as after any successful add.
    await waitFor(() => expect(input).toHaveValue(''));

    // The typed path lands on the identical request.
    vi.mocked(addGroupMember).mockClear();
    await userEvent.type(input, 'alice@example.com{Enter}');
    await waitFor(() =>
      expect(addGroupMember).toHaveBeenCalledWith('design', 'alice@example.com'),
    );
  });

  it('a full email that is not among the suggestions is still added', async () => {
    // Suggestions only ever know people the deployment has seen; a colleague
    // who has never signed in must still be addable.
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'newcomer@example.com');
    await userEvent.click(addButtonFor(input));

    await waitFor(() =>
      expect(addGroupMember).toHaveBeenCalledWith('design', 'newcomer@example.com'),
    );
  });

  it('a failed suggest request never blocks adding a valid email', async () => {
    vi.mocked(suggestPrincipals).mockRejectedValue(new Error('suggest is down'));
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'dana@example.com');
    await waitFor(() => expect(suggestPrincipals).toHaveBeenCalled());

    // The suggestion feature degrades; the form does not. No error banner, and
    // the add goes through unchanged.
    expect(screen.queryByText(/suggest is down/)).not.toBeInTheDocument();
    await userEvent.click(addButtonFor(input));
    await waitFor(() => expect(addGroupMember).toHaveBeenCalledWith('design', 'dana@example.com'));
  });

  it('makes no suggestion request below two characters', async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'a');
    await new Promise((resolve) => setTimeout(resolve, PAST_DEBOUNCE_MS));

    expect(suggestPrincipals).not.toHaveBeenCalled();
    expect(screen.queryByText('Alice Green')).not.toBeInTheDocument();
  });

  it('an IdP-synced group still has no member input at all', async () => {
    vi.mocked(getGroupsRoster).mockResolvedValue({
      ...MANUAL_ROSTER,
      mode: 'idp',
    });
    renderPage();
    expect(await screen.findByText('Product')).toBeInTheDocument();
    // Membership is managed in the directory — nothing to suggest into.
    expect(screen.queryByRole('textbox', { name: /Add member/ })).not.toBeInTheDocument();
    expect(suggestPrincipals).not.toHaveBeenCalled();
  });
});
