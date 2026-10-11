import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FileLock, WorkflowEvent } from '@bevel-software/platform-shared';

// The lock endpoints are the hook's only side effects; each test decides what
// they answer. The sentences stay real — they are what the person reads.
const api = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  heartbeatLock: vi.fn(async () => ({})),
  checkpointLockedFile: vi.fn(async () => null),
  releaseLock: vi.fn(async (): Promise<void> => {}),
  getLock: vi.fn(async (): Promise<FileLock | null> => null),
}));
vi.mock('../../services/lock.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lock.api')>()),
  ...api,
}));

import { useFileLock } from '../useFileLock';
import { SELF_HOLD_MESSAGE } from '../../services/lock.api';
import { EventBusContext, type EventBusContextValue } from '../../state/event-bus.context';

const ME = 'u-juan';

function lockHeldBy(holderUserId: string, holderName: string, expiresInMs = 60_000): FileLock {
  const now = Date.now();
  return {
    branch: 'main',
    path: 'kb/Knowledge/Foo.md',
    holderUserId,
    holderName,
    acquiredAt: new Date(now).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString(),
  };
}

/** A bus the test can publish `lock-*` events on. */
function makeBus() {
  const handlers = new Map<string, Set<(e: WorkflowEvent) => void>>();
  const bus: EventBusContextValue = {
    subscribe: (kind, handler) => {
      const set = handlers.get(kind) ?? new Set();
      set.add(handler as (e: WorkflowEvent) => void);
      handlers.set(kind, set);
      return () => set.delete(handler as (e: WorkflowEvent) => void);
    },
    setFocus: () => {},
    watchWorkspace: () => () => {},
  };
  const publish = (e: WorkflowEvent) => handlers.get(e.kind)?.forEach((h) => h(e));
  return { bus, publish };
}

function setup(opts: { pending?: string | null; bus?: EventBusContextValue } = {}) {
  const persistToDisk = vi.fn(async () => {});
  const wrapper = opts.bus
    ? ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={opts.bus!}>{children}</EventBusContext.Provider>
    )
    : undefined;
  const hook = renderHook(
    () =>
      useFileLock({
        workspaceId: 'ws',
        branch: 'main',
        path: 'kb/Knowledge/Foo.md',
        currentUserId: ME,
        readPendingContent: () => (opts.pending === undefined ? 'typed since the last autosave' : opts.pending),
        persistToDisk,
      }),
    { wrapper },
  );
  return { ...hook, persistToDisk };
}

async function acquireHeld(result: { current: ReturnType<typeof useFileLock> }) {
  api.acquireLock.mockResolvedValueOnce({ acquired: true, lock: lockHeldBy(ME, 'Juan') });
  await act(async () => { await result.current.acquire(); });
  expect(result.current.holdingLock).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getLock.mockImplementation(async () => null);
  api.releaseLock.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFileLock — closing the tab gives the page back', () => {
  it('releases at once on pagehide, keep-alive, without saving unsaved text', async () => {
    const { result, persistToDisk } = setup();
    await acquireHeld(result);

    await act(async () => { window.dispatchEvent(new Event('pagehide')); });

    expect(api.releaseLock).toHaveBeenCalledTimes(1);
    expect(api.releaseLock).toHaveBeenCalledWith('ws', 'main', 'kb/Knowledge/Foo.md', undefined, { keepalive: true });
    // Text typed since the last automatic save is not written on close.
    expect(persistToDisk).not.toHaveBeenCalled();
    // A page restored from the back-forward cache must re-acquire on Edit.
    expect(result.current.holdingLock).toBe(false);
  });

  it('does not release a second time when the page then unmounts', async () => {
    const { result, unmount } = setup();
    await acquireHeld(result);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    unmount();
    expect(api.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not release when the tab is switched away or the window minimised', async () => {
    const { result } = setup();
    await acquireHeld(result);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    expect(api.releaseLock).not.toHaveBeenCalled();
    expect(result.current.holdingLock).toBe(true);
  });

  it('sends nothing on pagehide when it does not hold the page', async () => {
    setup();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.releaseLock).not.toHaveBeenCalled();
  });

  it('stops listening once the editor has unmounted', async () => {
    const { result, unmount } = setup({ pending: null });
    await acquireHeld(result);
    unmount();
    // The unmount cleanup releases (in-app navigation, as before) …
    expect(api.releaseLock).toHaveBeenCalledTimes(1);
    expect(api.releaseLock).toHaveBeenLastCalledWith('ws', 'main', 'kb/Knowledge/Foo.md');
    // … and a later pagehide finds no listener left to send another.
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('swallows a release that cannot be delivered; the hold is left to expire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.releaseLock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = setup();
    await acquireHeld(result);
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(api.releaseLock).toHaveBeenCalledTimes(1);
    expect(result.current.holdingLock).toBe(false);
    expect(warn).toHaveBeenCalledWith('[useFileLock] release on pagehide failed:', expect.any(TypeError));
    warn.mockRestore();
  });
});

describe('useFileLock — a hold that is the viewer\'s own', () => {
  it('says the page is open elsewhere and never names the viewer', async () => {
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy(ME, 'Juan') });
    const { result } = setup();

    let outcome: Awaited<ReturnType<typeof result.current.acquire>> | undefined;
    await act(async () => { outcome = await result.current.acquire(); });

    expect(outcome).toEqual({ acquired: false, contended: true, error: SELF_HOLD_MESSAGE });
    expect(SELF_HOLD_MESSAGE).toBe(
      'You have this page open for editing somewhere else, in another tab or through your agent. You can edit it here in a moment.',
    );
    expect(result.current.externalLockIsMine).toBe(true);
    expect(result.current.lockError).toBe(SELF_HOLD_MESSAGE);
    expect(result.current.lockError).not.toMatch(/Juan/);
  });

  it('names someone else as today', async () => {
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy('u-dana', 'Dana') });
    const { result } = setup();
    let outcome: Awaited<ReturnType<typeof result.current.acquire>> | undefined;
    await act(async () => { outcome = await result.current.acquire(); });

    expect(outcome?.error).toBe('Dana is editing this page');
    expect(result.current.externalLockIsMine).toBe(false);
    expect(result.current.externalLock?.holderName).toBe('Dana');
  });
});

describe('useFileLock — the notice clears when the hold ends', () => {
  it('clears on lock-released, so Edit is available without a reload', async () => {
    const { bus, publish } = makeBus();
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy(ME, 'Juan') });
    const { result } = setup({ bus });
    await act(async () => { await result.current.acquire(); });
    expect(result.current.externalLock).not.toBeNull();

    await act(async () => {
      publish({ kind: 'lock-released', workspaceId: 'ws', branch: 'main', path: 'kb/Knowledge/Foo.md' } as WorkflowEvent);
    });

    expect(result.current.externalLock).toBeNull();
    expect(result.current.externalLockIsMine).toBe(false);
    expect(result.current.lockError).toBeNull();
  });

  it('clears at expiry when no release ever arrives (a closed tab whose release was lost)', async () => {
    vi.useFakeTimers();
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy(ME, 'Juan', 20_000) });
    const { result } = setup();
    await act(async () => { await result.current.acquire(); });
    expect(result.current.externalLockIsMine).toBe(true);

    // Before the expiry nobody asks.
    api.getLock.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.getLock).not.toHaveBeenCalled();
    expect(result.current.externalLock).not.toBeNull();

    // Just after it, the server says the page is free.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });
    expect(api.getLock).toHaveBeenCalledTimes(1);
    expect(result.current.externalLock).toBeNull();
    expect(result.current.lockError).toBeNull();
  });

  it('keeps the notice while the holder renews, and clears once the hold lapses', async () => {
    vi.useFakeTimers();
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy('u-dana', 'Dana', 10_000) });
    const { result } = setup();
    await act(async () => { await result.current.acquire(); });

    api.getLock.mockClear();
    api.getLock.mockImplementationOnce(async () => lockHeldBy('u-dana', 'Dana', 30_000));
    await act(async () => { await vi.advanceTimersByTimeAsync(11_500); });
    expect(result.current.externalLock?.holderName).toBe('Dana');
    expect(result.current.lockError).toBe('Dana is editing this page');

    await act(async () => { await vi.advanceTimersByTimeAsync(31_500); });
    expect(api.getLock).toHaveBeenCalledTimes(2);
    expect(result.current.externalLock).toBeNull();
  });

  it('asks again after a network blip rather than giving up', async () => {
    vi.useFakeTimers();
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy(ME, 'Juan', 0) });
    const { result } = setup();
    await act(async () => { await result.current.acquire(); });

    api.getLock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_500); });
    expect(result.current.externalLock).not.toBeNull();

    // The retry waits twice the shortest wait.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.externalLock).toBeNull();
  });

  it('backs off while the server stays unreachable, rather than asking every few seconds', async () => {
    vi.useFakeTimers();
    api.acquireLock.mockResolvedValueOnce({ acquired: false, lock: lockHeldBy(ME, 'Juan', 0) });
    const { result } = setup();
    await act(async () => { await result.current.acquire(); });

    api.getLock.mockClear();
    api.getLock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const askedAfter = async (ms: number) => {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      return api.getLock.mock.calls.length;
    };

    expect(await askedAfter(5_100)).toBe(1); // at the expiry
    expect(await askedAfter(9_800)).toBe(1); // not yet 10 s later
    expect(await askedAfter(300)).toBe(2); // 10 s
    expect(await askedAfter(19_800)).toBe(2);
    expect(await askedAfter(300)).toBe(3); // 20 s
    expect(await askedAfter(40_100)).toBe(4); // 40 s
    expect(await askedAfter(64_800)).toBe(4);
    expect(await askedAfter(300)).toBe(5); // then every 65 s at most
    expect(await askedAfter(65_100)).toBe(6);
    expect(result.current.externalLock).not.toBeNull();

    // Once the server answers again, the notice clears.
    api.getLock.mockImplementation(async () => null);
    expect(await askedAfter(65_100)).toBe(7);
    expect(result.current.externalLock).toBeNull();
  });
});

describe('useFileLock — a live hold of the viewer\'s own is shown on open', () => {
  it('shows the self-hold notice as soon as the page opens, before any Edit', async () => {
    api.getLock.mockImplementation(async () => lockHeldBy(ME, 'Juan'));
    const { result } = setup();
    await act(async () => {});

    expect(result.current.externalLock?.holderUserId).toBe(ME);
    expect(result.current.externalLockIsMine).toBe(true);
    expect(api.acquireLock).not.toHaveBeenCalled();
  });

  it('hides it while this tab\'s own release for the page is still in flight', async () => {
    let finishRelease: () => void = () => {};
    api.releaseLock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRelease = () => resolve(); }));
    const first = setup({ pending: null });
    await acquireHeld(first.result);
    first.unmount();
    expect(api.releaseLock).toHaveBeenCalledTimes(1);

    // The server has not committed the release yet: it still answers "you".
    api.getLock.mockImplementation(async () => lockHeldBy(ME, 'Juan'));
    const second = setup();
    await act(async () => {});
    expect(second.result.current.externalLock).toBeNull();

    // The release lands; asked again, the server says the page is free.
    api.getLock.mockImplementation(async () => null);
    await act(async () => { finishRelease(); });
    expect(api.getLock).toHaveBeenCalledTimes(3); // first editor, second editor, the re-ask
    expect(second.result.current.externalLock).toBeNull();
  });

  it('shows the self-hold notice when that release fails and the hold stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failRelease: () => void = () => {};
    api.releaseLock.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failRelease = () => reject(new TypeError('Failed to fetch'));
    }));
    const first = setup({ pending: null });
    await acquireHeld(first.result);
    first.unmount();

    api.getLock.mockImplementation(async () => lockHeldBy(ME, 'Juan'));
    const second = setup();
    await act(async () => {});
    expect(second.result.current.externalLock).toBeNull();

    // No lock-released will come; the re-ask finds the hold with nothing in
    // flight and says it is the viewer's own, rather than a page that looks free.
    await act(async () => { failRelease(); });
    expect(second.result.current.externalLockIsMine).toBe(true);
    warn.mockRestore();
  });

  it('shows the viewer\'s hold taken in another tab, live', async () => {
    const { bus, publish } = makeBus();
    const { result } = setup({ bus });
    await act(async () => {});
    expect(result.current.externalLock).toBeNull();

    await act(async () => {
      publish({
        kind: 'lock-acquired', workspaceId: 'ws', branch: 'main', path: 'kb/Knowledge/Foo.md',
        holderUserId: ME, holderName: 'Juan',
      } as WorkflowEvent);
    });

    expect(result.current.externalLockIsMine).toBe(true);
  });

  it('ignores the echo of its own acquire that beats the response', async () => {
    const { bus, publish } = makeBus();
    let finishAcquire: () => void = () => {};
    api.acquireLock.mockImplementationOnce(() => new Promise((resolve) => {
      finishAcquire = () => resolve({ acquired: true, lock: lockHeldBy(ME, 'Juan') });
    }));
    const { result } = setup({ bus });
    await act(async () => {});

    let acquiring: Promise<unknown> = Promise.resolve();
    act(() => { acquiring = result.current.acquire(); });
    await act(async () => {
      publish({
        kind: 'lock-acquired', workspaceId: 'ws', branch: 'main', path: 'kb/Knowledge/Foo.md',
        holderUserId: ME, holderName: 'Juan',
      } as WorkflowEvent);
    });
    expect(result.current.externalLock).toBeNull();

    await act(async () => { finishAcquire(); await acquiring; });
    expect(result.current.holdingLock).toBe(true);
    expect(result.current.externalLock).toBeNull();
  });
});
