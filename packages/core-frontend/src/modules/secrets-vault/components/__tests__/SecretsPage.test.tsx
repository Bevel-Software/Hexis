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
});
