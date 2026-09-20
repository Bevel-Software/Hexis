import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ToolSecrets } from '../../services/tool-secrets.api';
import { SecretsPage } from '../SecretsPage';
import { TOOL_CREDENTIALS_STALE_EVENT } from '../../../../core/events';

const toolSecretsMock = vi.hoisted(() => ({
  listToolSecrets: vi.fn(),
  setUserVar: vi.fn(),
  deleteUserVar: vi.fn(),
  checkToolConnection: vi.fn(),
}));

vi.mock('../../services/secrets.api', () => ({
  listSecrets: vi.fn(async () => []),
  createOAuthSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  startOAuth: vi.fn(async () => ''),
}));
vi.mock('../../services/tool-secrets.api', () => ({
  listToolSecrets: toolSecretsMock.listToolSecrets,
  setAdminVar: vi.fn(async () => {}),
  setUserVar: toolSecretsMock.setUserVar,
  setOAuthClientSecret: vi.fn(async () => {}),
  deleteAdminVar: vi.fn(async () => {}),
  deleteUserVar: toolSecretsMock.deleteUserVar,
  checkToolConnection: toolSecretsMock.checkToolConnection,
}));

/** The page carries links now, so it needs a router around it. */
function renderPage() {
  return render(
    <MemoryRouter>
      <SecretsPage />
    </MemoryRouter>,
  );
}

describe('SecretsPage', () => {
  beforeEach(() => {
    // Each test starts on a clean /secrets URL (no leftover fragment).
    window.history.replaceState(null, '', '/secrets');
    toolSecretsMock.listToolSecrets.mockReset().mockResolvedValue([]);
  });

  it('renders as a full page (no dialog) and loads the secret lists', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(
      await screen.findByText('No tools you can access declare secrets yet.'),
    ).toBeInTheDocument();
    // Converted from the old gear-menu dialog: nothing modal is mounted.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('links each tool name at its own page', async () => {
    const heyreach: ToolSecrets = {
      slug: 'heyreach',
      name: 'heyreach',
      path: 'Plugins/GTM/heyreach.tool',
      type: 'inline',
      setup: null,
      canWrite: false,
      variables: [],
    };
    toolSecretsMock.listToolSecrets.mockResolvedValue([heyreach]);

    renderPage();
    const link = await screen.findByRole('link', { name: 'Open heyreach' });
    expect(link).toHaveAttribute('href', '/skills-and-tools/tools/heyreach');
  });

  it('surfaces the OAuth-callback success carried in the #authorized fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#authorized');
    renderPage();
    expect(await screen.findByText('Authorization complete.')).toBeInTheDocument();
    // The fragment is consumed so a refresh doesn't re-announce it.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/secrets');
  });

  it('surfaces the OAuth-callback error carried in the #error fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#error=Access%20denied');
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  /**
   * The vault is a shell route of its own: no Library is mounted under
   * `/secrets`, so a key set here has no provider to call. It ANNOUNCES
   * instead — the one rule every writing surface follows — and the cards and
   * plugin banners pick it up wherever they are.
   */
  describe('a key set here reaches the Library', () => {
    const heard = vi.fn();
    const heyreach: ToolSecrets = {
      slug: 'heyreach',
      name: 'heyreach',
      path: 'Plugins/GTM/heyreach.tool',
      type: 'inline',
      setup: null,
      canWrite: false,
      variables: [
        {
          name: 'API_KEY',
          scope: 'user',
          label: null,
          key: 'heyreach_API_KEY',
          adminConfigured: true,
          userConfigured: false,
        },
      ],
    };

    beforeEach(() => {
      heard.mockReset();
      toolSecretsMock.setUserVar.mockReset().mockResolvedValue(undefined);
      toolSecretsMock.deleteUserVar.mockReset().mockResolvedValue(undefined);
      window.addEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard);
    });
    afterEach(() => window.removeEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard));

    const showTool = async (userConfigured: boolean) => {
      toolSecretsMock.listToolSecrets.mockResolvedValue([
        { ...heyreach, variables: [{ ...heyreach.variables[0], userConfigured }] },
      ]);
      renderPage();
      return screen.findByLabelText('Value for API_KEY');
    };

    it('announces a saved key', async () => {
      const field = await showTool(false);
      fireEvent.change(field, { target: { value: 'k' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    });

    it('announces a removed one', async () => {
      await showTool(true);
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    });

    it('announces nothing when the save fails', async () => {
      toolSecretsMock.setUserVar.mockRejectedValue(new Error('Nope.'));
      const field = await showTool(false);
      fireEvent.change(field, { target: { value: 'k' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Nope.');
      expect(heard).not.toHaveBeenCalled();
    });
  });

  /**
   * The vault probes what it stores, beside the row that stored it.
   *
   * The quietest place in the app to install a key the provider would refuse:
   * the vault has no cards, no banners and no agent watching, so a wrong value
   * simply sat here reading `Set` until something far away failed. The same
   * health check the tool page runs now runs here, said in the same words.
   */
  describe('the saved key is probed', () => {
    const heyreach: ToolSecrets = {
      slug: 'heyreach',
      name: 'heyreach',
      path: 'Plugins/GTM/heyreach.tool',
      type: 'inline',
      setup: null,
      canWrite: false,
      variables: [
        {
          name: 'API_KEY',
          scope: 'user',
          label: null,
          key: 'heyreach_API_KEY',
          adminConfigured: true,
          userConfigured: false,
        },
      ],
    };

    beforeEach(() => {
      toolSecretsMock.setUserVar.mockReset().mockResolvedValue(undefined);
      toolSecretsMock.deleteUserVar.mockReset().mockResolvedValue(undefined);
      // Reset, not clear: a test that forgets to state what its probe answers
      // must not inherit its neighbour's implementation and pass by accident.
      toolSecretsMock.checkToolConnection.mockReset();
      toolSecretsMock.listToolSecrets.mockResolvedValue([heyreach]);
    });

    const saveKey = async (secret = 'k') => {
      renderPage();
      fireEvent.change(await screen.findByLabelText('Value for API_KEY'), {
        target: { value: secret },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    };

    it('shows the quiet connected state when the provider accepts it', async () => {
      toolSecretsMock.checkToolConnection.mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveTextContent('Connected');
      expect(row).toHaveAttribute('data-probe-state', 'connected');
      expect(toolSecretsMock.checkToolConnection).toHaveBeenCalledWith('heyreach');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it("shows the provider's own status text when it rejects it", async () => {
      toolSecretsMock.checkToolConnection.mockResolvedValue({
        status: 'failed',
        detail: '401 Unauthorized: bad credentials',
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'rejected');
      expect(row).toHaveAttribute('role', 'alert');
      expect(row).toHaveTextContent('401 Unauthorized: bad credentials');
    });

    it('says Unverified, and why, when the manual defines no health check', async () => {
      toolSecretsMock.checkToolConnection.mockResolvedValue({
        status: 'unverifiable',
        detail: "This tool doesn't offer a way to test its connection.",
        checkedAt: new Date().toISOString(),
      });

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'unverified');
      expect(row).toHaveTextContent('Unverified');
      expect(row).toHaveTextContent("This tool doesn't offer a way to test its connection.");
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says the check could not run — not that the key is wrong — when the probe fails', async () => {
      toolSecretsMock.checkToolConnection.mockRejectedValue(new Error('Network down'));

      await saveKey();

      const row = await screen.findByTestId('saved-key-probe');
      expect(row).toHaveAttribute('data-probe-state', 'unreachable');
      expect(row).toHaveTextContent('Saved, but not tested.');
      expect(row).not.toHaveTextContent('Not working');
    });

    it('stores the value first: a probe that never answers never blocks the save', async () => {
      toolSecretsMock.checkToolConnection.mockReturnValue(new Promise(() => {}));

      await saveKey('k');

      await waitFor(() =>
        expect(toolSecretsMock.setUserVar).toHaveBeenCalledWith('heyreach', 'API_KEY', 'k'),
      );
      await waitFor(() => expect(screen.getByLabelText('Value for API_KEY')).toHaveValue(''));
      expect(await screen.findByTestId('saved-key-probe')).toHaveAttribute(
        'data-probe-state',
        'checking',
      );
    });

    it('drops the answer when the value is REMOVED rather than saved', async () => {
      // A verdict is about a value this row no longer holds. "Connected" over
      // a deleted key is the stale claim in its purest form.
      toolSecretsMock.checkToolConnection.mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });
      // Already stored, so the row carries Remove from the start and replacing
      // the value does not change which controls are on it.
      toolSecretsMock.listToolSecrets.mockResolvedValue([
        { ...heyreach, variables: [{ ...heyreach.variables[0], userConfigured: true }] },
      ]);

      await saveKey();
      expect(await screen.findByTestId('saved-key-probe')).toHaveTextContent('Connected');

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(screen.queryByTestId('saved-key-probe')).toBeNull());
      // And a delete has nothing to prove, so it starts no probe of its own.
      expect(toolSecretsMock.checkToolConnection).toHaveBeenCalledTimes(1);
    });

    it('never repeats the submitted secret, whatever the probe says', async () => {
      const secret = 'sk-live-DO-NOT-ECHO-4242';
      toolSecretsMock.checkToolConnection.mockResolvedValue({
        status: 'failed',
        detail: 'The API key you supplied was rejected.',
        checkedAt: new Date().toISOString(),
      });

      await saveKey(secret);

      await screen.findByTestId('saved-key-probe');
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
    });
  });

  /**
   * A LIST load is an answer about the vault, and answers arrive out of order.
   *
   * Every save starts one, and the page had no way to tell a fresh answer from
   * a late one — so the row a person had just filled in could flip back to
   * `Needs a key` on the strength of a request that left before they typed it.
   * The same newest-wins rule the probe follows, for the same reason: this
   * page's whole job now is to stop saying confident things it cannot back up.
   */
  describe('a late list load cannot undo a newer one', () => {
    const heyreach: ToolSecrets = {
      slug: 'heyreach',
      name: 'heyreach',
      path: 'Plugins/GTM/heyreach.tool',
      type: 'inline',
      setup: null,
      canWrite: false,
      variables: [
        {
          name: 'API_KEY',
          scope: 'user',
          label: null,
          key: 'heyreach_API_KEY',
          adminConfigured: true,
          userConfigured: false,
        },
      ],
    };
    const withKey = (userConfigured: boolean): ToolSecrets[] => [
      { ...heyreach, variables: [{ ...heyreach.variables[0], userConfigured }] },
    ];

    beforeEach(() => {
      toolSecretsMock.setUserVar.mockReset().mockResolvedValue(undefined);
      toolSecretsMock.checkToolConnection.mockReset().mockResolvedValue({
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      });
    });

    const save = async (value: string) => {
      fireEvent.change(await screen.findByLabelText('Value for API_KEY'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    };

    it('shows the newest list even when an older load answers last', async () => {
      /** Each load after the first is held open, so the order is ours to pick. */
      const held: ((tools: ToolSecrets[]) => void)[] = [];
      toolSecretsMock.listToolSecrets
        .mockReset()
        .mockResolvedValueOnce(withKey(false))
        .mockImplementation(() => new Promise<ToolSecrets[]>((resolve) => held.push(resolve)));

      renderPage();
      await save('a');
      await waitFor(() => expect(held).toHaveLength(1));
      await save('b');
      await waitFor(() => expect(held).toHaveLength(2));

      // The newer load lands first, then the one that left before the key was
      // typed — the shape of the bug, which no amount of retrying fixes.
      held[1](withKey(true));
      await screen.findByText('Set');
      held[0](withKey(false));

      await waitFor(() => expect(screen.getByText('Set')).toBeInTheDocument());
      expect(screen.queryByText('Needs a key')).toBeNull();
    });

    it('keeps a verdict on the row when the header Refresh is pressed', async () => {
      // The loud refresh dropped the page to "Loading…", unmounting the panel
      // that holds the only copy of the probe's answer. Nothing persists a
      // verdict, so the answer was simply gone — and pressing Refresh is
      // exactly what someone does while waiting for one.
      //
      // Every load after the first reports the key as SET, which is what the
      // server actually says once a save has landed. Feeding the pre-save list
      // back instead would leave the badge reading `Needs a key` under a
      // verdict reading `Connected` — a contradiction the real flow never
      // produces, and not a state worth pinning a test to.
      toolSecretsMock.listToolSecrets
        .mockReset()
        .mockResolvedValueOnce(withKey(false))
        .mockResolvedValue(withKey(true));
      renderPage();
      await save('a');
      expect(await screen.findByTestId('saved-key-probe')).toHaveTextContent('Connected');

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(toolSecretsMock.listToolSecrets).toHaveBeenCalledTimes(3));
      expect(screen.queryByText('Loading…')).toBeNull();
      // The row is coherent: the badge agrees with the verdict beneath it.
      expect(screen.getByText('Set')).toBeInTheDocument();
      expect(screen.getByTestId('saved-key-probe')).toHaveTextContent('Connected');
      // Survived, not re-asked — a refresh is not a reason to call the provider.
      expect(toolSecretsMock.checkToolConnection).toHaveBeenCalledTimes(1);
    });
  });
});
