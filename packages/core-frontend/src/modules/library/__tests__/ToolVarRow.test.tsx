import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ToolVarStatus } from '../../secrets-vault/services/tool-secrets.api';

/**
 * The per-variable state matrix, one case per row of the spec table.
 *
 * Two rules are worth more than the rest and get their own cases: the
 * `adminConfigured` overload (on an OAuth variable it describes the OWNER's
 * setup, not a shared value) and the `oauth-auto` suppression (an
 * auto-registered PKCE client has no secret, so offering to save one would
 * clobber the discovered provider).
 */

const secretsMock = vi.hoisted(() => ({
  setAdminVar: vi.fn(),
  setUserVar: vi.fn(),
  deleteAdminVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
}));
vi.mock('../../secrets-vault/services/tool-secrets.api', () => secretsMock);

const connectMock = vi.hoisted(() => ({ startToolOAuth: vi.fn() }));
vi.mock('../../secrets-vault/services/connect.api', () => connectMock);

// External navigation behind a spy-able module — never assign
// window.location.href in a test.
const navMock = vi.hoisted(() => ({ navigateExternal: vi.fn() }));
vi.mock('../utils/navigate-external', () => navMock);

import { ToolVarRow } from '../components/tool-page/ToolVarRow';

const RETURN_TO = '/skills-and-tools/tools/github';

function variable(over: Partial<ToolVarStatus>): ToolVarStatus {
  return {
    name: 'API_KEY',
    scope: 'admin',
    label: null,
    key: 'github_API_KEY',
    adminConfigured: false,
    userConfigured: false,
    ...over,
  };
}

function renderRow(
  v: ToolVarStatus,
  opts: { canWrite?: boolean; setupKind?: 'open' | 'oauth-auto' | 'oauth-manual' | null } = {},
) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  render(
    <ToolVarRow
      slug="github"
      variable={v}
      canWrite={opts.canWrite ?? false}
      setupKind={opts.setupKind ?? null}
      returnTo={RETURN_TO}
      onChanged={onChanged}
      onError={onError}
    />,
  );
  return { onChanged, onError };
}

beforeEach(() => {
  secretsMock.setAdminVar.mockReset().mockResolvedValue(undefined);
  secretsMock.setUserVar.mockReset().mockResolvedValue(undefined);
  secretsMock.deleteAdminVar.mockReset().mockResolvedValue(undefined);
  secretsMock.setOAuthClientSecret.mockReset().mockResolvedValue(undefined);
  connectMock.startToolOAuth.mockReset().mockResolvedValue('https://provider.example/authorize');
  navMock.navigateExternal.mockReset();
});

describe('ToolVarRow — admin scope', () => {
  it('shows the Set by an Admin chip and no controls to a non-writer', () => {
    renderRow(variable({ adminConfigured: true }));
    expect(screen.getByText('Set by an Admin')).toBeInTheDocument();
    expect(screen.getByText('One value for the whole team — already handled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('offers Replace and Remove to a writer, and Remove deletes then reports', async () => {
    const { onChanged } = renderRow(variable({ adminConfigured: true }), { canWrite: true });
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(secretsMock.deleteAdminVar).toHaveBeenCalledWith('github', 'API_KEY'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows the Not set chip to a non-writer when nothing is stored', () => {
    renderRow(variable({}));
    expect(screen.getByText('Not set')).toBeInTheDocument();
    // The "— already handled" tail is dropped when unset: it would contradict
    // the chip right next to it.
    expect(screen.getByText('One value for the whole team')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set key' })).toBeNull();
  });

  it('lets a writer set the key, with Save disabled until a value is typed', async () => {
    const { onChanged } = renderRow(variable({}), { canWrite: true });
    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));

    const input = screen.getByLabelText('Value for API_KEY');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'ghp_secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(secretsMock.setAdminVar).toHaveBeenCalledWith('github', 'API_KEY', 'ghp_secret'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // Editor closes and the typed value goes with it.
    await waitFor(() => expect(screen.queryByLabelText('Value for API_KEY')).toBeNull());
  });

  it('closes the editor on Cancel without saving', () => {
    renderRow(variable({}), { canWrite: true });
    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Value for API_KEY')).toBeNull();
    expect(secretsMock.setAdminVar).not.toHaveBeenCalled();
  });
});

describe('ToolVarRow — user scope, typed value', () => {
  it('shows Connected when the caller has their own value', () => {
    renderRow(variable({ scope: 'user', userConfigured: true }));
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Each person sets their own')).toBeInTheDocument();
  });

  it('offers Add key and saves it to the per-user tier', async () => {
    const { onChanged } = renderRow(variable({ scope: 'user' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }));
    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(secretsMock.setUserVar).toHaveBeenCalledWith('github', 'API_KEY', 'mine'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe('ToolVarRow — oauth', () => {
  const signin = (over: Partial<ToolVarStatus> = {}) =>
    variable({
      name: 'SIGNIN',
      scope: 'user',
      label: 'GitHub sign-in',
      oauth: true,
      adminConfigured: true,
      ...over,
    });

  it('shows Connected once authorized', () => {
    renderRow(signin({ authorized: true }));
    expect(screen.getByText('GitHub sign-in')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('asks for a fresh sign-in when the token is under-scoped', () => {
    renderRow(signin({ authorized: true, needsReauth: true }));
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('starts the flow with a returnTo and sends the browser to the provider', async () => {
    renderRow(signin({ authorized: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(connectMock.startToolOAuth).toHaveBeenCalledWith('github', 'SIGNIN', {
        returnTo: RETURN_TO,
      }),
    );
    await waitFor(() =>
      expect(navMock.navigateExternal).toHaveBeenCalledWith('https://provider.example/authorize'),
    );
  });

  it('tells a non-writer the owner has not finished the setup', () => {
    renderRow(signin({ adminConfigured: false }));
    expect(
      screen.getByText("The tool owner hasn't finished the sign-in setup yet."),
    ).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('lets a writer provide the client secret for a manual provider', async () => {
    const { onChanged } = renderRow(signin({ adminConfigured: false }), {
      canWrite: true,
      setupKind: 'oauth-manual',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set client secret' }));

    const input = screen.getByLabelText('Client secret for SIGNIN');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'cs_live' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(secretsMock.setOAuthClientSecret).toHaveBeenCalledWith('github', 'SIGNIN', 'cs_live'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers a writer Replace client secret alongside Connected', () => {
    renderRow(signin({ authorized: true }), { canWrite: true, setupKind: 'oauth-manual' });
    expect(screen.getByRole('button', { name: 'Replace client secret' })).toBeInTheDocument();
  });

  it('never shows a client-secret affordance for oauth-auto, even to a writer', () => {
    renderRow(signin({ authorized: true }), { canWrite: true, setupKind: 'oauth-auto' });
    expect(screen.queryByRole('button', { name: 'Replace client secret' })).toBeNull();

    renderRow(signin({ adminConfigured: false }), { canWrite: true, setupKind: 'oauth-auto' });
    expect(screen.queryByRole('button', { name: 'Set client secret' })).toBeNull();
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });
});

describe('ToolVarRow — failures', () => {
  it('reports a rejected write through onError and leaves the editor open', async () => {
    secretsMock.setAdminVar.mockRejectedValue(new Error('Forbidden'));
    const { onError, onChanged } = renderRow(variable({}), { canWrite: true });

    fireEvent.click(screen.getByRole('button', { name: 'Set key' }));
    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Forbidden'));
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Value for API_KEY')).toBeInTheDocument();
  });

  it('reports a refused sign-in start and re-enables the button', async () => {
    connectMock.startToolOAuth.mockRejectedValue(
      new Error("This tool's owner hasn't finished setting this up"),
    );
    const { onError } = renderRow(
      variable({ name: 'SIGNIN', scope: 'user', oauth: true, adminConfigured: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("This tool's owner hasn't finished setting this up"),
    );
    expect(navMock.navigateExternal).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
  });
});
