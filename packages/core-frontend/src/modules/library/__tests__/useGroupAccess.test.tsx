import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AccessResponse } from '../../access/api';

/**
 * The group-access hook's contract is about which failure means what: the
 * summary IS the section (its failure must be visible), while the overrides
 * scan is a supplement whose 403 is a normal outcome (it must be invisible).
 */

const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  fetchAccessOverrides: vi.fn(),
}));
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, ...api };
});

import { useGroupFolderAccess } from '../hooks/useGroupAccess';
import { DEFAULT_WORKSPACE_ID } from '../services/library.api';

const VIEW = {
  canRead: true,
  canWrite: true,
  canDownload: false,
  canOwner: false,
  eligible: { roles: ['Admin'], users: [] },
  readers: { restricted: true, roles: ['GTM Team'], users: [] },
  owners: { roles: [], users: [] },
  downloaders: { roles: [], users: [] },
  sources: {},
} as AccessResponse;

function Probe({ folder = 'Groups/GTM' }: { folder?: string }) {
  const { access, overrides, truncated, loading, error, reload } = useGroupFolderAccess(folder);
  return (
    <div>
      <div aria-label="loading">{String(loading)}</div>
      <div aria-label="error">{error ?? ''}</div>
      <div aria-label="readers">{access ? access.readers.roles.join(',') : ''}</div>
      <div aria-label="overrides">{overrides.map((o) => o.path).join(',')}</div>
      <div aria-label="truncated">{String(truncated)}</div>
      <button type="button" onClick={reload}>
        Reload
      </button>
    </div>
  );
}

const read = (label: string) => screen.getByLabelText(label).textContent;

describe('useGroupFolderAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the summary and the overrides in parallel, pinned to the default branch', async () => {
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.fetchAccessOverrides.mockResolvedValue({
      overrides: [
        { path: 'Groups/GTM/a/access.md', governs: 'Groups/GTM/a', source: 'access-md', entries: [] },
      ],
      truncated: true,
    });

    render(<Probe />);
    expect(read('loading')).toBe('true');

    await waitFor(() => expect(read('loading')).toBe('false'));
    expect(read('readers')).toBe('GTM Team');
    expect(read('overrides')).toBe('Groups/GTM/a/access.md');
    expect(read('truncated')).toBe('true');
    expect(api.fetchFileAccess).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ID, 'Groups/GTM', 'folder');
    expect(api.fetchAccessOverrides).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ID, 'Groups/GTM');
  });

  it('surfaces a summary failure instead of inventing an answer', async () => {
    api.fetchFileAccess.mockRejectedValue(new Error('boom'));
    api.fetchAccessOverrides.mockResolvedValue({ overrides: [], truncated: false });

    render(<Probe />);

    await waitFor(() => expect(read('error')).toBe('boom'));
    expect(read('readers')).toBe('');
  });

  it('swallows an overrides failure — a 403 there is a normal outcome', async () => {
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.fetchAccessOverrides.mockRejectedValue(new Error('forbidden'));

    render(<Probe />);

    await waitFor(() => expect(read('loading')).toBe('false'));
    expect(read('error')).toBe('');
    expect(read('overrides')).toBe('');
    expect(read('readers')).toBe('GTM Team');
  });

  it('refetches both on reload', async () => {
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.fetchAccessOverrides.mockResolvedValue({ overrides: [], truncated: false });

    render(<Probe />);
    await waitFor(() => expect(read('loading')).toBe('false'));

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(api.fetchFileAccess).toHaveBeenCalledTimes(2));
    expect(api.fetchAccessOverrides).toHaveBeenCalledTimes(2);
  });

  it('re-resolves when the folder changes', async () => {
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.fetchAccessOverrides.mockResolvedValue({ overrides: [], truncated: false });

    const { rerender } = render(<Probe folder="Skills/GTM" />);
    await waitFor(() => expect(read('loading')).toBe('false'));

    rerender(<Probe folder="Tools/GTM" />);

    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ID, 'Tools/GTM', 'folder'),
    );
  });
});
