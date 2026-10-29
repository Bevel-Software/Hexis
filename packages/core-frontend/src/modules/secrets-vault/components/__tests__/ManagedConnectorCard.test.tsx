import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ManagedConnectorCard } from '../ManagedConnectorCard';
import { managedCardState } from '../../utils/managed-card-state';
import type { ConnectToolOAuth } from '../../services/connect.api';

/** A managed sign-in row as `/connect/pending` sends it, with the parts under test overridden. */
function row(over: Partial<ConnectToolOAuth> = {}, managedOver: Partial<NonNullable<ConnectToolOAuth['managed']>> = {}): ConnectToolOAuth {
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
    ['owner-only', row({ ownerOnly: true })],
    // An owner's own app makes the deployment's own flow apply: no broker needed.
    ['ready', row({}, { available: false, ownApp: true })],
  ] as const)('%s', (expected, o) => {
    expect(managedCardState(o)).toBe(expected);
  });
});

describe('ManagedConnectorCard', () => {
  const renderCard = (o: ConnectToolOAuth, handlers: Partial<{ onConnect: () => void; onDisconnect: () => void }> = {}) =>
    render(
      <MemoryRouter>
        <ManagedConnectorCard o={o} busy={false} onConnect={handlers.onConnect ?? vi.fn()} onDisconnect={handlers.onDisconnect ?? vi.fn()} />
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

  it('shows who is connected, with Reconnect and Disconnect', () => {
    const onDisconnect = vi.fn();
    renderCard(row({ authorized: true }, { account: 'alice@acme.example' }), { onDisconnect });
    expect(screen.getByText('Connected as alice@acme.example')).toBeInTheDocument();
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

  it('a workspace connection a reader cannot make is greyed as needing an owner', () => {
    renderCard(row({ ownerOnly: true }, { tokenScope: 'shared' }));
    expect(screen.getByText('Needs an owner')).toBeInTheDocument();
    expect(screen.getByText(/One connection for the whole workspace/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull();
  });
});
