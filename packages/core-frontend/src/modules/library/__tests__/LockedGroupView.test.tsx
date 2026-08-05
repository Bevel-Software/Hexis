import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GroupSummary } from '../services/groups.api';

/**
 * The locked group page: what it is allowed to say, and what asking to join
 * does.
 *
 * Copy is asserted verbatim throughout because it IS the feature — a locked
 * group's whole surface is four sentences, and every one of them was chosen to
 * describe the group without describing its contents.
 */

const apiMock = vi.hoisted(() => ({
  requestGroupAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));
vi.mock('../services/groups.api', () => ({
  requestGroupAccess: apiMock.requestGroupAccess,
  AlreadyReadableError: apiMock.AlreadyReadableError,
}));

import { LibraryToastProvider } from '../state/toast';
import { LockedGroupView } from '../components/LockedGroupView';
import { joinNames, firstNames } from '../utils/names';

const finance = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  name: 'Finance',
  folders: ['Groups/Finance'],
  canRead: false,
  canWrite: false,
  skillCount: 2,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

function renderLocked(group: GroupSummary = finance()) {
  const onRequested = vi.fn();
  const onUnlocked = vi.fn();
  const onManage = vi.fn();
  const view = render(
    <MemoryRouter>
      <LibraryToastProvider>
        <LockedGroupView
          group={group}
          onRequested={onRequested}
          onUnlocked={onUnlocked}
          onManage={onManage}
        />
      </LibraryToastProvider>
    </MemoryRouter>,
  );
  return { ...view, onRequested, onUnlocked, onManage };
}

const askButton = () => screen.getByRole('button', { name: 'Subscribe to its skills and tools' });

describe('LockedGroupView', () => {
  beforeEach(() => {
    apiMock.requestGroupAccess.mockReset();
    apiMock.requestGroupAccess.mockResolvedValue(undefined);
  });

  it('states the group, who runs it, and how much is in it — and nothing else', () => {
    renderLocked();
    expect(screen.getByRole('heading', { name: 'Finance', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Run by Olga Ivanova.')).toBeInTheDocument();
    expect(screen.getByText('2 skills · 1 tool — visible to members only.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All groups' })).toHaveAttribute(
      'href',
      '/skills-and-tools/groups',
    );
  });

  it('never leaks an address, even when the summary carries one', () => {
    // The backend nulls emails for non-readers; this asserts the view would not
    // print one if a future wire change ever handed it one anyway.
    const { container } = renderLocked(
      finance({ owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] } }),
    );
    expect(container.textContent).not.toContain('@');
  });

  it('pluralises the counts line honestly', () => {
    renderLocked(finance({ skillCount: 1, toolCount: 0 }));
    expect(screen.getByText('1 skill · 0 tools — visible to members only.')).toBeInTheDocument();
  });

  it('asks once, disables while in flight, and flips to the Requested box', async () => {
    let release = () => {};
    apiMock.requestGroupAccess.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    const { onRequested } = renderLocked();

    fireEvent.click(askButton());
    expect(askButton()).toBeDisabled();
    fireEvent.click(askButton());
    expect(apiMock.requestGroupAccess).toHaveBeenCalledTimes(1);
    expect(apiMock.requestGroupAccess).toHaveBeenCalledWith('Finance');

    release();
    expect(
      await screen.findByText('Requested — Olga Ivanova decides who joins.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Subscribe to its skills and tools' }),
    ).not.toBeInTheDocument();
    expect(onRequested).toHaveBeenCalledTimes(1);
  });

  it('confirms with the first names of the people who now have to decide', async () => {
    renderLocked();
    fireEvent.click(askButton());
    expect(
      await screen.findByText('Asked Olga — you get its skills and tools if they let you in.'),
    ).toBeInTheDocument();
  });

  it('shows the Requested box with no button when the server already has one', () => {
    renderLocked(finance({ hasRequested: true }));
    expect(screen.getByText('Requested — Olga Ivanova decides who joins.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Subscribe to its skills and tools' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to the admins, in the plural, when nobody is named', async () => {
    renderLocked(finance({ owners: { roles: [], users: [] }, writers: { roles: [], users: [] } }));
    expect(screen.getByText('Run by the workspace admins.')).toBeInTheDocument();
    fireEvent.click(askButton());
    expect(
      await screen.findByText(
        'Asked the admins — you get its skills and tools if they let you in.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Requested — the workspace admins decide who joins.'),
    ).toBeInTheDocument();
  });

  it('falls back through writers when the folder names no owner', () => {
    renderLocked(
      finance({
        owners: { roles: [], users: [] },
        writers: { roles: ['Admin'], users: [{ name: 'Juan Viera', email: 'juan@bevel.software' }] },
      }),
    );
    expect(screen.getByText('Run by Juan Viera, Admin.')).toBeInTheDocument();
  });

  it('opens the group rather than complaining when access already landed', async () => {
    apiMock.requestGroupAccess.mockRejectedValue(new apiMock.AlreadyReadableError());
    const { onUnlocked, onRequested } = renderLocked();
    fireEvent.click(askButton());
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Requested/)).not.toBeInTheDocument();
  });

  it('re-enables the button and says so when the request fails', async () => {
    apiMock.requestGroupAccess.mockRejectedValue(new Error('boom'));
    const { onRequested } = renderLocked();
    fireEvent.click(askButton());
    expect(await screen.findByText("Couldn't send that — try again.")).toBeInTheDocument();
    expect(askButton()).not.toBeDisabled();
    expect(onRequested).not.toHaveBeenCalled();
  });

  it('gives a locked-out admin the self-service way in', () => {
    const { onManage } = renderLocked(finance({ canWrite: true, folders: ['Groups/Finance'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage access' }));
    expect(onManage).toHaveBeenCalledWith('Groups/Finance');
  });

  it('offers no Manage access to somebody who cannot write the folder', () => {
    renderLocked();
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
  });
});

describe('name helpers', () => {
  it('joins names the way a person says them out loud', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Olga'])).toBe('Olga');
    expect(joinNames(['Olga', 'Juan'])).toBe('Olga and Juan');
    expect(joinNames(['Olga', 'Juan', 'Ali'])).toBe('Olga, Juan and Ali');
  });

  it('takes the first token of each name', () => {
    expect(firstNames(['Olga Ivanova', 'Juan Viera', 'GTM Team'])).toEqual(['Olga', 'Juan', 'GTM']);
  });
});
