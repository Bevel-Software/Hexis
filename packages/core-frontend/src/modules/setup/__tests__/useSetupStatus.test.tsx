import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SetupStatus } from '../services/setup.api';

const api = vi.hoisted(() => ({ fetchSetupStatus: vi.fn() }));
vi.mock('../services/setup.api', async () => ({
  ...(await vi.importActual<object>('../services/setup.api')),
  ...api,
}));

import { useSetupStatus } from '../hooks/useSetupStatus';

const status = (complete: boolean): SetupStatus => ({ complete, isAdmin: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.fetchSetupStatus.mockReset();
});

/**
 * The one reading of the setup status the gate and the Deployment page share.
 * What is worth pinning is the policy they share: the latest read wins, and a
 * failed read keeps what was last known.
 */
describe('useSetupStatus', () => {
  it('reads once on mount', async () => {
    api.fetchSetupStatus.mockResolvedValue(status(true));
    const { result } = renderHook(() => useSetupStatus());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.status).toEqual(status(true));
    expect(result.current.failed).toBe(false);
    expect(api.fetchSetupStatus).toHaveBeenCalledTimes(1);
  });

  it('lets only the latest read land, whatever order the answers arrive in', async () => {
    const onMount = deferred<SetupStatus>();
    const later = deferred<SetupStatus>();
    api.fetchSetupStatus.mockReturnValueOnce(onMount.promise).mockReturnValueOnce(later.promise);
    const { result } = renderHook(() => useSetupStatus());

    act(() => result.current.refresh());
    await act(async () => later.resolve(status(true)));
    expect(result.current.status).toEqual(status(true));

    // The earlier read answers last, describing a deployment that has moved on.
    await act(async () => onMount.resolve(status(false)));
    expect(result.current.status).toEqual(status(true));
  });

  it('a failed read keeps the last status and says so; an earlier read failing late does not', async () => {
    api.fetchSetupStatus.mockResolvedValueOnce(status(false));
    const { result } = renderHook(() => useSetupStatus());
    await waitFor(() => expect(result.current.status).toEqual(status(false)));

    api.fetchSetupStatus.mockRejectedValueOnce(new Error('down'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.status).toEqual(status(false));

    const stale = deferred<SetupStatus>();
    api.fetchSetupStatus.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(status(true));
    act(() => result.current.refresh());
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toEqual(status(true)));
    expect(result.current.failed).toBe(false);

    await act(async () => stale.reject(new Error('late')));
    expect(result.current.failed).toBe(false);
    expect(result.current.status).toEqual(status(true));
  });

  it('disabling while a read is out drops its answer; enabling again reads afresh', async () => {
    const pending = deferred<SetupStatus>();
    api.fetchSetupStatus.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(({ enabled }) => useSetupStatus(enabled), {
      initialProps: { enabled: true },
    });

    rerender({ enabled: false });
    await act(async () => pending.resolve(status(true)));
    expect(result.current.status).toBeNull();
    expect(result.current.loaded).toBe(false);

    api.fetchSetupStatus.mockResolvedValueOnce(status(false));
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toEqual(status(false)));
    expect(api.fetchSetupStatus).toHaveBeenCalledTimes(2);
  });

  it('disabled: never reads', () => {
    const { result } = renderHook(() => useSetupStatus(false));
    act(() => result.current.refresh());
    expect(api.fetchSetupStatus).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);
  });
});
