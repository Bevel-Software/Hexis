import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectPending } from '../../services/connect.api';
import { ConnectToolsPage } from '../ConnectToolsPage';
import { TOOL_CREDENTIALS_STALE_EVENT } from '../../../../core/events';

/**
 * What this page owes the Library.
 *
 * `/connect` is a shell route of its own — no Library is mounted under it — so
 * a key entered here has no provider to call. It ANNOUNCES instead, the one
 * rule every writing surface in the app follows, and whichever surface is
 * holding a catalog picks it up. The rest of the page's behaviour (the agent
 * -connect mode, the Finish button) is not what these tests are about.
 */

const connectMock = vi.hoisted(() => ({
  getConnectPending: vi.fn(),
  startToolOAuth: vi.fn(),
  getMcpOAuthRequest: vi.fn(),
  completeMcpOAuth: vi.fn(),
}));
vi.mock('../../services/connect.api', () => connectMock);

const varsMock = vi.hoisted(() => ({
  setUserVar: vi.fn(),
  setAdminVar: vi.fn(),
  deleteUserVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
}));
vi.mock('../../services/tool-secrets.api', () => varsMock);
vi.mock('../../services/secrets.api', () => ({ startOAuth: vi.fn() }));

/** One tool, one per-user key, configured or not. */
function pending(configured: boolean): ConnectPending {
  return {
    tools: [
      {
        slug: 'heyreach',
        name: 'heyreach',
        path: 'Plugins/GTM/heyreach.tool',
        type: 'inline',
        canWrite: false,
        variables: [
          { name: 'API_KEY', label: null, key: 'heyreach_API_KEY', scope: 'user', configured, ownerOnly: false },
        ],
      },
    ],
    oauth: [],
    toolOAuth: [],
  };
}

/** The same tool holding two saved keys — a wipe is then two round-trips. */
function pendingPair(): ConnectPending {
  const one = pending(true);
  one.tools[0].variables.push({
    name: 'API_SECRET',
    label: null,
    key: 'heyreach_API_SECRET',
    scope: 'user',
    configured: true,
    ownerOnly: false,
  });
  return one;
}

const heard = vi.fn();

function renderPage() {
  return render(
    <MemoryRouter>
      <ConnectToolsPage />
    </MemoryRouter>,
  );
}

describe('ConnectToolsPage: telling the Library a credential landed', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/connect');
    sessionStorage.clear();
    heard.mockReset();
    connectMock.getConnectPending.mockReset().mockResolvedValue(pending(false));
    connectMock.getMcpOAuthRequest.mockReset();
    varsMock.setUserVar.mockReset().mockResolvedValue(undefined);
    varsMock.deleteUserVar.mockReset().mockResolvedValue(undefined);
    window.addEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard);
  });
  afterEach(() => window.removeEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard));

  // An unconfigured tool is INCLUDED to begin with — its key fields are there
  // on arrival, because the page is reached from a banner saying it needs one.

  it('announces a saved key', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it('announces the wipe behind unticking a configured tool', async () => {
    // Skipping a tool is a DELETE — the tool must not register for the agent —
    // so the Library's "needs setup" is wrong from the moment it lands.
    connectMock.getConnectPending.mockResolvedValue(pending(true));
    renderPage();

    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Skip this tool (removes your saved keys and sign-ins for it)',
      }),
    );

    await waitFor(() => expect(varsMock.deleteUserVar).toHaveBeenCalledWith('heyreach', 'API_KEY'));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it('announces an OAuth return, and consumes the fragment', async () => {
    window.history.replaceState(null, '', '/connect#authorized');
    renderPage();

    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe('');
  });

  it('announces a failed OAuth return too, and consumes that fragment', async () => {
    // A refused sign-in is still news: the provider may have revoked what was
    // there, and the Library's copy predates the browser leaving either way.
    window.history.replaceState(null, '', '/connect#error=Nope.');
    renderPage();

    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    expect(window.location.hash).toBe('');
  });

  it('announces a wipe that failed halfway — the first key really is gone', async () => {
    connectMock.getConnectPending.mockResolvedValue(pendingPair());
    varsMock.deleteUserVar
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Nope.'));
    renderPage();

    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Skip this tool (removes your saved keys and sign-ins for it)',
      }),
    );

    // Both keys were attempted; only the first one actually went.
    await waitFor(() => expect(varsMock.deleteUserVar).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
  });

  it('announces nothing when the very first delete of a wipe fails', async () => {
    connectMock.getConnectPending.mockResolvedValue(pending(true));
    varsMock.deleteUserVar.mockRejectedValue(new Error('Nope.'));
    renderPage();

    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Skip this tool (removes your saved keys and sign-ins for it)',
      }),
    );

    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    expect(heard).not.toHaveBeenCalled();
  });

  it('announces nothing when the save fails', async () => {
    varsMock.setUserVar.mockRejectedValue(new Error('Nope.'));
    renderPage();

    fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    expect(heard).not.toHaveBeenCalled();
  });
});
