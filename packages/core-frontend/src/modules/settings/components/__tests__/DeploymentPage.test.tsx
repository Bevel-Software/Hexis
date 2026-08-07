import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminContext, type AdminContextValue } from '../../../admin/state/admin.context';

/**
 * The deployment settings page — first-run setup with a permanent address.
 * What is worth testing is the door itself: an admin gets the real form (with
 * the same fields the setup gate shows), a non-admin gets told this is not
 * theirs, and a failed status load offers a retry instead of a blank page.
 * The form's own behaviour is covered by the setup suite — same component.
 */

const apiMock = vi.hoisted(() => ({ fetchSetupStatus: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../../../setup/services/setup.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSetupStatus: apiMock.fetchSetupStatus,
  saveSettings: apiMock.saveSettings,
}));

import { DeploymentPage } from '../DeploymentPage';

function admin(isAdmin: boolean): AdminContextValue {
  return { isAdmin } as AdminContextValue;
}

/** A settled status: setup is COMPLETE — this page exists for exactly then. */
const COMPLETE_STATUS = {
  complete: true,
  awaitingRestart: false,
  isAdmin: true,
  settings: [
    { key: 'kbRepoUrl', section: 'knowledge-base', source: 'saved', value: 'https://git.example.com/kb.git' },
    { key: 'oidcIssuerUrl', section: 'sign-in', source: 'saved', value: '' },
    { key: 'oidcClientId', section: 'sign-in', source: 'saved', value: '' },
    { key: 'oidcClientSecret', section: 'sign-in', source: 'saved', value: '' },
  ],
};

function renderPage(value: AdminContextValue) {
  return render(
    <AdminContext.Provider value={value}>
      <DeploymentPage />
    </AdminContext.Provider>,
  );
}

describe('DeploymentPage', () => {
  beforeEach(() => {
    apiMock.fetchSetupStatus.mockReset();
    apiMock.fetchSetupStatus.mockResolvedValue(COMPLETE_STATUS);
  });

  it('shows the setup form to an admin — AFTER setup is complete', async () => {
    renderPage(admin(true));
    // The single-sign-on fields are reachable again: the whole point of the page.
    expect(await screen.findByText('Provider address')).toBeInTheDocument();
    // And the same redirect-URI helper the setup screen shows.
    expect(screen.getByText(/api\/auth\/oidc\/callback/)).toBeInTheDocument();
    // Post-setup only: the caution against repointing a LIVE deployment at a
    // different repository (first-run has nothing to lose yet).
    expect(
      screen.getByText(/Only change this if the same repository was moved or renamed/),
    ).toBeInTheDocument();
  });

  it('tells a non-admin this is not theirs, and never fetches the settings', () => {
    renderPage(admin(false));
    expect(screen.getByText(/Admins only/)).toBeInTheDocument();
    expect(screen.queryByText('Provider address')).toBeNull();
    // Never fetched, not merely never rendered: the page already told them
    // this is not theirs, so a request nothing renders is pure noise.
    expect(apiMock.fetchSetupStatus).not.toHaveBeenCalled();
  });

  it('a failed refresh after an awaiting-restart save keeps the form AND the notice', async () => {
    // The save landed; only the follow-up status fetch died. The page must
    // not trade the confirmation of what was saved for a load error — the
    // form stays mounted with its restart notice, and the banner above it
    // says "refresh", not "load", with a retry.
    apiMock.saveSettings.mockResolvedValue({
      restartRequired: true,
      complete: false,
      awaitingRestart: true,
      settings: COMPLETE_STATUS.settings,
    });
    renderPage(admin(true));
    await screen.findByText('Provider address');
    apiMock.fetchSetupStatus.mockRejectedValueOnce(new Error('down'));

    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(/needs a restart/)).toBeInTheDocument();
    expect(await screen.findByText(/Couldn't refresh the deployment settings/)).toBeInTheDocument();
    // Still the form, not a blank page: the last good settings render on.
    expect(screen.getByText('Provider address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offers a retry when the status cannot be loaded, and the retry fetches again', async () => {
    apiMock.fetchSetupStatus.mockRejectedValueOnce(new Error('down'));
    renderPage(admin(true));
    expect(await screen.findByText(/Couldn't load the deployment settings/)).toBeInTheDocument();
    expect(apiMock.fetchSetupStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(apiMock.fetchSetupStatus).toHaveBeenCalledTimes(2));
    // The second answer (the beforeEach default) is the real settings.
    expect(await screen.findByText('Provider address')).toBeInTheDocument();
  });
});
