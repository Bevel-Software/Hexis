import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ManagedConnectorCard } from '../ManagedConnectorCard';
import { managedCardState, type ManagedToolOAuth } from '../../utils/managed-card-state';

/** A managed sign-in row as `/connect/pending` sends it, with the parts under test overridden. */
function row(over: Partial<ManagedToolOAuth> = {}, managedOver: Partial<ManagedToolOAuth['managed']> = {}): ManagedToolOAuth {
  return {
    slug: 'microsoft365',
    varName: 'ACCESS_TOKEN',
    toolName: 'microsoft365',
    key: 'microsoft365_ACCESS_TOKEN',
    label: 'Microsoft 365 sign-in',
    authorized: false,
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
      account: null,
      ownApp: false,
      available: true,
      ...managedOver,
    },
    ...over,
  };
}

describe('the state a managed connector card shows', () => {
  it.each([
    ['ready', row()],
    ['connected', row({ authorized: true })],
    ['needs-reconnect', row({ authorized: true, needsReauth: true })],
    ['unavailable', row({}, { available: false })],
    // A stored token still works while the broker is unreachable: the card
    // says so, and withholds the buttons that would need the broker.
    ['connected', row({ authorized: true }, { available: false })],
    ['owner-only', row({ ownerOnly: true })],
    // What is stored comes before who may change it: a workspace connection
    // an owner made is connected for its readers too, and one that fell
    // under-scoped needs a reconnect whoever has to make it.
    ['connected', row({ authorized: true, ownerOnly: true }, { tokenScope: 'shared' })],
    ['needs-reconnect', row({ authorized: true, needsReauth: true, ownerOnly: true }, { tokenScope: 'shared' })],
    // An owner's own app makes the deployment's own flow apply: no broker needed.
    ['ready', row({}, { available: false, ownApp: true })],
  ] as const)('%s', (expected, o) => {
    expect(managedCardState(o)).toBe(expected);
  });
});

describe('ManagedConnectorCard', () => {
  const renderCard = (
    o: ManagedToolOAuth,
    handlers: Partial<{ onConnect: () => void; onDisconnect: () => void; onOwnApp: (id: string, secret: string) => Promise<void> }> = {},
  ) =>
    render(
      <MemoryRouter>
        <ManagedConnectorCard
          o={o}
          busy={false}
          onConnect={handlers.onConnect ?? vi.fn()}
          onDisconnect={handlers.onDisconnect ?? vi.fn()}
          onOwnApp={handlers.onOwnApp}
        />
      </MemoryRouter>,
    );

  it('offers Connect when nothing is stored, and says what the connector may do', () => {
    const onConnect = vi.fn();
    renderCard(row(), { onConnect });
    expect(screen.getByText('Ready to connect')).toBeInTheDocument();
    expect(screen.getByText('Read your mail.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('shows who is signed in, with Reconnect and Disconnect', () => {
    const onDisconnect = vi.fn();
    renderCard(row({ authorized: true }, { account: 'alice@acme.example' }), { onDisconnect });
    // "Signed in", never "Connected": the page says Connected only after a real call.
    expect(screen.getByText('Signed in as alice@acme.example')).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('says Needs reconnect when the token no longer covers the tool', () => {
    renderCard(row({ authorized: true, needsReauth: true }));
    expect(screen.getByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('offers nothing to press while the deployment has no broker, and names the admin’s job', () => {
    renderCard(row({}, { available: false }));
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
    expect(screen.getByText(/not connected to a connector broker yet/)).toBeInTheDocument();
  });

  it('keeps a stored token usable while the broker is unreachable: Disconnect stays, Reconnect goes', () => {
    renderCard(row({ authorized: true }, { available: false, account: 'alice@acme.example' }));
    expect(screen.getByText('Signed in as alice@acme.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reconnect|Connect/ })).toBeNull();
  });

  it('a workspace connection a reader cannot make is greyed as needing an owner', () => {
    renderCard(row({ ownerOnly: true }, { tokenScope: 'shared' }));
    expect(screen.getByText('Needs an owner')).toBeInTheDocument();
    expect(screen.getByText(/One connection for the whole workspace/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
  });

  it('a workspace connection an owner made reads as signed in to a reader, who gets no control over it', () => {
    renderCard(row({ authorized: true, ownerOnly: true }, { tokenScope: 'shared', account: 'acme.hubspot.com' }));
    expect(screen.getByText('Signed in as acme.hubspot.com')).toBeInTheDocument();
    expect(screen.queryByText('Needs an owner')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(?:Connect|Reconnect|Disconnect)$/ })).toBeNull();
  });

  it('an owner can bring the deployment’s own app: the form sends the client id and the secret', async () => {
    const onOwnApp = vi.fn(async () => undefined);
    renderCard(row({ canWrite: true }), { onOwnApp });
    fireEvent.click(screen.getByRole('button', { name: 'Use our own app instead' }));
    fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'own-client' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'own-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onOwnApp).toHaveBeenCalledWith('own-client', 'own-secret'));
    // The form closes once the save settled.
    await waitFor(() => expect(screen.queryByLabelText('Client id')).toBeNull());
  });

  it('a workspace connection with an own app pinned says so, not that a broker is missing', () => {
    renderCard(row({ canWrite: true }, { tokenScope: 'shared', ownApp: true, available: true }));
    expect(screen.getByText(/own app pinned, which it cannot use/)).toBeInTheDocument();
    expect(screen.queryByText(/not connected to a connector broker/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^(?:Connect|Reconnect)$/ })).toBeNull();
  });

  describe('include/skip, as every sign-in row carries it', () => {
    it('shows the toggle only when the page offers one, and reports a click', () => {
      renderCard(row());
      expect(screen.queryByRole('checkbox')).toBeNull();
      cleanup();
      const onToggle = vi.fn();
      render(
        <MemoryRouter>
          <ManagedConnectorCard o={row({ authorized: true })} busy={false} onConnect={vi.fn()} onDisconnect={vi.fn()} on onToggle={onToggle} />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('checkbox', { name: /Skip this tool/ }));
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    });

    it('a skipped card is greyed, says so, and offers Include and nothing else', () => {
      const onToggle = vi.fn();
      render(
        <MemoryRouter>
          <ManagedConnectorCard o={row({ authorized: true })} busy={false} onConnect={vi.fn()} onDisconnect={vi.fn()} on={false} onToggle={onToggle} />
        </MemoryRouter>,
      );
      expect(screen.getByText('Skipped')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^(?:Connect|Reconnect|Disconnect)$/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Include' }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });
});
