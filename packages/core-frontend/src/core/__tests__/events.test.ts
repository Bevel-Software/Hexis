import { describe, it, expect, vi, afterEach } from 'vitest';
import { PR_STALE_COALESCE_MS, PR_STALE_EVENT, subscribePrStale } from '../events';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * One user action can raise the stale event more than once — the tab that
 * applied a request announces it, and the bus binder announces the server's
 * broadcast of the same merge a moment later. A listener acts once per burst.
 */
describe('subscribePrStale', () => {
  it('runs the handler once for a burst of stale events, after the window', () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const off = subscribePrStale(handler);
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PR_STALE_COALESCE_MS);
    expect(handler).toHaveBeenCalledTimes(1);
    // A later event, past the window, is its own run.
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    vi.advanceTimersByTime(PR_STALE_COALESCE_MS);
    expect(handler).toHaveBeenCalledTimes(2);
    off();
  });

  it('drops a pending run when unsubscribed, so an unmounted listener never refetches', () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const off = subscribePrStale(handler);
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    off();
    vi.advanceTimersByTime(PR_STALE_COALESCE_MS * 2);
    expect(handler).not.toHaveBeenCalled();
    window.dispatchEvent(new Event(PR_STALE_EVENT));
    vi.advanceTimersByTime(PR_STALE_COALESCE_MS * 2);
    expect(handler).not.toHaveBeenCalled();
  });
});
