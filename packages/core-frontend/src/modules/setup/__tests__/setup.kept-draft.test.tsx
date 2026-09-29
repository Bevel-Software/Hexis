import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testOidc: vi.fn(),
  syncNow: vi.fn(),
  fetchGitHubApp: vi.fn(),
  fetchGitHubRepositories: vi.fn(),
  startGitHubAppRegistration: vi.fn(),
  startGitHubAppInstallation: vi.fn(),
}));
vi.mock('../services/setup.api', async () => {
  const actual = await vi.importActual<typeof import('../services/setup.api')>('../services/setup.api');
  return { ...actual, ...api };
});
vi.mock('../../settings/services/github-facade.api', () => ({
  fetchGitHubFacade: vi.fn(),
  rotateGitHubFacade: vi.fn(),
  fetchMarketplaceRegistration: vi.fn(async () => false),
  setMarketplaceRegistration: vi.fn(),
}));

import { SetupScreen } from '../components/SetupScreen';
import type { GitHubAppStatus, GitMode, SettingStatus } from '../services/setup.api';
import { forgetDraft, keepDraft, keptDraft } from '../utils/kept-draft';

const setting = (key: string, section: SettingStatus['section'], extra: Partial<SettingStatus> = {}): SettingStatus => ({
  key,
  section,
  source: 'unset',
  value: '',
  configured: false,
  secret: false,
  restartToApply: false,
  ...extra,
});

const SETTINGS: SettingStatus[] = [
  setting('gitMode', 'knowledge-base'),
  setting('githubRepository', 'knowledge-base'),
  setting('kbRepoUrl', 'knowledge-base'),
  setting('gitToken', 'knowledge-base', { secret: true, value: undefined }),
  setting('knowledgeBaseDir', 'knowledge-base', { restartToApply: true }),
  setting('defaultBranch', 'knowledge-base'),
  setting('protectedBranches', 'knowledge-base'),
  setting('oidcIssuerUrl', 'sign-in'),
  setting('oidcClientId', 'sign-in'),
  setting('oidcClientSecret', 'sign-in', { secret: true, value: undefined }),
];
const MODES: GitMode[] = ['managed', 'github-app', 'token'];
const APP = { slug: 'hexis-acme', url: 'https://github.com/apps/hexis-acme' };
const NO_APP: GitHubAppStatus = { registeredBy: null, app: null, installation: null, repository: null };
const REGISTERED: GitHubAppStatus = { registeredBy: 'setup', app: APP, installation: null, repository: null };
const INSTALLED: GitHubAppStatus = { ...REGISTERED, installation: { id: '77', account: 'acme' } };

const realLocation = window.location;
const assign = vi.fn();
function standAt(search = '') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, href: `https://kb.acme.test/${search}`, search, origin: 'https://kb.acme.test', reload: vi.fn(), assign },
  });
}

const show = (settings: SettingStatus[] = SETTINGS) =>
  render(<SetupScreen settings={settings} onSaved={() => {}} repository={{ mode: null, chosen: null, modes: MODES }} />);
const field = (label: string) => screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
const isSecret = (key: string) => SETTINGS.find((s) => s.key === key)?.secret !== false;

/** Fill the form the way someone might before turning to GitHub, then press the button that leaves. */
async function typeThenLeave(press: string) {
  await userEvent.type(field('Knowledge folder'), 'Docs');
  await userEvent.type(field('Provider address'), 'https://login.example.com');
  await userEvent.type(field('Application ID'), 'an-app');
  await userEvent.type(field('Application secret'), 'a-secret-nobody-should-store');
  await userEvent.click(screen.getByRole('tab', { name: 'Address and token' }));
  await userEvent.type(field('Repository address'), 'https://git.example.com/acme/kb.git');
  await userEvent.type(field('Access token'), 'a-token-nobody-should-store');
  await userEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
  await userEvent.click(await screen.findByRole('button', { name: press }));
}

/** The page that comes back from GitHub: a new one, in the same tab. */
function comeBack(outcome = 'connected') {
  cleanup();
  standAt(`?github=${outcome}`);
  return show();
}

let submit: ReturnType<typeof vi.spyOn>;
let replace: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  assign.mockReset();
  sessionStorage.clear();
  api.fetchGitHubApp.mockResolvedValue(NO_APP);
  api.fetchGitHubRepositories.mockResolvedValue({ repositories: [], more: false });
  api.startGitHubAppRegistration.mockResolvedValue({ action: 'https://github.com/settings/apps/new?state=abc', manifest: {} });
  api.startGitHubAppInstallation.mockResolvedValue('https://github.com/apps/hexis-acme/installations/new?state=abc');
  submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
  standAt();
});

afterEach(() => {
  submit.mockRestore();
  replace.mockRestore();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('what was typed, across the trip to GitHub', () => {
  it('is there again when the browser comes back from creating the app', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    await waitFor(() => expect(submit).toHaveBeenCalled());

    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    comeBack();
    expect(field('Knowledge folder')).toHaveValue('Docs');
    // What was being typed about sign-in is shown, on the tab it was typed on.
    expect(field('Provider address')).toHaveValue('https://login.example.com');
    expect(field('Application ID')).toHaveValue('an-app');
    await userEvent.click(screen.getByRole('tab', { name: 'Address and token' }));
    expect(field('Repository address')).toHaveValue('https://git.example.com/acme/kb.git');
  });

  it('is there again after the second trip too, to install the app', async () => {
    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    show();
    await typeThenLeave('Install the app on GitHub');
    await waitFor(() => expect(assign).toHaveBeenCalled());

    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    comeBack();
    expect(field('Knowledge folder')).toHaveValue('Docs');
    expect(field('Provider address')).toHaveValue('https://login.example.com');
  });

  it('is what the form held when the browser left, not when the button was pressed', async () => {
    let answer: (address: string) => void = () => undefined;
    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    api.startGitHubAppInstallation.mockReturnValue(new Promise<string>((resolve) => (answer = resolve)));
    show();
    await userEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Install the app on GitHub' }));
    // Typed while GitHub was being asked where to go.
    await userEvent.type(field('Knowledge folder'), 'Docs');
    answer('https://github.com/apps/hexis-acme/installations/new?state=abc');
    await waitFor(() => expect(assign).toHaveBeenCalled());

    comeBack();
    expect(field('Knowledge folder')).toHaveValue('Docs');
  });

  it('is saved with everything else, like anything typed', async () => {
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: false, settings: SETTINGS, repository: { mode: null, chosen: null, modes: MODES } });
    show();
    await typeThenLeave('Create the GitHub App');
    comeBack();
    await userEvent.click(screen.getByRole('tab', { name: 'Managed for you' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0]).toEqual({
      gitMode: 'managed',
      knowledgeBaseDir: 'Docs',
      oidcIssuerUrl: 'https://login.example.com',
      oidcClientId: 'an-app',
    });
  });
});

describe('a secret, across the trip to GitHub', () => {
  it('is never written to the browser storage', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const stored = Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) ?? '').join('\n');
    expect(stored).toContain('Docs');
    expect(stored).not.toContain('a-secret-nobody-should-store');
    expect(stored).not.toContain('a-token-nobody-should-store');
  });

  it('comes back empty, and the screen says which to enter again', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    comeBack();
    expect(field('Application secret')).toHaveValue('');
    const notice = screen.getByTestId('enter-again');
    expect(notice).toHaveTextContent('What you had entered is back, except');
    expect(notice).toHaveTextContent('Application secret');
    expect(notice).toHaveTextContent('Access token');
    expect(notice).toHaveTextContent('enter them again');
  });

  it('stops being asked for as each is entered again', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    comeBack();
    await userEvent.type(field('Application secret'), 'typed-again');
    expect(screen.getByTestId('enter-again')).not.toHaveTextContent('Application secret');
    expect(screen.getByTestId('enter-again')).toHaveTextContent('enter it again');
    await userEvent.click(screen.getByRole('tab', { name: 'Address and token' }));
    await userEvent.type(field('Access token'), 'typed-again');
    expect(screen.queryByTestId('enter-again')).toBeNull();
  });

  it('is not given back even if the storage was made to hold one', () => {
    sessionStorage.setItem('hexis_setup_draft', JSON.stringify({ draft: { gitToken: 'planted', knowledgeBaseDir: 'Docs' }, dropped: [], at: Date.now() }));
    expect(keptDraft(isSecret).draft).toEqual({ knowledgeBaseDir: 'Docs' });
    // A setting the form has never heard of is treated as one.
    expect(keptDraft(isSecret).draft).not.toHaveProperty('somethingElse');
  });
});

describe('what is kept, and for how long', () => {
  it('is given back once: a reload of the page that came back starts from what is stored', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    comeBack();
    expect(field('Knowledge folder')).toHaveValue('Docs');
    expect(sessionStorage.getItem('hexis_setup_draft')).toBeNull();
    comeBack();
    expect(field('Knowledge folder')).toHaveValue('');
  });

  it('is not sprung on someone who opens the screen without coming back from GitHub', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    // The trip was abandoned; the screen is opened again later, in the same tab.
    cleanup();
    standAt();
    show();
    expect(field('Knowledge folder')).toHaveValue('');
    expect(screen.queryByTestId('enter-again')).toBeNull();
    // And it is gone, so a later return from GitHub does not find it either.
    expect(sessionStorage.getItem('hexis_setup_draft')).toBeNull();
  });

  it('is good for half an hour', () => {
    const left = Date.parse('2026-09-29T10:00:00Z');
    keepDraft({ knowledgeBaseDir: 'Docs' }, isSecret, left);
    expect(keptDraft(isSecret, left + 29 * 60_000).draft).toEqual({ knowledgeBaseDir: 'Docs' });
    expect(keptDraft(isSecret, left + 31 * 60_000).draft).toEqual({});
  });

  it('keeps nothing when nothing was typed', () => {
    keepDraft({ knowledgeBaseDir: '  ', gitMode: '' }, isSecret);
    expect(sessionStorage.getItem('hexis_setup_draft')).toBeNull();
  });

  it('gives back nothing for a setting the environment has taken over meanwhile', async () => {
    show();
    await typeThenLeave('Create the GitHub App');
    cleanup();
    standAt('?github=connected');
    show(SETTINGS.map((s) => (s.key === 'knowledgeBaseDir' ? { ...s, source: 'env', envVar: 'KB_KNOWLEDGE_BASE_DIR' } : s)));
    expect(screen.queryByLabelText('Knowledge folder', { exact: false })).toBeNull();
    expect(field('Provider address')).toHaveValue('https://login.example.com');
  });

  it('reads storage that holds something else as nothing kept', () => {
    for (const junk of ['not json', '{"draft":"no"}', '{"at":"yesterday","draft":{}}', '[]', 'null']) {
      sessionStorage.setItem('hexis_setup_draft', junk);
      expect(keptDraft(isSecret), junk).toEqual({ draft: {}, dropped: [] });
    }
    forgetDraft();
    expect(sessionStorage.getItem('hexis_setup_draft')).toBeNull();
  });
});
