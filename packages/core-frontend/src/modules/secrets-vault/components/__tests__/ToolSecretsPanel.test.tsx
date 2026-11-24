import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ToolSecrets } from '../../services/tool-secrets.api';
import { ToolSecretsPanel } from '../ToolSecretsPanel';

/**
 * The panel is not always remounted when the tool under it changes.
 *
 * `SecretsPage` gives each tool its own list item, so React keys them apart —
 * but the workspace's `.tool` renderer mounts ONE panel and swaps the `tool`
 * prop as the reader opens a different file. A probe's answer that survived
 * that swap would sit beside a variable of the same name on the new tool,
 * saying `Connected` about a provider nobody has called for it: the confident
 * stale claim this whole feature exists to remove, reached sideways.
 *
 * The rule under test lives in `useSavedKeyProbe`, not in the callers — the
 * slug is part of the identity of every answer it holds, so a caller that
 * forgets to key the panel cannot produce the bug.
 */

const api = vi.hoisted(() => ({
  setUserVar: vi.fn(),
  checkToolConnection: vi.fn(),
}));

vi.mock('../../services/tool-secrets.api', () => ({
  setAdminVar: vi.fn(async () => {}),
  setUserVar: api.setUserVar,
  setOAuthClientSecret: vi.fn(async () => {}),
  deleteAdminVar: vi.fn(async () => {}),
  deleteUserVar: vi.fn(async () => {}),
  checkToolConnection: api.checkToolConnection,
}));
vi.mock('../../services/connect.api', () => ({ startToolOAuth: vi.fn(async () => '') }));

/** Two tools that declare the SAME variable name — the case that goes wrong. */
const tool = (slug: string): ToolSecrets => ({
  slug,
  name: slug,
  path: `Plugins/Engineering/${slug}.tool`,
  type: 'http',
  setup: null,
  canWrite: false,
  variables: [
    {
      name: 'API_KEY',
      scope: 'user',
      label: null,
      key: `${slug}_API_KEY`,
      adminConfigured: true,
      adminKind: 'static',
      userConfigured: false,
    },
  ],
});

describe('ToolSecretsPanel: an answer belongs to the tool it was asked about', () => {
  beforeEach(() => {
    api.setUserVar.mockReset().mockResolvedValue(undefined);
    api.checkToolConnection.mockReset();
  });

  it('drops the previous tool’s verdict when the panel is handed a new tool', async () => {
    api.checkToolConnection.mockResolvedValue({
      status: 'ok',
      detail: null,
      checkedAt: new Date().toISOString(),
    });
    const { rerender } = render(<ToolSecretsPanel tool={tool('github')} onChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByTestId('saved-key-probe')).toHaveTextContent('Connected'),
    );

    // The reader opens a different `.tool` file. Same component instance, same
    // variable name, a provider that was never called.
    rerender(<ToolSecretsPanel tool={tool('linear')} onChanged={() => {}} />);

    expect(screen.queryByTestId('saved-key-probe')).toBeNull();
    // And it is not merely hidden for a frame: nothing brings it back.
    await waitFor(() => expect(screen.queryByTestId('saved-key-probe')).toBeNull());
    expect(api.checkToolConnection).toHaveBeenCalledTimes(1);
    expect(api.checkToolConnection).toHaveBeenCalledWith('github');
  });

  it('probes the NEW tool when a key is saved after the swap', async () => {
    api.checkToolConnection.mockResolvedValue({
      status: 'failed',
      detail: 'The provider rejected this credential (401).',
      checkedAt: new Date().toISOString(),
    });
    const { rerender } = render(<ToolSecretsPanel tool={tool('github')} onChanged={() => {}} />);
    rerender(<ToolSecretsPanel tool={tool('linear')} onChanged={() => {}} />);

    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByTestId('saved-key-probe')).toHaveTextContent('Not working'),
    );
    expect(api.setUserVar).toHaveBeenCalledWith('linear', 'API_KEY', 'k');
    expect(api.checkToolConnection).toHaveBeenCalledWith('linear');
  });
});

/**
 * A key or client secret of only whitespace is refused by the server; the
 * panel does not offer it for saving, as the Connect page's key rows do not.
 */
describe('ToolSecretsPanel: a value of only whitespace is not offered for saving', () => {
  beforeEach(() => {
    api.setUserVar.mockReset().mockResolvedValue(undefined);
  });

  it('keeps a key’s Save disabled', () => {
    render(<ToolSecretsPanel tool={tool('github')} onChanged={() => {}} />);
    for (const blank of ['   ', '\t ', '\u00A0\u2003']) {
      fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: blank } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
    expect(api.setUserVar).not.toHaveBeenCalled();
    // A real value is still offered: the button is held by the whitespace, not always.
    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'k' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('keeps a client secret’s Save disabled', () => {
    const signIn: ToolSecrets = {
      ...tool('github'),
      canWrite: true,
      variables: [
        {
          name: 'SIGNIN',
          scope: 'user',
          label: null,
          key: 'github_SIGNIN',
          adminConfigured: false,
          adminKind: null,
          userConfigured: false,
          oauth: true,
          authorized: false,
        },
      ],
    };
    render(<ToolSecretsPanel tool={signIn} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText('Client secret for SIGNIN'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Client secret for SIGNIN'), { target: { value: 'cs' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
