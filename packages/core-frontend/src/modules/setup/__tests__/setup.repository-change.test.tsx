import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Pointing the deployment at a DIFFERENT knowledge-base repository.
 *
 * The server refuses such a save until it is confirmed, because confirming it
 * is the only warning anyone gets: every working copy on the server stops
 * being used and is cloned fresh, and anything committed there and never
 * pushed goes out of the app with it. When change requests are open the same
 * confirmation says how many and asks what to do with them.
 *
 * Only the transport is mocked, so what is under test is the whole path from
 * the button to the request bodies the form sends.
 */
const transport = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api')>()),
  authFetch: transport.authFetch,
}));

const facade = vi.hoisted(() => ({
  fetchGitHubFacade: vi.fn(),
  rotateGitHubFacade: vi.fn(),
  fetchMarketplaceRegistration: vi.fn(async () => false),
  setMarketplaceRegistration: vi.fn(),
}));
vi.mock('../../settings/services/github-facade.api', () => facade);

import { SetupScreen } from '../components/SetupScreen';
import type { SettingStatus } from '../services/setup.api';

const KB = 'knowledge-base' as const;
const CONFIGURED = 'https://example.com/acme/kb.git';
const REPLACEMENT = 'https://example.com/acme/replacement.git';

/** A deployment that has been running against CONFIGURED for a while. */
const SETTINGS: SettingStatus[] = [
  { key: 'kbRepoUrl', envVar: 'KB_REPO_URL', section: KB, source: 'stored', value: CONFIGURED, configured: true, secret: false, restartToApply: false },
  { key: 'gitToken', envVar: 'GIT_TOKEN', section: KB, source: 'stored', configured: true, secret: true, restartToApply: false },
  { key: 'gitUsername', envVar: 'GIT_USERNAME', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'defaultBranch', envVar: 'DEFAULT_BRANCH', section: KB, source: 'stored', value: 'main', configured: true, secret: false, restartToApply: true },
  { key: 'protectedBranches', envVar: 'PROTECTED_BRANCHES', section: KB, source: 'stored', value: 'main', configured: true, secret: false, restartToApply: true },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The bodies of every POST to the save endpoint, oldest first. */
const saveBodies = (): Array<Record<string, unknown>> =>
  transport.authFetch.mock.calls
    .filter(([url]) => String(url) === '/api/setup/settings')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

/**
 * The server: the remote answers for the new address, and the save is refused
 * with a 409 until a confirmation rides along.
 */
function serverWith(openChangeRequests: number) {
  transport.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/setup/test-connection') {
      return json(200, { ok: true, outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false });
    }
    if (url === '/api/setup/settings') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { confirmRepositoryChange?: string };
      if (!body.confirmRepositoryChange) {
        return json(409, {
          error: 'This moves the deployment to another repository.',
          repositoryChange: { openChangeRequests },
        });
      }
      return json(200, {
        ok: true,
        restartRequired: false,
        complete: true,
        settings: SETTINGS,
        repositoryChange: {
          choice: body.confirmRepositoryChange,
          closedChangeRequests: body.confirmRepositoryChange === 'close' ? openChangeRequests : 0,
        },
      });
    }
    return json(404, { error: 'not mocked' });
  });
}

/** Type the new address into a rendered settings form and press Save. */
async function typeTheNewAddressAndSave() {
  const url = screen.getByLabelText('Repository address');
  await userEvent.clear(url);
  await userEvent.type(url, REPLACEMENT);
  await userEvent.type(screen.getByLabelText('Access token'), 'ghp_new');
  await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
}

beforeEach(() => {
  transport.authFetch.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), origin: 'https://example.test' },
  });
});

describe('a changed repository address, with change requests open', () => {
  it('asks before saving: what is replaced, what is lost, and how many requests', async () => {
    serverWith(2);
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);

    await typeTheNewAddressAndSave();

    const confirm = await screen.findByTestId('repository-change-confirm');
    expect(confirm).toHaveTextContent(/stops being used and is cloned fresh/i);
    // The warning has to name the cost, and name it truthfully: the copies are
    // set aside on the server, so the work is out of the app but not destroyed.
    expect(confirm).toHaveTextContent(/hasn’t reached your git host yet goes out of\s+the app/i);
    expect(confirm).toHaveTextContent(/nothing is deleted/i);
    expect(confirm).toHaveTextContent(/replaced-working-copies/);
    expect(confirm).toHaveTextContent('There are 2 open change requests.');
    // Two choices, and keeping them is the one already selected: nothing
    // closes by hesitating.
    const [keep, close] = screen.getAllByRole('radio');
    expect(keep).toBeChecked();
    expect(close).not.toBeChecked();
  });

  it('keeps them when the admin says the repository only moved', async () => {
    serverWith(2);
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();
    await screen.findByTestId('repository-change-confirm');

    await userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));

    await waitFor(() => expect(saveBodies()).toHaveLength(2));
    expect(saveBodies()[1]).toMatchObject({
      confirmRepositoryChange: 'keep',
      settings: { kbRepoUrl: REPLACEMENT },
    });
    expect(await screen.findByTestId('repository-changed')).toHaveTextContent(/now works on the new repository/i);
  });

  it('closes them as “repository replaced” when the admin picks that, and says so', async () => {
    serverWith(2);
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();
    await screen.findByTestId('repository-change-confirm');

    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));

    await waitFor(() => expect(saveBodies()).toHaveLength(2));
    expect(saveBodies()[1]).toMatchObject({ confirmRepositoryChange: 'close' });
    const done = await screen.findByTestId('repository-changed');
    expect(done).toHaveTextContent('2 change requests were closed as “repository replaced”.');
    expect(done).toHaveTextContent('Nothing was deleted.');
  });

  it('cancelling saves nothing and leaves the typed address on screen', async () => {
    serverWith(2);
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();
    await screen.findByTestId('repository-change-confirm');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('repository-change-confirm')).not.toBeInTheDocument();
    // One refused attempt, and nothing since.
    expect(saveBodies()).toHaveLength(1);
    expect(screen.getByLabelText('Repository address')).toHaveValue(REPLACEMENT);
  });
});

describe('a changed repository address with nothing open', () => {
  it('still warns about the working copies, and offers no choice it cannot honour', async () => {
    serverWith(0);
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();

    const confirm = await screen.findByTestId('repository-change-confirm');
    expect(confirm).toHaveTextContent(/stops being used and is cloned fresh/i);
    expect(screen.queryAllByRole('radio')).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));
    await waitFor(() => expect(saveBodies()).toHaveLength(2));
    expect(saveBodies()[1]).toMatchObject({ confirmRepositoryChange: 'keep' });
  });
});

describe('a CONFIRMED save the server refuses', () => {
  /**
   * The probe passed and the confirmation was answered, and the store step
   * still failed — a token revoked in between, a repository that went away, a
   * close that could not be done. The admin has just agreed to lose their
   * working copies; being told only that it "did not save" is the worst moment
   * for that.
   */
  it('shows the reason the server gave for refusing the confirmed save', async () => {
    transport.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/setup/test-connection') {
        return json(200, { ok: true, outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false });
      }
      if (url === '/api/setup/settings') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { confirmRepositoryChange?: string };
        if (!body.confirmRepositoryChange) {
          return json(409, {
            error: 'This moves the deployment to another repository.',
            repositoryChange: { openChangeRequests: 2 },
          });
        }
        return json(500, {
          error:
            'The open change requests could not be closed, so the repository was not changed. ' +
            'Nothing was saved and no working copy was touched. Try again.',
        });
      }
      return json(404, { error: 'not mocked' });
    });
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();
    await screen.findByTestId('repository-change-confirm');

    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));

    expect(
      await screen.findByText(/The open change requests could not be closed/),
    ).toBeInTheDocument();
    // And nothing claims the repository was replaced.
    expect(screen.queryByTestId('repository-changed')).not.toBeInTheDocument();
  });

  /**
   * The address IS stored and it is the initialization that failed. The
   * confirmation has been answered and must go: left standing over a cleared
   * draft, its Replace button would re-send the stored address, change
   * nothing, and lose the "requests closed" outcome for good. The init banner
   * owns the retry from here.
   */
  it('takes the confirmation down when the save stored the address but initialization failed', async () => {
    transport.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/setup/test-connection') {
        return json(200, { ok: true, outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false });
      }
      if (url === '/api/setup/settings') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { confirmRepositoryChange?: string };
        if (!body.confirmRepositoryChange) {
          return json(409, {
            error: 'This moves the deployment to another repository.',
            repositoryChange: { openChangeRequests: 1 },
          });
        }
        return json(500, {
          error: 'The knowledge base could not be initialized.',
          kbInit: { kind: 'not-found', cause: 'There is no repository at that address.' },
        });
      }
      return json(404, { error: 'not mocked' });
    });
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);
    await typeTheNewAddressAndSave();
    await screen.findByTestId('repository-change-confirm');

    await userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));

    await waitFor(() =>
      expect(screen.queryByTestId('repository-change-confirm')).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Move the deployment' })).toBeNull();
    expect(await screen.findByText(/There is no repository at that address\./)).toBeInTheDocument();
    // Two requests went out; nothing re-sent the answered confirmation.
    expect(saveBodies()).toHaveLength(2);
  });
});

describe('a save the server refuses', () => {
  it('shows the reason the server gave, not only that it did not save', async () => {
    transport.authFetch.mockImplementation(async (url: string) => {
      if (url === '/api/setup/test-connection') {
        return json(400, {
          ok: false,
          error: 'There is no repository at that address, or the token cannot see it.',
        });
      }
      return json(404, { error: 'not mocked' });
    });
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} variant="settings" />);

    await typeTheNewAddressAndSave();

    // "Not saved" alone leaves an admin rereading a form that looks correct.
    const banner = await screen.findByText(/Not saved\./);
    expect(banner).toHaveTextContent('There is no repository at that address, or the token cannot see it.');
    expect(saveBodies()).toEqual([]);
  });
});
