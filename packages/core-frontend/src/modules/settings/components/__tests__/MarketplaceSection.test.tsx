import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { configureMarketplaceGitUrl } from '../../../../shared/marketplace-url';

/**
 * The Marketplace section of Deployment configuration — the admin branch
 * that used to live on External agent access. Its host-specific rendering is
 * covered where it is hosted (setup.test.tsx, DeploymentPage.test.tsx); what
 * is worth testing here is the section's own contract: the credentials wait
 * for the drawer, first run can skip it, and marking it registered is what
 * External agent access reads.
 */

const api = vi.hoisted(() => ({
  fetchGitHubFacade: vi.fn(),
  rotateGitHubFacade: vi.fn(),
  fetchMarketplaceRegistration: vi.fn(),
  setMarketplaceRegistration: vi.fn(),
}));
vi.mock('../../services/github-facade.api', () => api);

import { MarketplaceSection } from '../MarketplaceSection';

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
  configureMarketplaceGitUrl('https://kb.acme.com/git/marketplace.git');
  api.fetchGitHubFacade.mockReset().mockResolvedValue(CREDS);
  api.rotateGitHubFacade.mockReset();
  api.fetchMarketplaceRegistration.mockReset().mockResolvedValue(false);
  api.setMarketplaceRegistration.mockReset().mockImplementation(async (next: boolean) => next);
});

function mount(variant: 'setup' | 'settings') {
  return render(
    <MemoryRouter>
      <MarketplaceSection variant={variant} />
    </MemoryRouter>,
  );
}

const drawer = () =>
  screen.getByText('Register this deployment with Claude').closest('details') as HTMLDetailsElement;

describe('MarketplaceSection', () => {
  it('carries the registration steps, their screenshots and the GitHub Enterprise Server steps', async () => {
    mount('settings');
    const section = await screen.findByTestId('marketplace-deployment-section');
    expect(within(section).getByRole('heading', { name: 'Marketplace' })).toBeInTheDocument();
    expect(within(section).getByText('Register this deployment with your Claude organization')).toBeInTheDocument();
    expect(within(section).getByText('Connect your own Claude account to it')).toBeInTheDocument();
    // The four registration shots, as they were on External agent access.
    expect(within(section).getAllByRole('img')).toHaveLength(4);
    // The deployment's own host and port, never a hard-coded example.
    expect(section).toHaveTextContent('kb.acme.com');
    expect(section).toHaveTextContent('the port is 443');
    // Optional is a first-run word.
    expect(within(section).queryByText('Optional')).toBeNull();
  });

  /**
   * The drawer regression, carried over from External agent access: a closed
   * <details> still MOUNTS its children, so credentials must wait on the
   * drawer being open, not on the section rendering. A client secret is not
   * put in the DOM of something nobody opened.
   */
  it('fetches the credentials only once the drawer is opened', async () => {
    const user = userEvent.setup();
    mount('settings');
    await screen.findByRole('button', { name: 'Mark as registered' });
    expect(drawer().open).toBe(false);
    expect(api.fetchGitHubFacade).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(CREDS.clientSecret)).toBeNull();

    await user.click(screen.getByText('Register this deployment with Claude'));

    await within(drawer()).findByDisplayValue(CREDS.clientSecret);
    expect(drawer().open).toBe(true);
    expect(api.fetchGitHubFacade).toHaveBeenCalledTimes(1);
    for (const value of [CREDS.host, CREDS.appId, CREDS.clientId, CREDS.webhookSecret]) {
      expect(within(drawer()).getByDisplayValue(value)).toBeInTheDocument();
    }
    // Rotation is right there now: this IS the Deployment page.
    expect(within(drawer()).getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument();

    // Closing the drawer takes the secrets out of the DOM again.
    await user.click(screen.getByText('Register this deployment with Claude'));
    expect(drawer().open).toBe(false);
    expect(screen.queryByDisplayValue(CREDS.clientSecret)).toBeNull();
  });

  /**
   * First run marks the section Optional and offers no way to decline it: an
   * admin who does not want a marketplace walks past it, exactly as they walk
   * past single sign-on by leaving it blank. Nothing waits on the section, so
   * a skip control only added a decision nobody had to make.
   */
  it('is marked optional on first run, with no skip control, and fetches nothing secret unopened', async () => {
    mount('setup');
    const section = await screen.findByTestId('marketplace-deployment-section');
    expect(within(section).getByText('Optional')).toBeInTheDocument();

    expect(within(section).queryByRole('button', { name: 'Skip for now' })).toBeNull();
    expect(section).not.toHaveTextContent('Marketplace skipped');
    expect(within(section).queryByRole('button', { name: 'Set it up now' })).toBeNull();

    // The section still renders its own content, and still holds back the
    // credentials until the drawer is opened.
    expect(
      within(section).getByText('Register this deployment with your Claude organization'),
    ).toBeInTheDocument();
    expect(api.fetchGitHubFacade).not.toHaveBeenCalled();
    expect(api.setMarketplaceRegistration).not.toHaveBeenCalled();
  });

  it('marks the deployment registered, and back', async () => {
    const user = userEvent.setup();
    mount('settings');
    await user.click(await screen.findByRole('button', { name: 'Mark as registered' }));
    await waitFor(() => expect(api.setMarketplaceRegistration).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/^Registered\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark as not registered' }));
    await waitFor(() => expect(api.setMarketplaceRegistration).toHaveBeenLastCalledWith(false));
    expect(await screen.findByText(/Not registered yet/)).toBeInTheDocument();
  });

  it('says so when the registration cannot be saved', async () => {
    api.setMarketplaceRegistration.mockRejectedValue(new Error('Admins only'));
    const user = userEvent.setup();
    mount('settings');
    await user.click(await screen.findByRole('button', { name: 'Mark as registered' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Admins only');
    expect(screen.getByText(/Not registered yet/)).toBeInTheDocument();
  });
});
