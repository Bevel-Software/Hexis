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

const varsMock = vi.hoisted(() => ({ setUserVar: vi.fn(), deleteUserVar: vi.fn() }));
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
        variables: [
          { name: 'API_KEY', label: null, key: 'heyreach_API_KEY', configured },
        ],
      },
    ],
    oauth: [],
    toolOAuth: [],
  };
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

  /** An unconfigured tool starts skipped; ticking it reveals its key fields. */
  const include = async () =>
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include this tool' }));

  it('announces a saved key', async () => {
    renderPage();
    await include();

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

  it('announces nothing when the save fails', async () => {
    varsMock.setUserVar.mockRejectedValue(new Error('Nope.'));
    renderPage();
    await include();

    fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    expect(heard).not.toHaveBeenCalled();
  });
});
