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
});
