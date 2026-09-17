import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The form's handling of a probe the SERVER refused. Unlike `setup.test.tsx`
 * this mocks only the transport, not the setup API, so what is under test is
 * the whole path: a 4xx from `/api/setup/test-connection` must reach the form
 * as the rejection it is — never as "could not ask", which the form used to
 * carry on past straight into a save.
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
import { testConnection, type SettingStatus } from '../services/setup.api';

const KB = 'knowledge-base' as const;
const SETTINGS: SettingStatus[] = [
  { key: 'kbRepoUrl', envVar: 'KB_REPO_URL', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'gitToken', envVar: 'GIT_TOKEN', section: KB, source: 'unset', configured: false, secret: true, restartToApply: false },
  { key: 'gitUsername', envVar: 'GIT_USERNAME', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'defaultBranch', envVar: 'DEFAULT_BRANCH', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
  { key: 'protectedBranches', envVar: 'PROTECTED_BRANCHES', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
];

const TOKEN_RULE =
  'Enter the access token for that repository — the saved one is only used with the repository it was saved for.';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every POST to the save endpoint, so a test can assert there was none. */
const saves = () =>
  transport.authFetch.mock.calls.filter(([url]) => String(url) === '/api/setup/settings');

beforeEach(() => {
  transport.authFetch.mockReset();
  transport.authFetch.mockImplementation(async (url: string) => {
    if (url === '/api/setup/test-connection') return json(400, { ok: false, error: TOKEN_RULE });
    if (url === '/api/setup/settings') {
      return json(200, { ok: true, restartRequired: false, complete: true, settings: SETTINGS });
    }
    return json(404, { error: 'not mocked' });
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), origin: 'https://example.test' },
  });
});

describe('testConnection — a refused probe is an answer', () => {
  it('turns a 4xx into a rejection carrying the server’s words', async () => {
    await expect(testConnection({ kbRepoUrl: 'https://x/y.git' })).resolves.toEqual({
      ok: false,
      outcome: 'rejected',
      field: undefined,
      error: TOKEN_RULE,
    });
  });

  it.each([
    [401, 'Not signed in'],
    [403, 'Admin access required'],
  ])('throws on a %i — the session was refused, not the repository', async (status, error) => {
    transport.authFetch.mockResolvedValue(json(status, { error }));
    await expect(testConnection({ kbRepoUrl: 'https://x/y.git' })).rejects.toThrow(error);
  });

  it('still throws when the check could not be asked at all', async () => {
    transport.authFetch.mockResolvedValue(json(500, { error: 'Could not run the connection check.' }));
    await expect(testConnection({})).rejects.toThrow(/could not run/i);
  });
});

describe('SetupScreen — a probe 4xx stops the save', () => {
  it('setup: shows the refusal and saves nothing', async () => {
    render(<SetupScreen settings={SETTINGS} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.type(screen.getByLabelText('Access token'), 'ghp_x');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_RULE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
    expect(saves()).toEqual([]);
  });

  it('settings: a moved address without its token is refused, not saved', async () => {
    const stored = SETTINGS.map((s) =>
      s.key === 'kbRepoUrl'
        ? { ...s, source: 'stored' as const, value: 'https://example.com/kb.git', configured: true }
        : s.key === 'gitToken'
          ? { ...s, source: 'stored' as const, configured: true }
          : s,
    );
    const onSaved = vi.fn();
    render(<SetupScreen settings={stored} onSaved={onSaved} variant="settings" />);
    const url = screen.getByLabelText('Repository address');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://example.com/moved.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(/Not saved/)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_RULE)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled(),
    );
    expect(saves()).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
