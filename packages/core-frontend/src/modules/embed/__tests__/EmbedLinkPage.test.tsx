import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  linkEmbedAccount: vi.fn(),
  auth: {
    user: { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' } as unknown,
    isLoading: false,
  },
}));
vi.mock('../services/embed.api', () => ({ linkEmbedAccount: mocks.linkEmbedAccount }));
vi.mock('../../auth/hooks/useAuthState', () => ({ useAuthState: () => mocks.auth }));
vi.mock('../../auth/components/LoginScreen', () => ({ LoginScreen: () => <p>Sign in</p> }));
vi.mock('../../../lib/api', () => ({ getToken: () => 'session-bearer' }));

import { EmbedLinkPage, outsideAccountOf } from '../components/EmbedLinkPage';

/** A token shaped like the server's: only the payload is read, for display. */
function tokenFor(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

const TOKEN = tokenFor({ scope: 'embed', kind: 'atlassian', sub: '557058:abc-def', repoRelative: 'Data/x.md' });

beforeEach(() => {
  mocks.linkEmbedAccount.mockReset();
  window.history.replaceState({}, '', `/embed/link?token=${TOKEN}`);
});

/**
 * Anybody holding a token for their OWN outside account can craft a link to
 * this page. Followed by a signed-in victim, a silent link would bind the
 * attacker's account to the victim's — so nothing is linked until the person
 * signed in confirms it, seeing both accounts named.
 */
describe('the account-link page', () => {
  it('links nothing on arrival — it asks first, naming both accounts', async () => {
    render(<EmbedLinkPage />);
    expect(await screen.findByText('Link your Atlassian account?')).toBeTruthy();
    expect(screen.getByText('557058:abc-def')).toBeTruthy();
    expect(screen.getByText('alice@bevel.software')).toBeTruthy();
    expect(mocks.linkEmbedAccount).not.toHaveBeenCalled();
  });

  it('links when the signed-in person confirms', async () => {
    mocks.linkEmbedAccount.mockResolvedValue(undefined);
    render(<EmbedLinkPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Link accounts' }));
    await waitFor(() => expect(mocks.linkEmbedAccount).toHaveBeenCalledWith(TOKEN, 'session-bearer'));
    expect(await screen.findByText('Account linked')).toBeTruthy();
  });

  it('links nothing when they cancel', async () => {
    render(<EmbedLinkPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Nothing was linked/)).toBeTruthy();
    expect(mocks.linkEmbedAccount).not.toHaveBeenCalled();
  });
});

describe('outsideAccountOf', () => {
  it('reads the outside account a token names', () => {
    expect(outsideAccountOf(TOKEN)).toBe('557058:abc-def');
  });

  it('answers null for a token minted for a Hexis user, or one it cannot read', () => {
    expect(outsideAccountOf(tokenFor({ kind: 'user', sub: 'u-1' }))).toBeNull();
    expect(outsideAccountOf('not-a-jwt')).toBeNull();
    expect(outsideAccountOf('')).toBeNull();
  });
});
