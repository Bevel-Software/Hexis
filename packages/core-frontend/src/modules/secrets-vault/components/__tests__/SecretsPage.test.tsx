import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ToolSecrets } from '../../services/tool-secrets.api';
import type { AgentSecrets } from '../../services/agent-secrets.api';
import { SecretsPage } from '../SecretsPage';

const toolSecretsMock = vi.hoisted(() => ({ listToolSecrets: vi.fn() }));
const agentSecretsMock = vi.hoisted(() => ({ listAgentSecrets: vi.fn() }));

vi.mock('../../services/secrets.api', () => ({
  listSecrets: vi.fn(async () => []),
  createOAuthSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  startOAuth: vi.fn(async () => ''),
}));
vi.mock('../../services/tool-secrets.api', () => ({
  listToolSecrets: toolSecretsMock.listToolSecrets,
  setAdminVar: vi.fn(async () => {}),
  setUserVar: vi.fn(async () => {}),
  setOAuthClientSecret: vi.fn(async () => {}),
  deleteAdminVar: vi.fn(async () => {}),
  deleteUserVar: vi.fn(async () => {}),
}));
vi.mock('../../services/agent-secrets.api', () => ({
  listAgentSecrets: agentSecretsMock.listAgentSecrets,
  setAgentVar: vi.fn(async () => {}),
  deleteAgentVar: vi.fn(async () => {}),
}));

/** The page carries links now, so it needs a router around it. */
function renderPage() {
  return render(
    <MemoryRouter>
      <SecretsPage />
    </MemoryRouter>,
  );
}

describe('SecretsPage', () => {
  beforeEach(() => {
    // Each test starts on a clean /secrets URL (no leftover fragment).
    window.history.replaceState(null, '', '/secrets');
    toolSecretsMock.listToolSecrets.mockReset().mockResolvedValue([]);
    agentSecretsMock.listAgentSecrets.mockReset().mockResolvedValue([]);
  });

  it('renders as a full page (no dialog) and loads the secret lists', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(
      await screen.findByText('No tools you can access declare secrets yet.'),
    ).toBeInTheDocument();
    // Converted from the old gear-menu dialog: nothing modal is mounted.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('links each tool name at its own page', async () => {
    const heyreach: ToolSecrets = {
      slug: 'heyreach',
      name: 'heyreach',
      path: 'Plugins/GTM/heyreach.tool',
      type: 'inline',
      setup: null,
      canWrite: false,
      variables: [],
    };
    toolSecretsMock.listToolSecrets.mockResolvedValue([heyreach]);

    renderPage();
    const link = await screen.findByRole('link', { name: 'Open heyreach' });
    expect(link).toHaveAttribute('href', '/skills-and-tools/tools/heyreach');
  });

  it('surfaces the OAuth-callback success carried in the #authorized fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#authorized');
    renderPage();
    expect(await screen.findByText('Authorization complete.')).toBeInTheDocument();
    // The fragment is consumed so a refresh doesn't re-announce it.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/secrets');
  });

  it('shows an agent section only when an agent declares a secret', async () => {
    const coder: AgentSecrets = {
      slug: 'delivery_coder',
      name: 'delivery-coder',
      path: 'Agents/delivery-coder.agent',
      description: 'Implements a ticket in a prepared workspace.',
      canWrite: true,
      variables: [{ name: 'OPENAI_API_KEY', label: null, key: 'agent:delivery_coder:OPENAI_API_KEY', configured: false }],
    };
    agentSecretsMock.listAgentSecrets.mockResolvedValue([coder]);

    renderPage();
    expect(await screen.findByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('Needs a key')).toBeInTheDocument();
  });

  it('omits the agent section entirely when no agent declares one', async () => {
    renderPage();
    await screen.findByText('No tools you can access declare secrets yet.');
    expect(screen.queryByRole('heading', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it('surfaces the OAuth-callback error carried in the #error fragment and strips it', async () => {
    window.history.replaceState(null, '', '/secrets#error=Access%20denied');
    renderPage();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });
});
