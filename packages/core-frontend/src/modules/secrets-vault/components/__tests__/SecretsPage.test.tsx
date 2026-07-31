import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecretsPage } from '../SecretsPage';

vi.mock('../../services/secrets.api', () => ({
  listSecrets: vi.fn(async () => []),
  createOAuthSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  startOAuth: vi.fn(async () => ''),
}));
vi.mock('../../services/tool-secrets.api', () => ({
  listToolSecrets: vi.fn(async () => []),
  setAdminVar: vi.fn(async () => {}),
  setUserVar: vi.fn(async () => {}),
  setOAuthClientSecret: vi.fn(async () => {}),
  deleteAdminVar: vi.fn(async () => {}),
  deleteUserVar: vi.fn(async () => {}),
}));

describe('SecretsPage', () => {
  beforeEach(() => {
    // Each test starts on a clean /secrets URL (no leftover fragment).
    window.history.replaceState(null, '', '/secrets');
  });

  it('renders as a full page (no dialog) and loads the secret lists', async () => {
    render(<SecretsPage />);
    expect(screen.getByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(
      await screen.findByText('No tools you can access declare secrets yet.'),
    ).toBeInTheDocument();
    // Converted from the old gear-menu dialog: nothing modal is mounted.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('surfaces the OAuth-callback success carried in the #authorized fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#authorized');
    render(<SecretsPage />);
    expect(await screen.findByText('Authorization complete.')).toBeInTheDocument();
    // The fragment is consumed so a refresh doesn't re-announce it.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/secrets');
  });

  it('surfaces the OAuth-callback error carried in the #error fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#error=Access%20denied');
    render(<SecretsPage />);
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });
});
