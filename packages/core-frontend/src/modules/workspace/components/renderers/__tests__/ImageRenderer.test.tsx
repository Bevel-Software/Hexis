import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';
import {
  EventBusContext,
  type EventBusContextValue,
} from '../../../../workflow/state/event-bus.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { ImageRenderer } from '../ImageRenderer';

beforeEach(() => {
  apiMock.authFetch.mockReset();
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => 'blob:fake-url',
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

/**
 * The whole-file image view (a `.png` opened from the tree) fetches through
 * `authFetch` and paints a blob URL. Pinned so the raw-route URL it asks for
 * cannot drift from the one the backend serves.
 */
describe('ImageRenderer', () => {
  it('fetches the bytes from the raw file route and paints them as a blob URL', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
    render(
      <WorkspaceContext.Provider
        value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
      >
        <ImageRenderer filePath="Knowledge/assets/shot.png" content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>,
    );
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:fake-url');
    expect(apiMock.authFetch).toHaveBeenCalledTimes(1);
    expect(apiMock.authFetch.mock.calls[0][0]).toBe(
      '/api/workspace/ws-1/file/raw?path=Knowledge%2Fassets%2Fshot.png',
    );
  });

  /**
   * A rejected read used to return silently, leaving the pane on "Loading
   * image…" for as long as anyone cared to watch — the shape a 403 on a
   * restricted file takes, and a 404 on a path the workspace's branch does not
   * have (the change-request pane reads someone else's branch).
   */
  it('names a failed read instead of spinning on it forever', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: false, status: 403 });
    render(
      <WorkspaceContext.Provider
        value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
      >
        <ImageRenderer filePath="Knowledge/assets/shot.png" content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load this image (HTTP 403).",
    );
    expect(screen.queryByText('Loading image...')).toBeNull();
  });

  /**
   * A replaced picture reaches an open pane. The markdown pipeline's `<img>`
   * tags already carried the workspace's image revision; the whole-file view
   * was the one image on the page that stayed stale until a reload — including
   * the change-request pane, pointed at a branch its author is still pushing
   * to.
   */
  it('refetches when an image in the workspace changes', async () => {
    const handlers: ((e: WorkflowEvent) => void)[] = [];
    const bus = {
      subscribe: (_kind: string, handler: (e: WorkflowEvent) => void) => {
        handlers.push(handler);
        return () => {};
      },
      setFocus: () => {},
      watchWorkspace: () => () => {},
    } as unknown as EventBusContextValue;

    apiMock.authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
    render(
      <EventBusContext.Provider value={bus}>
        <WorkspaceContext.Provider
          value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
        >
          <ImageRenderer filePath="Knowledge/assets/shot.png" content="" onSave={async () => {}} />
        </WorkspaceContext.Provider>
      </EventBusContext.Provider>,
    );
    await screen.findByRole('img');
    // No `&v=` yet: the URL stays cacheable until something is known to have
    // changed.
    expect(apiMock.authFetch.mock.calls[0][0]).toBe(
      '/api/workspace/ws-1/file/raw?path=Knowledge%2Fassets%2Fshot.png',
    );

    act(() =>
      handlers.forEach((h) =>
        h({
          kind: 'file-changed',
          workspaceId: 'ws-1',
          branch: 'ws-1',
          path: 'Knowledge/assets/shot.png',
        } as unknown as WorkflowEvent),
      ),
    );

    await waitFor(() => expect(apiMock.authFetch).toHaveBeenCalledTimes(2));
    expect(apiMock.authFetch.mock.calls[1][0]).toBe(
      '/api/workspace/ws-1/file/raw?path=Knowledge%2Fassets%2Fshot.png&v=1',
    );
  });

  /** A thrown fetch (offline, aborted connection) is a failure too. */
  it('names a read that threw', async () => {
    apiMock.authFetch.mockRejectedValue(new Error('network down'));
    render(
      <WorkspaceContext.Provider
        value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
      >
        <ImageRenderer filePath="Knowledge/assets/shot.png" content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this image.");
  });
});
