import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PluginSummary } from '../services/plugins.api';

/**
 * The locked plugin page: what it is allowed to say, and what asking to join
 * does.
 *
 * Copy is asserted verbatim throughout because it IS the feature — a locked
 * plugin's whole surface is four sentences, and every one of them was chosen to
 * describe the plugin without describing its contents.
 */

const apiMock = vi.hoisted(() => ({
  requestPluginAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));
vi.mock('../services/plugins.api', () => ({
  requestPluginAccess: apiMock.requestPluginAccess,
  AlreadyReadableError: apiMock.AlreadyReadableError,
}));

import { LibraryToastProvider } from '../state/toast';
import { LockedPluginView } from '../components/LockedPluginView';
import { joinNames, firstNames } from '../utils/names';

const finance = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  name: 'Finance',
  folders: ['Plugins/Finance'],
  canRead: false,
  canWrite: false,
  isOwner: false,
  skillCount: 2,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  hasRequested: false,
  requestNumber: null,
  requestFailure: null,
  ...over,
});

function renderLocked(plugin: PluginSummary = finance()) {
  const onRequested = vi.fn();
  const onUnlocked = vi.fn();
  const onManage = vi.fn();
  const view = render(
    <MemoryRouter>
      <LibraryToastProvider>
        <LockedPluginView
          plugin={plugin}
          onRequested={onRequested}
          onUnlocked={onUnlocked}
          onManage={onManage}
        />
      </LibraryToastProvider>
    </MemoryRouter>,
  );
  return { ...view, onRequested, onUnlocked, onManage };
}

const askButton = () => screen.getByRole('button', { name: 'Subscribe to this plugin' });
const pendingButton = () => screen.getByRole('button', { name: 'Requesting…' });
const noButton = () =>
  expect(screen.queryByRole('button', { name: /Subscribe to this plugin|Requesting…/ })).not.toBeInTheDocument();

describe('LockedPluginView', () => {
  beforeEach(() => {
    apiMock.requestPluginAccess.mockReset();
    apiMock.requestPluginAccess.mockResolvedValue({ ok: true, state: 'pending', number: null });
  });

  it('states the plugin, who runs it, and how much is in it. And nothing else', () => {
    renderLocked();
    expect(screen.getByRole('heading', { name: 'Finance', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Run by Olga Ivanova.')).toBeInTheDocument();
    expect(screen.getByText('2 skills · 1 tool. Visible once you have access.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Everything' })).toHaveAttribute(
      'href',
      '/skills-and-tools',
    );
  });

  it('calls the plugin by its display name — the same name the unlocked page uses', () => {
    renderLocked(finance({ name: 'finance', displayName: 'Finance & Ops' }));
    expect(screen.getByRole('heading', { name: 'Finance & Ops', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('finance')).toBeNull();
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
    expect(screen.getByText('1 skill · 0 tools. Visible once you have access.')).toBeInTheDocument();
  });

  it('says "Requesting…" on the click itself, refuses a second, and flips to the Requested box', async () => {
    let release = () => {};
    apiMock.requestPluginAccess.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    const { onRequested } = renderLocked();

    fireEvent.click(askButton());
    // Within one render: the label is the acknowledgement. A button that only
    // greyed out is what made the old multi-second wait look like a freeze.
    expect(pendingButton()).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Subscribe to this plugin' }),
    ).not.toBeInTheDocument();
    fireEvent.click(pendingButton());
    expect(apiMock.requestPluginAccess).toHaveBeenCalledTimes(1);
    expect(apiMock.requestPluginAccess).toHaveBeenCalledWith('Finance');

    release();
    expect(
      await screen.findByText('Requested: Olga Ivanova decides who gets access.'),
    ).toBeInTheDocument();
    noButton();
    expect(onRequested).toHaveBeenCalledTimes(1);
  });

  it('shows the Requested card on the answer, without waiting for a change request number', async () => {
    // What the server now answers while the branch, commit and change request
    // are still being made in the background.
    apiMock.requestPluginAccess.mockResolvedValue({ ok: true, state: 'pending', number: null });
    const { onRequested } = renderLocked();
    fireEvent.click(askButton());
    expect(
      await screen.findByText('Requested: Olga Ivanova decides who gets access.'),
    ).toBeInTheDocument();
    expect(onRequested).toHaveBeenCalledTimes(1);
  });

  it('confirms with the first names of the people who now have to decide', async () => {
    renderLocked();
    fireEvent.click(askButton());
    expect(
      await screen.findByText('Asked Olga. You get its skills and tools once they grant access.'),
    ).toBeInTheDocument();
  });

  it('shows the Requested box with no button when the server already has one', () => {
    renderLocked(finance({ hasRequested: true }));
    expect(screen.getByText('Requested: Olga Ivanova decides who gets access.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Subscribe to this plugin' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to the admins, in the plural, when nobody is named', async () => {
    renderLocked(finance({ owners: { roles: [], users: [] }, writers: { roles: [], users: [] } }));
    expect(screen.getByText('Run by the workspace admins.')).toBeInTheDocument();
    fireEvent.click(askButton());
    expect(
      await screen.findByText(
        'Asked the admins. You get its skills and tools once they grant access.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Requested: the workspace admins decide who gets access.'),
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

  it('opens the plugin rather than complaining when access already landed', async () => {
    apiMock.requestPluginAccess.mockRejectedValue(new apiMock.AlreadyReadableError());
    const { onUnlocked, onRequested } = renderLocked();
    fireEvent.click(askButton());
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Requested/)).not.toBeInTheDocument();
  });

  it('re-enables the button and says so when the request fails', async () => {
    apiMock.requestPluginAccess.mockRejectedValue(new Error('boom'));
    const { onRequested } = renderLocked();
    fireEvent.click(askButton());
    expect(await screen.findByText("Couldn't send that: try again.")).toBeInTheDocument();
    expect(askButton()).not.toBeDisabled();
    expect(onRequested).not.toHaveBeenCalled();
  });

  it('says what went wrong in the background, and offers the button again', () => {
    renderLocked(
      finance({ requestFailure: 'remote: permission denied', hasRequested: false }),
    );
    expect(
      screen.getByText(
        'Your request to join Finance could not be sent: remote: permission denied. Try again.',
      ),
    ).toBeInTheDocument();
    // The button is back, and clicking it retries — the server reuses the same
    // recorded request rather than opening a second one.
    expect(askButton()).not.toBeDisabled();
    expect(screen.queryByText(/^Requested:/)).not.toBeInTheDocument();
  });

  it('names the plugin the way people see it, and does not double the reason’s full stop', () => {
    renderLocked(
      finance({ name: 'finance', displayName: 'Finance & Ops', requestFailure: 'the git host said no.' }),
    );
    expect(
      screen.getByText(
        'Your request to join Finance & Ops could not be sent: the git host said no. Try again.',
      ),
    ).toBeInTheDocument();
  });

  it('a request that is pending again outranks the last failure', () => {
    renderLocked(finance({ hasRequested: true, requestFailure: 'stale' }));
    expect(screen.getByText('Requested: Olga Ivanova decides who gets access.')).toBeInTheDocument();
    expect(screen.queryByText(/could not be sent/)).not.toBeInTheDocument();
  });

  it('retrying clears the sentence at the click, not at the answer', async () => {
    let release = () => {};
    apiMock.requestPluginAccess.mockReturnValue(new Promise<void>((resolve) => { release = () => resolve(); }));
    renderLocked(finance({ requestFailure: 'remote: permission denied' }));
    fireEvent.click(askButton());
    expect(pendingButton()).toBeDisabled();
    release();
    expect(
      await screen.findByText('Requested: Olga Ivanova decides who gets access.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be sent/)).not.toBeInTheDocument();
  });

  it('gives a locked-out admin the self-service way in', () => {
    const { onManage } = renderLocked(finance({ canWrite: true, folders: ['Plugins/Finance'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage access' }));
    expect(onManage).toHaveBeenCalledWith('Plugins/Finance');
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
