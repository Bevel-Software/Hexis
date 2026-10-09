import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * The one connection probe both setup screens read: which answer is the
 * answer on screen when requests overlap or the answers change under one.
 * Only the request is mocked; the ordering is the hook's own.
 */
const api = vi.hoisted(() => ({ testConnection: vi.fn() }));
vi.mock('../services/setup.api', () => api);

import { ConnectionProbeFailed, useConnectionProbe } from '../hooks/useConnectionProbe';
import type { ConnectionTest } from '../services/setup.api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const YES = { ok: true, branches: ['main'] } as ConnectionTest;
const NO = { ok: false, error: 'The host said no.' } as ConnectionTest;
const ANSWERS = { kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 't' };

type Asked = ReturnType<ReturnType<typeof useConnectionProbe>['ask']>;

describe('useConnectionProbe', () => {
  // A queued answer a failed test never consumed must not feed the next one.
  beforeEach(() => api.testConnection.mockReset());

  it("shows the newest request's answer when two for the same answers land newest-first", async () => {
    const first = deferred<ConnectionTest>();
    const second = deferred<ConnectionTest>();
    api.testConnection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useConnectionProbe());

    let older!: Asked;
    let newer!: Asked;
    act(() => {
      older = result.current.ask(ANSWERS);
      newer = result.current.ask(ANSWERS);
    });
    expect(result.current.testing).toBe(true);

    await act(async () => {
      second.resolve(YES);
      await newer;
    });
    expect(result.current.result).toEqual(YES);
    expect(result.current.proven).toBe(true);

    // The older request lands last, with a refusal: stale, so it neither
    // replaces the yes on screen nor counts as proof against it.
    await act(async () => {
      first.resolve(NO);
      await expect(older).resolves.toEqual({ result: NO, stale: true });
    });
    expect(result.current.result).toEqual(YES);
    expect(result.current.proven).toBe(true);
    expect(result.current.testing).toBe(false);
  });

  it('an older request that fails after a newer one answered is a stale failure, and the answer stands', async () => {
    const first = deferred<ConnectionTest>();
    const second = deferred<ConnectionTest>();
    api.testConnection.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useConnectionProbe());

    let older!: Asked;
    let newer!: Asked;
    act(() => {
      older = result.current.ask(ANSWERS);
      newer = result.current.ask(ANSWERS);
    });
    await act(async () => {
      second.resolve(YES);
      await newer;
    });

    await act(async () => {
      first.reject(new Error('network down'));
      await expect(older).rejects.toMatchObject({ name: 'ConnectionProbeFailed', message: 'network down', stale: true });
    });
    await expect(older).rejects.toBeInstanceOf(ConnectionProbeFailed);
    expect(result.current.result).toEqual(YES);
    expect(result.current.testing).toBe(false);
  });

  it('an edit while a request is out makes its answer stale and leaves nothing on screen', async () => {
    const only = deferred<ConnectionTest>();
    api.testConnection.mockReturnValueOnce(only.promise);
    const { result } = renderHook(() => useConnectionProbe());

    let asked!: Asked;
    act(() => {
      asked = result.current.ask(ANSWERS);
    });
    act(() => result.current.invalidate());

    await act(async () => {
      only.resolve(YES);
      await expect(asked).resolves.toEqual({ result: YES, stale: true });
    });
    expect(result.current.result).toBeNull();
    expect(result.current.proven).toBe(false);
    expect(result.current.testing).toBe(false);
  });

  it('a lone request that answers in order is the answer on screen', async () => {
    api.testConnection.mockResolvedValueOnce(YES);
    const { result } = renderHook(() => useConnectionProbe());
    await act(async () => {
      await expect(result.current.ask(ANSWERS)).resolves.toEqual({ result: YES, stale: false });
    });
    expect(result.current.result).toEqual(YES);
    expect(result.current.proven).toBe(true);
    expect(api.testConnection).toHaveBeenLastCalledWith(ANSWERS);
  });
});
