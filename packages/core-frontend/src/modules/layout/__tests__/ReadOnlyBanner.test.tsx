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
    writable = false;
    render(<ReadOnlyBanner />);
    await screen.findByRole('status');

    // The admin switches an account off: the request succeeds, and the count is back under the plan.
    writable = true;
    await authFetch('/api/admin/accounts/u1/deactivate', { method: 'POST' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('does not ask again over changes that go through while nothing is wrong', async () => {
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));
    await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    await authFetch('/api/workspace/w1/file', { method: 'PUT', body: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toBe(1);
  });

  it('asks again when the tab comes back into view, at most once a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ReadOnlyBanner />);
    await waitFor(() => expect(asked).toBe(1));

    document.dispatchEvent(new Event('visibilitychange'));
    expect(asked).toBe(1);

    await vi.advanceTimersByTimeAsync(61_000);
    writable = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByRole('status')).toHaveTextContent(READ_ONLY);
    expect(asked).toBe(2);
  });
});
