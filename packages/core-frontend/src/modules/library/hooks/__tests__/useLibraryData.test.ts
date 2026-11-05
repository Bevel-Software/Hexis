import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  listPendingSkills: vi.fn(),
  listToolSecrets: vi.fn(),
  listPendingTools: vi.fn(),
  fetchFileAccessBatch: vi.fn(),
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
}));
vi.mock('../../services/library.api', () => ({
  defaultWorkspaceId: () => 'main',
  listSkills: api.listSkills,
  getSkill: api.getSkill,
  listPendingSkills: api.listPendingSkills,
}));
vi.mock('../../../secrets-vault/services/tool-secrets.api', () => ({ listToolSecrets: api.listToolSecrets }));
vi.mock('../../services/tools.api', () => ({ listPendingTools: api.listPendingTools }));
vi.mock('../../../access/api', () => ({ fetchFileAccessBatch: api.fetchFileAccessBatch }));
vi.mock('../../../change-requests/services/change-requests.api', () => ({
  listOpenChangeRequests: api.listOpenChangeRequests,
  listMyChangeRequests: api.listMyChangeRequests,
}));

import { useLibraryData } from '../useLibraryData';

const SKILL = { name: 'deploy', description: '', path: 'Skills/Eng/deploy' };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listSkills.mockResolvedValue([SKILL]);
  api.getSkill.mockResolvedValue({ allowedTools: [] });
  api.listPendingSkills.mockResolvedValue([]);
  api.listToolSecrets.mockResolvedValue([]);
  api.listPendingTools.mockResolvedValue([]);
  api.fetchFileAccessBatch.mockResolvedValue({ results: {} });
  api.listOpenChangeRequests.mockResolvedValue([]);
  api.listMyChangeRequests.mockResolvedValue([]);
});

/**
 * The library is re-read after every access edit, credential save and
 * change-request event, and a load is many round trips. Only the FIRST load
 * is loud; a reload keeps what is on screen until the new answer lands —
 * closing a Manage access dialog that changed nothing used to blank the page
 * to "Loading the library…" for as long as the re-read took.
 */
describe('useLibraryData', () => {
  it('the first load is loud, a reload is quiet: the catalog stays until the new answer lands', async () => {
    const { result } = renderHook(() => useLibraryData());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.skills).toEqual([SKILL]);

    // The reload's answer is held back.
    let answer!: (skills: typeof SKILL[]) => void;
    api.listSkills.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => result.current.reload());
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.skills).toEqual([SKILL]);

    await act(async () => answer([]));
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.skills).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('a retry after a FAILED first load is loud again: there is nothing on screen to keep', async () => {
    api.listSkills.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.loading).toBe(false);
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.skills).toEqual([SKILL]);
  });

  it('a reload that fails keeps the catalog and reports the error, without going loud', async () => {
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    api.listSkills.mockRejectedValueOnce(new Error('network down'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe('network down'));
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.skills).toEqual([SKILL]);
  });
});
