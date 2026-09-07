import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { JoinRequest } from '../services/plugins.api';
import { LibraryToastProvider } from '../state/toast';
import { useJoinRequests, type JoinRequestsApi } from '../hooks/useJoinRequests';

/**
 * Requests belong to the plugin they were fetched for. A page that moves
 * from one skill to the next without unmounting must show nothing of the
 * previous one while the next one's answer is on its way: a banner still
 * listing A's requests over B's folder would grant A's proposal to B.
 */
const request = (number: number): JoinRequest => ({
  number,
  branch: `ali/join-${number}`,
  requesterName: 'Ali',
  createdAt: '2026-01-01T00:00:00.000Z',
  proposals: [],
});

const wrapper = ({ children }: { children: ReactNode }) => <LibraryToastProvider>{children}</LibraryToastProvider>;

describe('useJoinRequests', () => {
  it('shows only the requests of the plugin it is asked about, never a previous one\'s', async () => {
    let releaseB: (rows: JoinRequest[]) => void = () => {};
    const api: JoinRequestsApi = {
      list: vi.fn((name: string) =>
        name === 'A' ? Promise.resolve([request(1)]) : new Promise<JoinRequest[]>((resolve) => (releaseB = resolve)),
      ),
      reconcile: vi.fn().mockResolvedValue(false),
    };
    const { result, rerender } = renderHook(({ plugin }) => useJoinRequests(plugin, `Skills/${plugin}`, api), {
      wrapper,
      initialProps: { plugin: 'A' },
    });
    await waitFor(() => expect(result.current.requests.map((r) => r.number)).toEqual([1]));

    rerender({ plugin: 'B' });
    // B's answer has not arrived: nothing, not A's rows.
    expect(result.current.requests).toEqual([]);

    releaseB([request(2)]);
    await waitFor(() => expect(result.current.requests.map((r) => r.number)).toEqual([2]));
  });
});
