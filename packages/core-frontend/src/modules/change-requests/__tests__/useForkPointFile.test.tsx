import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ readFileAtForkPoint: vi.fn() }));
vi.mock('../services/change-requests.api', () => ({
  readFileAtForkPoint: api.readFileAtForkPoint,
}));

/**
 * The folder named by a denial is a fact about ONE branch's tree: the target
 * the fork point belongs to is the tree the route checks read authority
 * against. So the branch is part of what identifies a read, not merely part
 * of what the effect watches — a key without it makes the hook's own
 * already-asked guard serve the previous branch's answer, and the dialog goes
 * on telling the reader to ask an owner of a folder that governs a different
 * tree.
 */
const denial = vi.hoisted(() => ({ describeReadFailure: vi.fn() }));
vi.mock('../services/denied-file.api', () => ({
  describeReadFailure: denial.describeReadFailure,
}));

import { useForkPointFileRead } from '../hooks/useForkPointFile';

const PATH = 'Knowledge/Finance/Payroll/bands.yaml';

beforeEach(() => {
  api.readFileAtForkPoint.mockReset();
  denial.describeReadFailure
    .mockReset()
    .mockImplementation(async (_err: unknown, branch: string) => ({
      kind: 'denied',
      folder: `${branch}-folder`,
    }));
});

describe('useForkPointFileRead: the branch a read is described against', () => {
  it('re-reads when the target branch moves under the same file and fork point', async () => {
    api.readFileAtForkPoint.mockRejectedValue(Object.assign(new Error('nope'), { status: 403 }));

    const { result, rerender } = renderHook(
      ({ branch }) => useForkPointFileRead(31, 'sha1', PATH, { targetBranch: branch }),
      { initialProps: { branch: 'main' } },
    );

    await waitFor(() =>
      expect(result.current).toEqual({
        content: null,
        failed: true,
        failure: { kind: 'denied', folder: 'main-folder' },
      }),
    );

    rerender({ branch: 'release' });

    await waitFor(() =>
      expect(result.current).toEqual({
        content: null,
        failed: true,
        failure: { kind: 'denied', folder: 'release-folder' },
      }),
    );
    expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(2);
  });

  it('still asks once per branch — a settled read is not re-fetched on every render', async () => {
    api.readFileAtForkPoint.mockResolvedValue({ content: 'bands:\n  - L3\n' });

    const { result, rerender } = renderHook(() =>
      useForkPointFileRead(31, 'sha1', PATH, { targetBranch: 'main' }),
    );
    await waitFor(() => expect(result.current.content).toBe('bands:\n  - L3\n'));

    rerender();
    rerender();

    expect(api.readFileAtForkPoint).toHaveBeenCalledTimes(1);
  });
});
