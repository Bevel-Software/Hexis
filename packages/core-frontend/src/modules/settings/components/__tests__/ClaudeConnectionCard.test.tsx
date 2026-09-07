import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaudeConnectionCard } from '../ClaudeConnectionCard';

const { fetchMock, rotateMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), rotateMock: vi.fn() }));
vi.mock('../../services/claude-bridge.api', () => ({
  fetchClaudeBridge: fetchMock,
  rotateClaudeBridge: rotateMock,
}));

const CREDS = {
  host: 'kb.acme.com',
  appId: '123456',
  clientId: 'Iv1.0123456789abcdef',
  clientSecret: 'secret-1',
  webhookSecret: 'hook-1',
  privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
  marketplaceUrl: 'https://kb.acme.com/git/marketplace.git',
  createdAt: Date.UTC(2026, 8, 7),
  rotatedAt: null,
};

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(CREDS);
  rotateMock.mockReset().mockResolvedValue({ ...CREDS, clientId: 'Iv1.fedcba9876543210', clientSecret: 'secret-2', rotatedAt: Date.now() });
});

/** Every textarea's value — the card is a copy source, so its values are its contract. */
const values = () => screen.getAllByRole('textbox').map((el) => (el as HTMLTextAreaElement).value);

describe('ClaudeConnectionCard', () => {
  it("shows every field Claude's Add-manually form asks for, plus the URL people add", async () => {
    render(<ClaudeConnectionCard />);
    await screen.findByText('Hostname');
    const shown = values();
    for (const v of [CREDS.host, CREDS.appId, CREDS.clientId, CREDS.clientSecret, CREDS.webhookSecret, CREDS.privateKeyPem, CREDS.marketplaceUrl]) {
      expect(shown).toContain(v);
    }
  });

  it('rotates only after a confirmation, and shows the new set', async () => {
    const user = userEvent.setup();
    render(<ClaudeConnectionCard />);
    await screen.findByText('Hostname');
    await user.click(screen.getByRole('button', { name: 'Rotate credentials' }));
    expect(rotateMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(rotateMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(values()).toContain('secret-2'));
    expect(values()).not.toContain('secret-1');
  });

  it('says what went wrong and offers a retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('SECRETS_ENC_KEY is not set, so the Claude connection credentials cannot be stored.'));
    const user = userEvent.setup();
    render(<ClaudeConnectionCard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('SECRETS_ENC_KEY');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Hostname');
  });
});
