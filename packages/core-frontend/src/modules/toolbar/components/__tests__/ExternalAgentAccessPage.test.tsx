import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExternalAgentAccessPage } from '../ExternalAgentAccessPage';
import { configureMcpUrl } from '../../../../shared/mcp';
import { GITHUB_LINK_KIND, configureMarketplaceGitUrl } from '../../../../shared/marketplace-url';
import * as keysApi from '../../services/external-api-keys.api';

/**
 * The External agent access page's contract.
 *
 * One task is open (connect your agent); API keys and skills as plugins are
 * closed rows. And the reason this file existed before any of that: every
 * HOSTED snippet quotes the DEPLOYMENT's address, never the browser's, and
 * every LOCAL-server (hexis-mcp) snippet quotes the browser's origin, never
 * the deployment's MCP endpoint. Two families, two addresses, on purpose:
 * hexis-mcp takes the workspace base and resolves the endpoint from
 * `GET /api/config` itself, and the one base the browser has proven serves
 * the whole app is its own origin.
 */

const { listMock, createMock, authFetchMock, registrationMock, adminState, agentChoicesMock, agentState, copyMock } = vi.hoisted(() => ({
  // What `useAgentConnection` answers: nothing connected unless a case says so.
  agentState: { value: { connected: false, settled: true } as { connected: boolean; settled: boolean; at?: string; client?: string } },
  copyMock: vi.fn<(text: string) => Promise<boolean>>(async () => true),
  agentChoicesMock: vi.fn(),
  listMock: vi.fn(),
  createMock: vi.fn(),
  // Every request that reaches the network layer, recorded and answered 404.
  authFetchMock: vi.fn(async () => new Response('{}', { status: 404 })),
  registrationMock: vi.fn(),
  // Mutable so one file can mount the page as both roles: the tutorial must
  // be identical for both, and only the "not set up" notice may differ.
  adminState: { isAdmin: false },
}));

// The other modules this page reaches, replaced at their entries: that is
// where the page imports them from, and the one surface a mock may stand in
// for. Only the hook is replaced on `admin`; the rest of its entry stays real.
vi.mock('../../../admin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../admin')>()),
  useAdmin: () => ({ isAdmin: adminState.isAdmin }),
}));

// The registration state the Cowork drawer reads.
vi.mock('../../../settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../settings')>()),
  fetchMarketplaceRegistration: registrationMock,
}));

// The network layer, observed rather than any module's files: the admin
// credentials endpoint is asserted below never to be asked, by whatever path.
vi.mock('../../../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/api')>()),
  authFetch: authFetchMock,
}));

// The agents a key may be minted as ("Connect as").
vi.mock('../../../agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agents')>()),
  listAgentChoices: agentChoicesMock,
}));

// "Did an agent connect?": the page asks the onboarding module's hook.
vi.mock('../../../onboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../onboarding')>()),
  useAgentConnection: () => agentState.value,
}));

// jsdom has no clipboard; the cases read what was copied from this.
vi.mock('../../../../lib/clipboard', () => ({ copyToClipboard: copyMock }));

vi.mock('../../services/external-api-keys.api', () => ({
  listExternalApiKeys: listMock,
  createExternalApiKey: createMock,
  disconnectExternalApiKey: vi.fn(async () => {}),
  deleteExternalApiKey: vi.fn(async () => {}),
}));

/** A deployment configured the way a real one is: public, https, its own domain. */
const PUBLIC_URL = 'https://kb.acme.com/api/mcp';
/** What an unconfigured deployment actually runs with — see `.env.example`. */
const LOCALHOST_URL = 'http://localhost:3001/api/mcp';

const KEY = 'bvl_live_s3cret';

beforeEach(() => {
  adminState.isAdmin = false;
  agentState.value = { connected: false, settled: true };
  copyMock.mockClear();
  vi.mocked(keysApi.disconnectExternalApiKey).mockClear();
  vi.mocked(keysApi.deleteExternalApiKey).mockClear();
  // Cleared: what reached the network is an assertion of its own below.
  authFetchMock.mockClear();
  registrationMock.mockReset();
  registrationMock.mockResolvedValue(false);
  listMock.mockResolvedValue([]);
  agentChoicesMock.mockReset();
  agentChoicesMock.mockResolvedValue([]);
  createMock.mockClear();
  createMock.mockResolvedValue({
    plaintext: KEY,
    summary: {
      id: 'k1',
      label: 'CI',
      createdAt: Date.now(),
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
    },
  });
});

function mount(mcpUrl: string) {
  configureMcpUrl(mcpUrl);
  // The marketplace remote is served from the same deployment address.
  configureMarketplaceGitUrl(`${new URL(mcpUrl).origin}/git/marketplace.git`);
  return render(
    <MemoryRouter>
      <ExternalAgentAccessPage />
    </MemoryRouter>,
  );
}

/** Everything on screen that can be copied, as plain strings (closed rows included: they are in the page, not in view). */
function snippets(): string[] {
  return Array.from(document.querySelectorAll('.font-mono')).map((el) => el.textContent ?? '');
}

function row(testId: string): HTMLDetailsElement {
  return screen.getByTestId(testId) as HTMLDetailsElement;
}

/** Open the API keys row, name a key and create it, so its dialog is on screen. */
async function createAKey(user: ReturnType<typeof userEvent.setup>, name = 'CI') {
  await user.click(within(row('keys-section')).getByText('API keys'));
  await user.type(screen.getByRole('textbox', { name: 'Name of the new API key' }), name);
  await user.click(within(row('keys-section')).getByRole('button', { name: 'Create key' }));
  return screen.findByRole('dialog', { name: 'Save this key now' });
}

const KEY_ROW = {
  id: 'k1',
  label: 'Nightly pipeline',
  createdAt: Date.now() - 3_600_000,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};

describe('the first screen: one open task, everything else a closed row', () => {
  it('opens on connecting an agent, with one button and two closed rows', async () => {
    mount(PUBLIC_URL);
    const card = screen.getByTestId('agent-connection-section');
    expect(within(card).getByRole('heading', { name: 'Connect your agent' })).toBeInTheDocument();
    expect(within(card).getByRole('radiogroup', { name: 'Your agent' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Add to Claude/ })).toBeInTheDocument();
    expect(row('keys-section').open).toBe(false);
    expect(row('plugins-row').open).toBe(false);
    // What agents are told is a workspace setting: it lives on Deployment.
    expect(screen.queryByTestId('agent-instructions-section')).not.toBeInTheDocument();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
  });

  /**
   * API keys and skills as plugins close each other the way every closed row
   * here does: they are `<details>` of ONE `name` group, and the browser
   * shuts the open one when another of the group opens (the HTML exclusive
   * accordion). The test DOM does not implement that closing, so this pins
   * what the page owns: both rows in the same group, and no other row in it.
   */
  it('puts API keys and skills as plugins in one group, so opening one closes the other', async () => {
    mount(PUBLIC_URL);
    const group = row('keys-section').getAttribute('name');
    expect(group).toBeTruthy();
    expect(row('plugins-row').getAttribute('name')).toBe(group);
    expect(document.querySelectorAll(`details[name="${group}"]`)).toHaveLength(2);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
  });

  it('waits for the agent only once the reader has acted', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(screen.queryByText('Waiting for your agent…')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Add to Claude/ });
    link.addEventListener('click', (e) => e.preventDefault());
    await user.click(link);
    expect(screen.getByText('Waiting for your agent…')).toBeInTheDocument();
  });

  it('shows the connection, and no button for a job that is done, once an agent has connected', async () => {
    agentState.value = { connected: true, settled: true, client: 'Claude', at: new Date(Date.now() - 120_000).toISOString() };
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    const card = screen.getByTestId('agent-connection-section');
    expect(within(card).getByRole('heading', { name: 'Your agent' })).toBeInTheDocument();
    expect(within(card).getByText('Connected. Claude reached this knowledge base 2m ago.')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Add to Claude/ })).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Connect another agent' }));
    expect(within(card).getByRole('link', { name: /Add to Claude/ })).toBeInTheDocument();
  });
});

describe('each agent: one thing to do, each family on its own address', () => {
  it('gives Claude the deployment address to add by hand', () => {
    mount(PUBLIC_URL);
    expect(screen.getByText('Or add it by hand').closest('details')).not.toHaveAttribute('open');
    expect(snippets()).toContain(PUBLIC_URL);
  });

  it('gives ChatGPT the address, then a link that only opens ChatGPT', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('radio', { name: 'ChatGPT' }));
    expect(snippets()).toContain(PUBLIC_URL);
    expect(screen.getByRole('link', { name: /Open ChatGPT/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add to ChatGPT/ })).not.toBeInTheDocument();
  });

  it('gives coding agents a prompt to paste, built from the origin, never the MCP endpoint', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('radio', { name: 'Coding agents' }));
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));

    const prompt = copyMock.mock.calls[0]![0];
    expect(prompt).toContain('claude mcp add --scope user skills-tools-knowledge');
    expect(prompt).toContain(`HEXIS_URL="${window.location.origin}"`);
    expect(prompt).toContain('"mcpServers"');
    expect(prompt).not.toContain(PUBLIC_URL);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    // Copying is acting: the page now waits for the agent.
    expect(screen.getByText('Waiting for your agent…')).toBeInTheDocument();

    // By hand: the same configuration, to paste.
    const json = snippets().find((v) => v.includes('mcpServers') && v.includes('npx'));
    expect(JSON.parse(json!).mcpServers['skills-tools-knowledge'].env.HEXIS_URL).toBe(window.location.origin);
  });

  it('shows the prompt to select when the browser refuses the clipboard', async () => {
    copyMock.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('radio', { name: 'Coding agents' }));
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(await screen.findByText(/Your browser did not allow copying/)).toBeInTheDocument();
    expect(snippets().some((v) => v.startsWith("Connect yourself to my company's knowledge base"))).toBe(true);
  });

  it('gives any other tool the address first, then the hosted configuration and the Claude Code command', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(screen.getByRole('radio', { name: 'Other' }));
    const values = snippets();
    expect(values).toContain(PUBLIC_URL);
    expect(values).toContain(`claude mcp add --transport http skills-tools-knowledge ${PUBLIC_URL}`);
    const json = values.find((v) => v.includes('"type": "http"') && v.includes('mcpServers'));
    expect(JSON.parse(json!).mcpServers['skills-tools-knowledge'].url).toBe(PUBLIC_URL);
  });

  it('opens on coding agents where Claude and ChatGPT cannot reach the deployment, and says why', async () => {
    const user = userEvent.setup();
    mount(LOCALHOST_URL);
    expect(screen.getByRole('radio', { name: 'Coding agents' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Claude' }));
    expect(screen.getByText(/Claude connects over the internet, and this deployment has no public https address/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add to Claude/ })).not.toBeInTheDocument();
    expect(snippets()).not.toContain(LOCALHOST_URL);
  });

  it('gives every button an explicit type so it cannot submit a form', () => {
    mount(PUBLIC_URL);
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button');
  });
});

describe('API keys', () => {
  it('names the row with the number of active keys', async () => {
    listMock.mockResolvedValue([KEY_ROW, { ...KEY_ROW, id: 'k2', label: 'Old laptop', revokedAt: Date.now(), revokedBy: 'user' }]);
    mount(PUBLIC_URL);
    expect(await within(row('keys-section')).findByText('1 active')).toBeInTheDocument();
  });

  it('keeps Create key off until the key has a name', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('keys-section')).getByText('API keys'));
    const create = within(row('keys-section')).getByRole('button', { name: 'Create key' });
    await waitFor(() => expect(agentChoicesMock).toHaveBeenCalled());
    expect(create).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Name of the new API key' }), 'CI');
    expect(create).toBeEnabled();
  });

  it('shows a new key once, as the one thing to copy, with each use behind a closed row', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    const dialog = await createAKey(user);
    expect(createMock).toHaveBeenCalledWith('CI', null);

    const copyable = Array.from(dialog.querySelectorAll('.font-mono')).map((el) => el.textContent ?? '');
    expect(copyable[0]).toBe(KEY);
    for (const use of ['Use it in a pipeline or CI', 'Use it in Claude Code', 'Use it in Langdock', 'Use it in a coding agent on your machine']) {
      expect(within(dialog).getByText(use).closest('details')).not.toHaveAttribute('open');
    }
    // Hosted uses quote the deployment; the local server gets the origin. Both carry the key.
    expect(copyable).toContain(`claude mcp add --transport http skills-tools-knowledge ${PUBLIC_URL} --header "Authorization: Bearer ${KEY}"`);
    const local = copyable.find((v) => v.includes('npx') && v.includes('mcpServers'));
    expect(JSON.parse(local!).mcpServers['skills-tools-knowledge'].env).toEqual({
      HEXIS_URL: window.location.origin,
      HEXIS_CONNECTION_KEY: KEY,
    });
    // The footer button is the only way out: a one-time key has no cross to close it by accident.
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Done: I’ve saved it' }));
    expect(screen.queryByRole('dialog', { name: 'Save this key now' })).not.toBeInTheDocument();
    expect(snippets()).not.toContain(KEY);
  });

  it('lists active keys first and says what became of the others', async () => {
    listMock.mockResolvedValue([
      { ...KEY_ROW, id: 'k3', label: 'Taken away', revokedAt: Date.now(), revokedBy: 'admin' },
      { ...KEY_ROW, id: 'k2', label: 'Old laptop', revokedAt: Date.now(), revokedBy: 'user' },
      KEY_ROW,
    ]);
    mount(PUBLIC_URL);
    const list = await screen.findByRole('list', { name: 'Your API keys' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Nightly pipeline');
    expect(items[0]).toHaveTextContent('Never used');
    expect(within(list).getByText(/Revoked by an admin/)).toBeInTheDocument();
    expect(within(list).getByText(/· Disconnected/)).toBeInTheDocument();
  });

  it('asks before disconnecting, and disconnects only on the answer', async () => {
    listMock.mockResolvedValue([KEY_ROW]);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    const list = await screen.findByRole('list', { name: 'Your API keys' });
    await user.click(within(list).getByRole('button', { name: 'Disconnect' }));

    const confirm = await screen.findByRole('dialog', { name: 'Disconnect API key' });
    expect(confirm).toHaveTextContent('this key cannot be connected again');
    expect(keysApi.disconnectExternalApiKey).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(keysApi.disconnectExternalApiKey).toHaveBeenCalledWith('k1');
  });

  it('deletes a disconnected key only after asking', async () => {
    listMock.mockResolvedValue([{ ...KEY_ROW, revokedAt: Date.now(), revokedBy: 'user' }]);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    const list = await screen.findByRole('list', { name: 'Your API keys' });
    await user.click(within(list).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete API key' });
    expect(confirm).toHaveTextContent('removes it and its usage history for good');
    expect(keysApi.deleteExternalApiKey).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(keysApi.deleteExternalApiKey).toHaveBeenCalledWith('k1');
  });

  it('says once that the keys could not be loaded, with a way to try again', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load your keys. boom');
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    listMock.mockResolvedValue([KEY_ROW]);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Your API keys' })).toHaveTextContent('Nightly pipeline');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a failed create beside the action that failed, and keeps the name', async () => {
    createMock.mockRejectedValueOnce(new Error('nope'));
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('keys-section')).getByText('API keys'));
    const field = screen.getByRole('textbox', { name: 'Name of the new API key' });
    await user.type(field, 'CI');
    await user.click(within(row('keys-section')).getByRole('button', { name: 'Create key' }));
    expect(await within(row('keys-section')).findByRole('alert')).toHaveTextContent('nope');
    expect(within(row('plugins-row')).queryByRole('alert')).not.toBeInTheDocument();
    expect(field).toHaveValue('CI');
  });
});

describe('minting a key as an agent ("Connect as")', () => {
  const AGENTS = [{ path: 'Agents/Support.agent', name: 'Support', description: 'Answers customers.' }];

  it('asks nothing when there is no agent to mint as', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await createAKey(user);
    expect(screen.queryByRole('group', { name: 'Connect as' })).not.toBeInTheDocument();
    expect(createMock).toHaveBeenCalledWith('CI', null);
  });

  it('puts the choice before the button, and mints as the agent when one is picked', async () => {
    agentChoicesMock.mockResolvedValue(AGENTS);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('keys-section')).getByText('API keys'));
    const choice = await screen.findByRole('group', { name: 'Connect as' });
    const create = within(row('keys-section')).getByRole('button', { name: 'Create key' });
    expect(choice.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(choice).getByRole('radio', { name: /Support/ }));
    await user.type(screen.getByRole('textbox', { name: 'Name of the new API key' }), 'CI');
    await user.click(create);
    await screen.findByRole('dialog', { name: 'Save this key now' });
    expect(createMock).toHaveBeenCalledWith('CI', 'Agents/Support.agent');
  });
});

describe('skills as native plugins: optional, and never a command that cannot run', () => {
  it('says how it differs from connecting, and never shows a placeholder key', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    expect(within(row('plugins-row')).getByText('Optional')).toBeInTheDocument();
    expect(within(row('plugins-row')).getByText(/A connected agent already has your skills/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('<external-api-key>');
  });

  it('makes the install command with a key of its own, shown as the one thing to copy', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    await waitFor(() => expect(agentChoicesMock).toHaveBeenCalled());
    await user.click(within(row('plugins-row')).getByRole('button', { name: 'Create install command' }));

    const dialog = await screen.findByRole('dialog', { name: 'Install your skills' });
    expect(createMock).toHaveBeenCalledWith(expect.stringMatching(/^Plugins, /), null);
    const copyable = Array.from(dialog.querySelectorAll('.font-mono')).map((el) => el.textContent ?? '');
    expect(copyable[0]).toContain('claude plugin marketplace add');
    expect(copyable[0]).toContain(KEY);
    expect(copyable[0]).toContain('kb.acme.com/git/marketplace.git');
    for (const other of ['Codex', 'Any other agent, through the skills CLI', 'The key alone']) {
      expect(within(dialog).getByText(other).closest('details')).not.toHaveAttribute('open');
    }
    // Nothing was "saved": the reader ran a command.
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    // The API keys row stays closed: nothing jumps to another card.
    expect(row('keys-section').open).toBe(false);
  });

  it('makes the plugin key for everything, whatever the API keys row has picked, and even when agents failed to load', async () => {
    agentChoicesMock.mockRejectedValue(new Error('agents down'));
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    await waitFor(() => expect(agentChoicesMock).toHaveBeenCalled());
    const create = within(row('plugins-row')).getByRole('button', { name: 'Create install command' });
    expect(create).toBeEnabled();
    await user.click(create);
    await screen.findByRole('dialog', { name: 'Install your skills' });
    expect(createMock).toHaveBeenCalledWith(expect.stringMatching(/^Plugins, /), null);
  });

  it('says when the Cowork check failed, and asks again on request', async () => {
    adminState.isAdmin = true;
    registrationMock.mockRejectedValueOnce(new Error('down'));
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    const alert = await within(row('plugins-row')).findByRole('alert');
    expect(alert).toHaveTextContent('Could not check whether Cowork and claude.ai are set up.');
    expect(within(row('plugins-row')).queryByRole('link', { name: 'set it up in Deployment' })).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(registrationMock).toHaveBeenCalledTimes(2));
    expect(await within(row('plugins-row')).findByRole('link', { name: 'set it up in Deployment' })).toBeInTheDocument();
  });

  it('reads the registration only when the row is opened, and never the admin credentials', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    expect(registrationMock).not.toHaveBeenCalled();
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    await waitFor(() => expect(registrationMock).toHaveBeenCalledTimes(1));
    // Every form authFetch accepts (a path, an absolute URL, a URL, a Request), as its pathname.
    const asked = authFetchMock.mock.calls.map((call) => {
      const input = (call as unknown[])[0];
      const href = input instanceof Request ? input.url : String(input);
      return new URL(href, window.location.origin).pathname;
    });
    expect(asked.filter((path) => path.startsWith('/api/admin/github-facade'))).toEqual([]);
  });

  it('shows a member nothing about Cowork until the deployment is registered', async () => {
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    await waitFor(() => expect(registrationMock).toHaveBeenCalled());
    expect(within(row('plugins-row')).queryByText(/Cowork/)).not.toBeInTheDocument();
  });

  it('sends an admin to Deployment while the deployment is not registered', async () => {
    adminState.isAdmin = true;
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    expect(await within(row('plugins-row')).findByRole('link', { name: 'set it up in Deployment' })).toHaveAttribute(
      'href',
      '/deployment#marketplace',
    );
  });

  it('opens the Cowork steps, with the Claude connections, once registered', async () => {
    registrationMock.mockResolvedValue(true);
    listMock.mockResolvedValue([{ ...KEY_ROW, id: 'c1', label: 'Claude: Ada', kind: GITHUB_LINK_KIND }]);
    const user = userEvent.setup();
    mount(PUBLIC_URL);
    await user.click(within(row('plugins-row')).getByText('Install skills as native plugins'));
    await user.click(await within(row('plugins-row')).findByRole('button', { name: 'show the steps' }));

    const dialog = await screen.findByRole('dialog', { name: 'Skills in Cowork and claude.ai' });
    expect(within(dialog).getByText('Your Claude connections')).toBeInTheDocument();
    expect(within(dialog).getByText('Claude: Ada')).toBeInTheDocument();
    // A Claude connection is not an API key: it is told apart by its stored kind, never its label.
    expect(screen.queryByRole('list', { name: 'Your API keys' })).not.toBeInTheDocument();
  });
});
