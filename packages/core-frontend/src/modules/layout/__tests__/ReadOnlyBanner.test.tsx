import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { authFetch } from '../../../lib/api';
import { ReadOnlyBanner } from '../components/ReadOnlyBanner';

/**
 * The read-only banner, driven through what the app really does: requests
 * made with `authFetch` against a server that answers. Only `fetch` is
 * replaced, so the path from a refused save to the banner is the real one.
 */
const READ_ONLY = 'This workspace has 5 people switched on and room for 3.';

/** What the server would answer right now. */
let writable = true;
/** Every request for the state, so a test can count the asking. */
let asked = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  writable = true;
  asked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/write-access') {
        asked += 1;
        return json(200, writable ? { writable: true } : { writable: false, message: READ_ONLY });
      }
      // The account routes stay open while the deployment is read-only.
      if (url.startsWith('/api/admin/accounts')) return json(200, {});
      if ((init?.method ?? 'GET') === 'GET') return json(200, {});
      return writable ? json(200, {}) : json(403, { error: READ_ONLY, code: 'workspace_read_only' });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ReadOnlyBanner', () => {
  it('says so, in the host’s words, on a deployment that is read-only when the app opens', async () => {
    writable = false;
    render(<ReadOnlyBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent(READ_ONLY);
  });

  it('shows nothing on a writable deployment, and asks once, however long the tab stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(asked).toBe(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('learns the deployment went read-only from the first change that is refused', async () => {
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();

    writable = false;
    const refused = await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    // The caller still has the answer to itself.
    expect(await refused.json()).toMatchObject({ code: 'workspace_read_only' });
    expect(await screen.findByRole('status')).toHaveTextContent(READ_ONLY);
  });

  it('is not moved by a refusal that is about something else', async () => {
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));
    vi.mocked(fetch).mockResolvedValueOnce(json(403, { error: 'You cannot edit this file.' }));
    await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toBe(1);
  });

  it('goes away once an admin’s change ends the state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writable = false;
    render(<ReadOnlyBanner />);
    await screen.findByRole('status');
    // Some while later, so the check is made at once and not spaced.
    await vi.advanceTimersByTimeAsync(30_000);

    // The admin switches an account off: the request succeeds, and the count is back under the plan.
    writable = true;
    await authFetch('/api/admin/accounts/u1/deactivate', { method: 'POST' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(asked).toBe(2);
  });

  it('does not ask again over changes that go through while nothing is wrong', async () => {
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));
    await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toBe(1);
  });

  it('asks again when the tab comes back into view, at most once a minute, and never as it leaves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const turn = (to: DocumentVisibilityState) => {
      visibility = to;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      render(<ReadOnlyBanner />);
      await waitFor(() => expect(asked).toBe(1));

      // Back into view too soon after the last check.
      turn('hidden');
      turn('visible');
      expect(asked).toBe(1);

      await vi.advanceTimersByTimeAsync(61_000);
      writable = false;
      // Leaving the tab asks nothing, however long it has been.
      turn('hidden');
      expect(asked).toBe(1);
      turn('visible');
      expect(await screen.findByRole('status')).toHaveTextContent(READ_ONLY);
      expect(asked).toBe(2);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  /**
   * A permission lookup or a heartbeat is a POST that goes through, and the
   * app makes them all the time. They must not turn into a check each.
   */
  it('spaces the checks that requests going through set off, without losing the last one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writable = false;
    render(<ReadOnlyBanner />);
    await screen.findByRole('status');
    expect(asked).toBe(1);

    for (let i = 0; i < 5; i += 1) await authFetch('/api/admin/accounts/lookup', { method: 'POST' });
    expect(asked).toBe(1);

    // The change that ends the state arrives inside the spacing, and is still asked about.
    writable = true;
    await authFetch('/api/admin/accounts/u1/deactivate', { method: 'POST' });
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(asked).toBe(2);
  });
});
