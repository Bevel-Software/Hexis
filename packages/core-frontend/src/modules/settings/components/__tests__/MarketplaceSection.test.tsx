import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * The admin carousel inside the drawer. Its region name says what the region
 * IS rather than repeating the drawer's summary, which already reads
 * "Register this deployment with Claude" one level up.
 */
const carousel = () =>
  within(drawer()).getByRole('region', { name: 'Claude registration steps' });

/** The slide on screen, by the accessible name the live region carries. */
const slideName = (strip: HTMLElement) =>
  within(strip).getByRole('group').getAttribute('aria-label');

/** Open the drawer and hand back the carousel it holds. */
async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText('Register this deployment with Claude'));
  return carousel();
}

describe('MarketplaceSection', () => {
  /**
   * The registration steps are a CAROUSEL now, on the same shell as the
   * personal tutorial: four screenshots stacked down a page was a wall, and
   * the admin reading them is following one screen at a time anyway. What
   * the shell owes the reader is asserted here — the progress strip, the
   * counter, one shot at a time — because this is the route that did not
   * have it.
   */
  it('walks the registration steps as a carousel, one screenshot at a time', async () => {
    const user = userEvent.setup();
    mount('settings');
    const section = await screen.findByTestId('marketplace-deployment-section');
    expect(within(section).getByRole('heading', { name: 'Marketplace' })).toBeInTheDocument();
    const strip = await openDrawer(user);
    expect(strip).toHaveAttribute('aria-roledescription', 'carousel');

    const steps = [
      ['Register this deployment with your Claude organization', `admin settings, Claude Code page`],
      ['Fill the form and add the configuration', 'Add GitHub Enterprise dialog'],
      ['Connect your own Claude account to it', 'admin settings, GitHub page'],
      ['Pick this deployment as the GitHub instance', 'Install the Claude Code GitHub App dialog'],
    ];

    for (const [index, [title, alt]] of steps.entries()) {
      expect(within(strip).getByRole('group')).toHaveAccessibleName(
        `Step ${index + 1} of 5: ${title}`,
      );
      expect(within(strip).getByText(`${index + 1} / 5`)).toBeInTheDocument();
      // One shot mounted, and it is this step's.
      const shots = within(strip).getAllByRole('img');
      expect(shots).toHaveLength(1);
      expect(shots[0].getAttribute('alt')).toContain(alt);
      // And the progress strip can jump straight to it.
      expect(
        within(strip).getByRole('button', { name: new RegExp(`^Go to step ${index + 1}: `) }),
      ).toBeInTheDocument();
      await user.click(within(strip).getByRole('button', { name: 'Next' }));
    }

    // Past the last registration step is the shared connector step, and the
    // footer control has relabelled itself rather than disappearing.
    expect(within(strip).getByRole('button', { name: 'Review again' })).toBeInTheDocument();
    expect(within(strip).queryByRole('button', { name: 'Next' })).toBeNull();
    expect(within(strip).getByRole('button', { name: 'Back' })).toBeEnabled();

    // The deployment's own host and port, never a hard-coded example. The
    // port lives on the Add-configuration step, the host on the instance one.
    await user.click(within(strip).getByRole('button', { name: 'Go to step 2: Configure' }));
    expect(strip).toHaveTextContent('the port is 443');
    await user.click(within(strip).getByRole('button', { name: 'Go to step 4: Instance' }));
    expect(strip).toHaveTextContent('kb.acme.com');

    // Optional is a first-run word.
    expect(within(section).queryByText('Optional')).toBeNull();
  });

  /**
   * The admin route ends where everyone else's does. ONE slide definition
   * behind both, so this copy and the personal tutorial's cannot drift; the
   * assertion here is that the admin actually reaches it.
   */
  it('ends the admin carousel on the shared connector step', async () => {
    const user = userEvent.setup();
    mount('settings');
    await screen.findByTestId('marketplace-deployment-section');
    const strip = await openDrawer(user);

    fireEvent.keyDown(strip, { key: 'End' });
    expect(within(strip).getByRole('group')).toHaveAccessibleName(
      'Step 5 of 5: Add the hexis connector',
    );
    expect(strip).toHaveTextContent('does not connect its MCP server');
    expect(strip).toHaveTextContent('Add for your team');
    expect(strip).toHaveTextContent('Add custom connector');
    expect(strip).toHaveTextContent('approve the sign-in on this deployment');
    expect(strip).toHaveTextContent('Without organization-admin rights');
    // Its two screens: the row that says Not added, and the dialog.
    const alts = within(strip).getAllByRole('img').map((el) => el.getAttribute('alt') ?? '');
    expect(alts).toHaveLength(2);
    expect(alts[0]).toContain('Not added');
    expect(alts[1]).toContain('Add custom connector dialog');
  });

  /**
   * The keyboard half of the shared shell, on the admin route. The personal
   * carousel covers the same keys on its own page; asserting them here too
   * is what stops a regression in `SetupCarousel` from passing green on the
   * route that only ever exercised End.
   *
   * The two no-op edges are part of the contract, not an oversight: Left on
   * the first slide and Right on the last leave the keys to the browser, so
   * a reader who tabbed onto a screenshot link still gets the default
   * scroll. What the test can see is that the slide does not move.
   */
  it('moves through the admin carousel with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    mount('settings');
    await screen.findByTestId('marketplace-deployment-section');
    const strip = await openDrawer(user);
    expect(slideName(strip)).toBe('Step 1 of 5: Register this deployment with your Claude organization');

    // Left on the first slide is a no-op, and does not wrap to the end.
    // fireEvent hands back false when the handler called preventDefault, so
    // this also asserts the key was LEFT to the browser rather than
    // swallowed by a section that had nowhere to move.
    expect(fireEvent.keyDown(strip, { key: 'ArrowLeft' })).toBe(true);
    expect(slideName(strip)).toBe('Step 1 of 5: Register this deployment with your Claude organization');

    // A key that does move is ours, and is prevented.
    expect(fireEvent.keyDown(strip, { key: 'ArrowRight' })).toBe(false);
    expect(slideName(strip)).toBe('Step 2 of 5: Fill the form and add the configuration');
    fireEvent.keyDown(strip, { key: 'ArrowRight' });
    expect(slideName(strip)).toBe('Step 3 of 5: Connect your own Claude account to it');
    fireEvent.keyDown(strip, { key: 'ArrowLeft' });
    expect(slideName(strip)).toBe('Step 2 of 5: Fill the form and add the configuration');

    fireEvent.keyDown(strip, { key: 'End' });
    expect(slideName(strip)).toBe('Step 5 of 5: Add the hexis connector');
    // Right on the last slide is the other no-op edge: no wrap to step 1,
    // and the key goes back to the browser. End on the last slide is the
    // same, which is what a reader focused on a screenshot link needs.
    expect(fireEvent.keyDown(strip, { key: 'ArrowRight' })).toBe(true);
    expect(fireEvent.keyDown(strip, { key: 'End' })).toBe(true);
    expect(slideName(strip)).toBe('Step 5 of 5: Add the hexis connector');

    expect(fireEvent.keyDown(strip, { key: 'Home' })).toBe(false);
    expect(slideName(strip)).toBe('Step 1 of 5: Register this deployment with your Claude organization');
  });

  /**
   * "Review again" is the one control that wraps. The footer button
   * relabels itself on the last slide rather than disappearing, and
   * pressing it puts the admin back on step 1 with the progress strip
   * reset — which is the whole reason it is a relabel and not a second
   * button somewhere else.
   */
  it('restarts the admin carousel at step 1 from Review again', async () => {
    const user = userEvent.setup();
    mount('settings');
    await screen.findByTestId('marketplace-deployment-section');
    const strip = await openDrawer(user);

    fireEvent.keyDown(strip, { key: 'End' });
    expect(slideName(strip)).toBe('Step 5 of 5: Add the hexis connector');

    await user.click(within(strip).getByRole('button', { name: 'Review again' }));
    expect(slideName(strip)).toBe('Step 1 of 5: Register this deployment with your Claude organization');
    expect(within(strip).getByText('1 / 5')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(
      within(strip).getByRole('button', { name: 'Go to step 1: Add manually' }),
    ).toHaveAttribute('aria-current', 'step');
  });

  /**
   * The drawer regression, carried over from External agent access: a closed
   * <details> still MOUNTS its children, so credentials must wait on the
   * drawer being open, not on the section rendering. A client secret is not
   * put in the DOM of something nobody opened.
   *
   * The carousel adds the second gate. The credentials belong to the
   * Add-configuration step and to nothing else, so they are mounted on that
   * slide and on no other — opening the drawer is no longer enough on its
   * own, and moving off the slide takes them back out.
   */
  it('fetches the credentials only on the Add-configuration slide of an open drawer', async () => {
    const user = userEvent.setup();
    mount('settings');
    await screen.findByRole('button', { name: 'Mark as registered' });
    expect(drawer().open).toBe(false);
    expect(api.fetchGitHubFacade).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(CREDS.clientSecret)).toBeNull();

    // Open, but standing on step 1: still nothing secret in the DOM.
    const strip = await openDrawer(user);
    expect(drawer().open).toBe(true);
    expect(api.fetchGitHubFacade).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue(CREDS.clientSecret)).toBeNull();

    await user.click(within(strip).getByRole('button', { name: 'Next' }));

    await within(drawer()).findByDisplayValue(CREDS.clientSecret);
    expect(api.fetchGitHubFacade).toHaveBeenCalledTimes(1);
    for (const value of [CREDS.host, CREDS.appId, CREDS.clientId, CREDS.webhookSecret]) {
      expect(within(drawer()).getByDisplayValue(value)).toBeInTheDocument();
    }
    // Rotation is right there now: this IS the Deployment page.
    expect(within(drawer()).getByRole('button', { name: 'Rotate credentials' })).toBeInTheDocument();

    // Every other slide, including the connector at the end, is without them.
    for (const step of ['Go to step 1: Add manually', 'Go to step 3: Connect', 'Go to step 4: Instance', 'Go to step 5: Connector']) {
      await user.click(within(strip).getByRole('button', { name: step }));
      expect(screen.queryByDisplayValue(CREDS.clientSecret)).toBeNull();
      expect(within(drawer()).queryByRole('button', { name: 'Rotate credentials' })).toBeNull();
    }

    // Closing the drawer takes the secrets out of the DOM again.
    await user.click(within(strip).getByRole('button', { name: 'Go to step 2: Configure' }));
    await within(drawer()).findByDisplayValue(CREDS.clientSecret);
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
