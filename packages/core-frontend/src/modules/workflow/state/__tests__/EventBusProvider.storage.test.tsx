import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EventBusProvider, SESSION_ID_KEY } from '../EventBusProvider';

/**
 * `sessionStorage` is best-effort, never load-bearing. It throws outright on
 * ACCESS inside a sandboxed iframe, and on write when the quota is full or the
 * user has blocked site data. This provider wraps the router, so an unguarded
 * call took the whole app down with it: `#root` empty, no error screen, no
 * file page at all. The tab must still render, with an id it made up.
 */
describe('EventBusProvider: sessionStorage that throws', () => {
  const realStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  let warn: ReturnType<typeof vi.spyOn>;

  /** Swap `window.sessionStorage` for something that behaves as described. */
  function useStorage(stub: Pick<Storage, 'getItem' | 'setItem'>) {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: stub });
  }

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No EventSource in this environment: the connection effect is not what's
    // under test, only that the provider renders its children at all.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    if (realStorage) Object.defineProperty(window, 'sessionStorage', realStorage);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the app when READING the session id throws', () => {
    const setItem = vi.fn();
    useStorage({
      getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
      setItem,
    });

    render(
      <EventBusProvider>
        <div>the app</div>
      </EventBusProvider>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
    // It still generated an id and still tried to keep it.
    expect(setItem).toHaveBeenCalledWith(SESSION_ID_KEY, expect.any(String));
    expect(warn).toHaveBeenCalled();
  });

  it('renders the app when PERSISTING the session id throws, on an in-memory id', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    useStorage({ getItem: () => null, setItem });

    render(
      <EventBusProvider>
        <div>the app</div>
      </EventBusProvider>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(setItem).toHaveBeenCalledWith(SESSION_ID_KEY, expect.any(String));
    expect(warn).toHaveBeenCalled();
  });

  it('persists the generated id, and says nothing, when storage works', () => {
    const store = new Map<string, string>();
    useStorage({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });

    render(
      <EventBusProvider>
        <div>the app</div>
      </EventBusProvider>,
    );

    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(store.get(SESSION_ID_KEY)).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });
});
