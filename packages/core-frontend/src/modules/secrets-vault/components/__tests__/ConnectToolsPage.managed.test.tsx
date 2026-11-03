import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectPending, ConnectToolOAuth } from '../../services/connect.api';
import { AppRegistryContext, makeRegistry, type ConnectPanelProps } from '../../../../core/registry';
import { ConnectToolsPage } from '../ConnectToolsPage';
import { TOOL_CREDENTIALS_STALE_EVENT } from '../../../../core/events';

/**
 * The managed-connector half of the Connect page, at the page boundary: the
 * distribution's panel at the foot of the page and what it may ask of the
 * page, and a Disconnect that goes to the row the connection lives on — the
 * caller's for a personal sign-in, the shared one for a workspace connection.
 */

const connectMock = vi.hoisted(() => ({
  getConnectPending: vi.fn(),
  startToolOAuth: vi.fn(),
  getMcpOAuthRequest: vi.fn(),
  completeMcpOAuth: vi.fn(),
}));
vi.mock('../../services/connect.api', () => connectMock);

const varsMock = vi.hoisted(() => ({
  setUserVar: vi.fn(),
  setAdminVar: vi.fn(),
  deleteUserVar: vi.fn(),
  deleteAdminVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
  checkToolConnection: vi.fn(),
}));
vi.mock('../../services/tool-secrets.api', () => varsMock);
vi.mock('../../services/secrets.api', () => ({ startOAuth: vi.fn() }));

/** A managed sign-in row as `/connect/pending` sends it. */
function managedRow(over: Partial<ConnectToolOAuth> = {}, card: Partial<NonNullable<ConnectToolOAuth['managed']>> = {}): ConnectToolOAuth {
  return {
    slug: 'microsoft365',
    varName: 'ACCESS_TOKEN',
    toolName: 'microsoft365',
    key: 'microsoft365_ACCESS_TOKEN',
    label: 'Microsoft 365 sign-in',
    authorized: true,
    needsReauth: false,
    ownerConfigured: true,
    ownerOnly: false,
    canWrite: false,
    managed: {
      connectorId: 'microsoft365',
      scopeSet: 'read',
      tokenScope: 'user',
      displayName: 'Microsoft 365',
      icon: 'Mail',
      description: 'Lets Hexis read your mail.',
      permissions: ['Read your mail.'],
      scopeSetLabel: 'Read',
      dataResidency: 'EU',
      subprocessor: 'Microsoft',
      account: 'alice@acme.example',
      ownApp: false,
      available: true,
      ...card,
    },
    ...over,
  };
}

const workspaceRow = () =>
  managedRow(
    { slug: 'hubspot', varName: 'ACCESS_TOKEN', toolName: 'hubspot', key: 'hubspot_ACCESS_TOKEN', label: 'HubSpot sign-in', canWrite: true },
    { connectorId: 'hubspot', tokenScope: 'shared', displayName: 'HubSpot', account: 'acme.hubspot.com' },
  );

const listing = (...toolOAuth: ConnectToolOAuth[]): ConnectPending => ({ tools: [], oauth: [], toolOAuth });

const heard = vi.fn();

function renderPage(panel?: React.ComponentType<ConnectPanelProps>) {
  const page = (
    <MemoryRouter>
      <ConnectToolsPage />
    </MemoryRouter>
  );
  return render(panel ? <AppRegistryContext.Provider value={makeRegistry({ connectPanel: panel })}>{page}</AppRegistryContext.Provider> : page);
}

/** The connector's card, once the list that carries it has landed. */
const card = async (connectorId: string) => within(await screen.findByTestId(`connector-${connectorId}`));

beforeEach(() => {
  window.history.replaceState(null, '', '/skills-and-tools/connect');
  sessionStorage.clear();
  heard.mockReset();
  connectMock.getConnectPending.mockReset().mockResolvedValue(listing());
  connectMock.getMcpOAuthRequest.mockReset();
  varsMock.deleteUserVar.mockReset().mockResolvedValue(undefined);
  varsMock.deleteAdminVar.mockReset().mockResolvedValue(undefined);
  varsMock.checkToolConnection.mockReset();
  window.addEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard);
});
afterEach(() => window.removeEventListener(TOOL_CREDENTIALS_STALE_EVENT, heard));

describe('ConnectToolsPage: the distribution’s panel at the foot of the page', () => {
  function Panel({ onChanged }: ConnectPanelProps) {
    return <button onClick={onChanged}>Enable HubSpot</button>;
  }

  it('renders the registered panel once the list has loaded, and for a reader with nothing else to set up', async () => {
    let answer!: (p: ConnectPending) => void;
    connectMock.getConnectPending.mockReturnValue(new Promise<ConnectPending>((resolve) => (answer = resolve)));
    renderPage(Panel);
    // Not while the page still says "Loading…": the panel lands with the lists.
    expect(screen.queryByRole('button', { name: 'Enable HubSpot' })).toBeNull();
    answer(listing());
    expect(await screen.findByRole('button', { name: 'Enable HubSpot' })).toBeInTheDocument();
  });

  it('renders no panel when none is registered', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Connect your tools' });
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Enable HubSpot' })).toBeNull();
  });

  it('a change the panel reports is announced and the list fetched again, quietly', async () => {
    renderPage(Panel);
    const enable = await screen.findByRole('button', { name: 'Enable HubSpot' });
    await waitFor(() => expect(connectMock.getConnectPending).toHaveBeenCalledTimes(1));
    // The next listing (what the panel enabled) is held open, so the page's
    // state WHILE it refetches is observable, not only the state after.
    let answer!: (p: ConnectPending) => void;
    connectMock.getConnectPending.mockReturnValue(new Promise<ConnectPending>((resolve) => (answer = resolve)));
    fireEvent.click(enable);
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(connectMock.getConnectPending).toHaveBeenCalledTimes(2));
    // Quietly: mid-refetch the page has not dropped to "Loading…", and the
    // panel that asked is still mounted.
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Enable HubSpot' })).toBeInTheDocument();
    answer(listing(workspaceRow()));
    expect(await screen.findByTestId('connector-hubspot')).toBeInTheDocument();
  });
});

describe('ConnectToolsPage: disconnecting a managed sign-in', () => {
  it('a personal sign-in is removed from the caller’s row, announced, and the list fetched again', async () => {
    let answer!: (p: ConnectPending) => void;
    connectMock.getConnectPending
      .mockResolvedValueOnce(listing(managedRow()))
      .mockReturnValue(new Promise<ConnectPending>((resolve) => (answer = resolve)));
    renderPage();
    fireEvent.click((await card('microsoft365')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(varsMock.deleteUserVar).toHaveBeenCalledWith('microsoft365', 'ACCESS_TOKEN'));
    expect(varsMock.deleteAdminVar).not.toHaveBeenCalled();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(connectMock.getConnectPending).toHaveBeenCalledTimes(2));
    // Quietly: mid-refetch the card is still on the page and nothing says "Loading…".
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByTestId('connector-microsoft365')).toBeInTheDocument();
    answer(listing(managedRow({ authorized: false }, { account: null })));
    // The refetched row: nothing stored any more.
    expect(await (await card('microsoft365')).findByText('Ready to connect')).toBeInTheDocument();
  });

  it('a workspace connection is removed from the shared row, by a writer, and the list fetched again', async () => {
    connectMock.getConnectPending
      .mockResolvedValueOnce(listing(workspaceRow()))
      .mockResolvedValue(listing({ ...workspaceRow(), authorized: false, managed: { ...workspaceRow().managed!, account: null } }));
    renderPage();
    fireEvent.click((await card('hubspot')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(varsMock.deleteAdminVar).toHaveBeenCalledWith('hubspot', 'ACCESS_TOKEN'));
    expect(varsMock.deleteUserVar).not.toHaveBeenCalled();
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(connectMock.getConnectPending).toHaveBeenCalledTimes(2));
    expect(await (await card('hubspot')).findByText('Ready to connect')).toBeInTheDocument();
  });

  it('a disconnect the server refuses is shown, announces nothing, and leaves the card usable', async () => {
    connectMock.getConnectPending.mockResolvedValue(listing(managedRow()));
    varsMock.deleteUserVar.mockRejectedValue(new Error('Nope.'));
    renderPage();
    const disconnect = (await card('microsoft365')).getByRole('button', { name: 'Disconnect' });
    fireEvent.click(disconnect);
    expect(await screen.findByText('Nope.')).toBeInTheDocument();
    expect(heard).not.toHaveBeenCalled();
    expect(connectMock.getConnectPending).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(disconnect).toBeEnabled());
  });
});
