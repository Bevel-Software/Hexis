import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  deleteUserVar: vi.fn(),
  checkToolConnection: vi.fn(),
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
        variables: [
          { name: 'API_KEY', label: null, key: 'heyreach_API_KEY', configured },
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
    configured: true,
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
    // Reset, not clear: a test that forgets to state what its probe answers
    // must not inherit its neighbour's implementation and pass by accident.
    varsMock.checkToolConnection.mockReset();
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
    await include();

    fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    expect(heard).not.toHaveBeenCalled();
  });

  /**
   * What the provider makes of the key that was just typed here.
   *
   * This page used to store a value and stop. A tester saved a deliberately
   * invalid key and the row answered `Key saved` — true, and useless: the
   * provider had already refused it and nothing said so until an agent tripped
   * over the tool hours later, by which time the key was no longer to hand and
   * nobody remembered typing it.
   *
   * Asserted through the ROW, not the hook: what matters is that the person
   * looking at the field they just filled can see the answer beside it.
   */
  describe('the saved key is probed', () => {
    const saveKey = async (secret = 'k') => {
      renderPage();
      await include();
      fireEvent.change(await screen.findByLabelText('API_KEY value'), {
        target: { value: secret },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    };

    it('shows the quiet connected state when the provider accepts it', async () => {
      varsMock.checkToolConnection.mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveTextContent('Connected');
      expect(row).toHaveAttribute('data-probe-state', 'connected');
      // The probe is the tool's, by slug — the row is only where the answer lands.
      expect(varsMock.checkToolConnection).toHaveBeenCalledWith('heyreach');
      // Quiet: a working tool needs nobody.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("shows the provider's own status text when it rejects it", async () => {
      varsMock.checkToolConnection.mockResolvedValue({
        status: 'failed',
        detail: '401 Unauthorized: bad credentials',
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      // `alert`, not `status`: this is the one outcome that needs a person, and
      // the person is still here holding the key.
      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'rejected');
      expect(row).toHaveTextContent('401 Unauthorized: bad credentials');
      expect(row).toHaveAttribute('role', 'alert');
    });

    it('says Unverified, and why, when the manual defines no health check', async () => {
      varsMock.checkToolConnection.mockResolvedValue({
        status: 'unverifiable',
        detail: "This tool doesn't offer a way to test its connection.",
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'unverified');
      expect(row).toHaveTextContent('Unverified');
      // The one-line explanation is ON THE PAGE, not hidden in a title.
      expect(row).toHaveTextContent("This tool doesn't offer a way to test its connection.");
      // It needs nobody, so it does not shout.
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says the check could not run — not that the key is wrong — when the probe fails', async () => {
      // Our own network trouble is not evidence about someone else's credential.
      varsMock.checkToolConnection.mockRejectedValue(new Error('Network down'));

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'unreachable');
      expect(row).toHaveTextContent('Saved, but not tested.');
      expect(row).toHaveTextContent('Network down');
      expect(row).not.toHaveTextContent('Not working');
    });

    it('stores the value first: a probe that never answers never blocks the save', async () => {
      varsMock.checkToolConnection.mockReturnValue(new Promise(() => {}));

      await saveKey('k');

      // Stored, announced, and the field emptied — all while the probe hangs.
      await waitFor(() => expect(varsMock.setUserVar).toHaveBeenCalledWith('heyreach', 'API_KEY', 'k'));
      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.getByLabelText('API_KEY value')).toHaveValue(''),
      );
      expect(await screen.findByTestId('saved-key-probe')).toHaveAttribute(
        'data-probe-state',
        'checking',
      );
    });

    it('moves the one answer to whichever key was saved last', async () => {
      // A probe is a call carrying the tool's WHOLE credential set, not a test
      // of one `${VAR}`. Leaving the first row's "Connected" up after the
      // second row changed those credentials would rebuild the stale claim
      // this ticket exists to remove, one level down.
      connectMock.getConnectPending.mockResolvedValue(pendingPair());
      varsMock.checkToolConnection.mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });
      renderPage();

      const rowOf = (name: string) =>
        screen.getByLabelText(`${name} value`).closest('li') as HTMLElement;

      fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'a' } });
      fireEvent.click(within(rowOf('API_KEY')).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(within(rowOf('API_KEY')).getByTestId('saved-key-probe')).toHaveTextContent(
          'Connected',
        ),
      );

      fireEvent.change(screen.getByLabelText('API_SECRET value'), { target: { value: 'b' } });
      fireEvent.click(within(rowOf('API_SECRET')).getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(within(rowOf('API_SECRET')).getByTestId('saved-key-probe')).toBeInTheDocument(),
      );
      // One answer on the page, and it is on the row that asked for it.
      expect(screen.getAllByTestId('saved-key-probe')).toHaveLength(1);
      expect(within(rowOf('API_KEY')).queryByTestId('saved-key-probe')).toBeNull();
    });

    it('never repeats the submitted secret, whatever the probe says', async () => {
      const secret = 'sk-live-DO-NOT-ECHO-4242';
      varsMock.checkToolConnection.mockResolvedValue({
        status: 'failed',
        detail: 'The API key you supplied was rejected.',
        checkedAt: new Date().toISOString(),
      });

      await saveKey(secret);

      await screen.findByTestId('saved-key-probe');
      // The whole document, not just the result line: a password field still
      // holding the value is the same leak one keystroke later.
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
    });
  });
});
