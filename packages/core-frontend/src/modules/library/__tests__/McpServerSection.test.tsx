import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { McpServerView } from '../services/tools.api';

/**
 * The server-scoped editor. What is worth pinning: the section renders nothing
 * for a `.tool`-backed manual (GET 404 → null), non-writers get facts and no
 * button, and a RENAME with configured secrets is interrupted by a dialog that
 * names the count — the save must not fire until "Rename anyway".
 */

const apiMock = vi.hoisted(() => ({
  getMcpServer: vi.fn<() => Promise<McpServerView | null>>(),
  putMcpServer: vi.fn(),
}));
vi.mock('../services/tools.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/tools.api')>()),
  getMcpServer: apiMock.getMcpServer,
  putMcpServer: apiMock.putMcpServer,
}));

import { McpServerSection } from '../components/tool-page/McpServerSection';

const VIEW: McpServerView = {
  name: 'vendor',
  transport: 'streamable-http',
  url: 'https://v.example/mcp',
  literalHeaders: { 'X-V': '2' },
  authHeaders: { Authorization: 'Bearer ${VENDOR_KEY}' },
  variables: [{ name: 'VENDOR_KEY', scope: 'user' }],
  local: false,
  canWrite: true,
};

function renderSection(configuredCount = 2) {
  const onSaved = vi.fn();
  const onError = vi.fn();
  render(
    <MemoryRouter>
      <McpServerSection slug="vendor" configuredCount={configuredCount} onSaved={onSaved} onError={onError} />
    </MemoryRouter>,
  );
  return { onSaved, onError };
}

beforeEach(() => {
  apiMock.getMcpServer.mockReset();
  apiMock.putMcpServer.mockReset();
  apiMock.putMcpServer.mockResolvedValue({ name: 'vendor' });
});

describe('McpServerSection', () => {
  it('renders nothing for a .tool-backed manual', async () => {
    apiMock.getMcpServer.mockResolvedValue(null);
    renderSection();
    await waitFor(() => expect(apiMock.getMcpServer).toHaveBeenCalled());
    expect(screen.queryByText('Server')).not.toBeInTheDocument();
  });

  it('shows the facts, and the edit button only to writers', async () => {
    apiMock.getMcpServer.mockResolvedValue({ ...VIEW, canWrite: false });
    renderSection();
    expect(await screen.findByText('https://v.example/mcp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit server' })).not.toBeInTheDocument();
  });

  it('saves without ceremony when the name is unchanged', async () => {
    apiMock.getMcpServer.mockResolvedValue(VIEW);
    const { onSaved } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.putMcpServer).toHaveBeenCalledTimes(1));
    // No newName in the payload — an unchanged name is not a rename.
    expect(apiMock.putMcpServer.mock.calls[0]![1]).not.toHaveProperty('newName');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('confirms a rename even when this caller sees nothing configured', async () => {
    // Other members' user-scoped values and sign-ins are invisible to this
    // page, so a zero count proves nothing — the confirm must still gate.
    apiMock.getMcpServer.mockResolvedValue(VIEW);
    renderSection(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'vendor_eu' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(apiMock.putMcpServer).not.toHaveBeenCalled();
    expect(await screen.findByText(/other members' values, which this page cannot see/)).toBeInTheDocument();
  });

  it('round-trips cwd/env on a stdio save — the form has no fields for them', async () => {
    // The PUT rebuilds the entry from the payload, so omitting `cwd`/`env`
    // would erase values a hand-edited mcp.json carries.
    apiMock.getMcpServer.mockResolvedValue({
      name: 'vendor',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'vendor'],
      cwd: './srv',
      env: { VENDOR_MODE: 'ci' },
      literalHeaders: {},
      authHeaders: {},
      variables: [],
      local: true,
      canWrite: true,
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.putMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMock.putMcpServer.mock.calls[0]![1]).toMatchObject({
      command: 'npx',
      args: ['-y', 'vendor'],
      cwd: './srv',
      env: { VENDOR_MODE: 'ci' },
    });
  });

  it('interrupts a rename with the disconnect count, and saves only on "Rename anyway"', async () => {
    apiMock.getMcpServer.mockResolvedValue(VIEW);
    renderSection(2);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), {
      target: { value: 'vendor_eu' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The save did NOT fire — the dialog is the gate, and it says the cost.
    expect(apiMock.putMcpServer).not.toHaveBeenCalled();
    expect(await screen.findByText(/at least 2 are configured from your view alone/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rename anyway' }));
    await waitFor(() => expect(apiMock.putMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMock.putMcpServer.mock.calls[0]![1]).toMatchObject({ newName: 'vendor_eu' });
  });

  it('shows everything the two files store: headers, variables, and a declared sign-in', async () => {
    // What mcp.json + plugin.json say is what the reader sees — no opening
    // either file to learn what is configured.
    apiMock.getMcpServer.mockResolvedValue({
      ...VIEW,
      canWrite: false,
      description: 'Vendor CRM',
      variables: [
        { name: 'VENDOR_KEY', scope: 'user' },
        {
          name: 'SIGNIN',
          scope: 'user',
          label: 'Vendor sign-in',
          oauth: { clientId: 'app-1', scopes: ['crm.read'], pkce: false },
        },
      ],
    });
    renderSection();
    expect(await screen.findByText('X-V: 2')).toBeInTheDocument();
    expect(screen.getByText('Authorization: Bearer ${VENDOR_KEY}')).toBeInTheDocument();
    expect(screen.getByText('Vendor CRM')).toBeInTheDocument();
    expect(screen.getByText('${SIGNIN}')).toBeInTheDocument();
    expect(screen.getByText('app-1')).toBeInTheDocument();
    expect(screen.getByText('Endpoints: discovered from the server')).toBeInTheDocument();
    expect(screen.getByText('Scopes: crm.read')).toBeInTheDocument();
    expect(screen.getByText('PKCE: off')).toBeInTheDocument();
  });

  it('declares a sign-in on a user variable: client id only, endpoints discovered, header pre-filled', async () => {
    apiMock.getMcpServer.mockResolvedValue({
      ...VIEW,
      authHeaders: {},
      variables: [{ name: 'HUBSPOT_TOKEN', scope: 'user' }],
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Variable 1 OAuth sign-in' }));
    // The header the token needs appears where the writer can see and change it.
    expect(screen.getByRole('textbox', { name: /Auth headers/ })).toHaveValue(
      'Authorization: Bearer ${HUBSPOT_TOKEN}',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable 1 client id' }), {
      target: { value: ' app-1 ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable 1 scopes' }), {
      target: { value: 'crm.read crm.write' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.putMcpServer).toHaveBeenCalledTimes(1));
    const write = apiMock.putMcpServer.mock.calls[0]![1];
    expect(write).toMatchObject({
      authHeaders: { Authorization: 'Bearer ${HUBSPOT_TOKEN}' },
      variables: [
        { name: 'HUBSPOT_TOKEN', scope: 'user', oauth: { clientId: 'app-1', scopes: ['crm.read', 'crm.write'] } },
      ],
    });
    // Exactly what the file will store: no endpoints (discovered), no
    // `pkce` (on is the default — only an opt-out is written).
    expect(write.variables[0].oauth).not.toHaveProperty('authorizationUrl');
    expect(write.variables[0].oauth).not.toHaveProperty('pkce');
  });

  it('sends hand-entered endpoints and the PKCE opt-out exactly as the file will store them', async () => {
    apiMock.getMcpServer.mockResolvedValue({
      ...VIEW,
      variables: [{ name: 'SIGNIN', scope: 'user', oauth: { clientId: 'app-1' } }],
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit server' }));
    // An Authorization header already exists — nothing is pre-filled over it.
    expect(screen.getByRole('textbox', { name: /Auth headers/ })).toHaveValue('Authorization: Bearer ${VENDOR_KEY}');
    fireEvent.click(screen.getByRole('radio', { name: 'Variable 1 endpoints by hand' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable 1 authorization URL' }), {
      target: { value: 'https://p.example/auth' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable 1 token URL' }), {
      target: { value: 'https://p.example/token' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Variable 1 PKCE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.putMcpServer).toHaveBeenCalledTimes(1));
    expect(apiMock.putMcpServer.mock.calls[0]![1].variables).toEqual([
      {
        name: 'SIGNIN',
        scope: 'user',
        oauth: {
          authorizationUrl: 'https://p.example/auth',
          tokenUrl: 'https://p.example/token',
          clientId: 'app-1',
          pkce: false,
        },
      },
    ]);
  });
});
