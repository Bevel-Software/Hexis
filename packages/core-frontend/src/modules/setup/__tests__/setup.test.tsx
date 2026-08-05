import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
}));
vi.mock('../services/setup.api', async () => {
  // The error class is real — the screen distinguishes field problems from a
  // general failure by `instanceof`, so a stub would defeat the test.
  const actual = await vi.importActual<typeof import('../services/setup.api')>(
    '../services/setup.api',
  );
  return { ...actual, ...api };
});

import { SetupGate } from '../components/SetupGate';
import { SettingsProblems, type SettingStatus } from '../services/setup.api';

const SETTINGS: SettingStatus[] = [
  { key: 'kbRepoUrl', envVar: 'KB_REPO_URL', source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'gitToken', envVar: 'GIT_TOKEN', source: 'unset', configured: false, secret: true, restartToApply: false },
  { key: 'gitUsername', envVar: 'GIT_USERNAME', source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'kbDirName', envVar: 'KB_DIR_NAME', source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
];

beforeEach(() => {
  api.fetchSetupStatus.mockReset();
  api.saveSettings.mockReset();
  api.testConnection.mockReset();
});

const APP = <div>The application</div>;

describe('SetupGate', () => {
  it('lets a configured deployment straight through', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true });
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText('The application')).toBeInTheDocument();
  });

  /**
   * The app behind this gate reads from a workspace that cannot exist yet.
   * Rendering it — even for a moment — shows a broken file tree and a stream of
   * failed requests to the person least able to do anything about it.
   */
  it('shows a non-admin that setup is in progress, not the app', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: false });
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText(/Still being set up/)).toBeInTheDocument();
    expect(screen.queryByText('The application')).toBeNull();
  });

  it('tells a non-admin nothing about what is missing', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: false });
    render(<SetupGate>{APP}</SetupGate>);
    await screen.findByText(/Still being set up/);
    expect(document.body.textContent).not.toContain('KB_REPO_URL');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /**
   * The check guards against an unconfigured deployment; it is not an
   * authorisation boundary. Blocking on a transient failure would lock everyone
   * out of a deployment that works.
   */
  it('opens the gate when the status check itself fails', async () => {
    api.fetchSetupStatus.mockRejectedValue(new Error('offline'));
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText('The application')).toBeInTheDocument();
  });

  it('claims nothing until the answer is in', () => {
    api.fetchSetupStatus.mockReturnValue(new Promise(() => {}));
    render(<SetupGate>{APP}</SetupGate>);
    expect(screen.queryByText('The application')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});

describe('SetupScreen', () => {
  async function renderScreen(settings: SettingStatus[] = SETTINGS) {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: true, settings });
    render(<SetupGate>{APP}</SetupGate>);
    await screen.findByRole('heading', { name: /Connect your knowledge base/ });
  }

  it('saves what was typed and lets the app through once complete', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
    // The second status read is what the gate acts on.
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true });

    await userEvent.type(screen.getByLabelText('Repository URL'), 'https://example.com/kb.git');
    await userEvent.type(screen.getByLabelText('Access token'), 'ghp_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith({
        kbRepoUrl: 'https://example.com/kb.git',
        gitToken: 'ghp_secret',
      }),
    );
    expect(await screen.findByText('The application')).toBeInTheDocument();
  });

  /**
   * The whole reason a form beats an environment variable: it can ask the host
   * whether the answer is right, and say which part was wrong — before anything
   * is saved, rather than in a clone failure minutes later.
   */
  it('reports what the host said about the credentials', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: false,
      error: 'The host rejected those credentials.',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/rejected those credentials/)).toBeInTheDocument();
  });

  /** An empty repository is a supported starting point, not a failure. */
  it('treats an empty repository as a success', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({ ok: true, empty: true, branches: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/repository is empty/)).toBeInTheDocument();
  });

  it('marks the field the server complained about', async () => {
    await renderScreen();
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ kbRepoUrl: 'The URL must start with https://' }),
    );
    await userEvent.type(screen.getByLabelText('Repository URL'), 'git@example.com:kb.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('must start with https://');
    expect(screen.getByLabelText('Repository URL')).toHaveAttribute('aria-invalid', 'true');
  });

  /**
   * A stored secret is never sent back, so there is nothing to prefill. The
   * field says what leaving it blank means instead of looking empty-and-unset.
   */
  it('does not pretend to show a saved token', async () => {
    await renderScreen([
      { ...SETTINGS[1]!, source: 'stored', configured: true },
      ...SETTINGS.filter((s) => s.key !== 'gitToken'),
    ]);
    const token = screen.getByLabelText('Access token');
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('placeholder', 'Saved — type to replace');
  });

  /**
   * A value the environment supplies cannot be overwritten from a browser —
   * the server refuses it, so offering an input would be a lie. The variable is
   * named instead, which is the actionable thing.
   */
  it('does not offer to edit a setting the environment owns', async () => {
    await renderScreen([
      { ...SETTINGS[0]!, source: 'env', value: 'https://env.example/kb.git', configured: true },
      ...SETTINGS.slice(1),
    ]);
    expect(screen.queryByLabelText('Repository URL')).toBeNull();
    expect(screen.getByText('KB_REPO_URL')).toBeInTheDocument();
  });

  it('says so when a saved setting needs a restart', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({ restartRequired: true, complete: false, settings: SETTINGS });
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: true, settings: SETTINGS });
    await userEvent.type(screen.getByLabelText('Folder name'), 'company-brain');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(/restart it when convenient/)).toBeInTheDocument();
  });
});
