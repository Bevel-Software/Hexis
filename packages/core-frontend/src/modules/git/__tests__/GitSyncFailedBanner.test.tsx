import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { GitSyncFailedBanner } from '../components/GitSyncFailedBanner';
import {
  EventBusContext,
  type EventBusContextValue,
} from '../../workflow/state/event-bus.context';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';

/**
 * A minimal stand-in for the SSE bus: keeps the handlers the component
 * registers and lets a test push events through them, so these assertions
 * drive the banner exactly the way the real backend does — by event, not by
 * poking state.
 */
function makeBus() {
  // Handlers are stored untyped: the test emits plain event-shaped objects and
  // the component's own subscription types are what's under test, not the bus.
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const ctx = {
    subscribe(kind: string, handler: (e: unknown) => void) {
      const set = handlers.get(kind) ?? new Set<(e: unknown) => void>();
      set.add(handler);
      handlers.set(kind, set);
      return () => set.delete(handler);
    },
  } as unknown as EventBusContextValue;
  return {
    ctx,
    emit(event: { kind: string; workspaceId: string; branch: string; reason?: string }) {
      act(() => {
        for (const h of handlers.get(event.kind) ?? []) h(event);
      });
    },
  };
}

function renderBanner(workspace: Partial<WorkspaceContextValue> = {}) {
  const bus = makeBus();
  render(
    <EventBusContext.Provider value={bus.ctx}>
      <WorkspaceContext.Provider value={makeWorkspaceFixture(workspace)}>
        <GitSyncFailedBanner />
      </WorkspaceContext.Provider>
    </EventBusContext.Provider>,
  );
  return bus;
}

const FAILED = {
  kind: 'git-sync-failed',
  workspaceId: 'ws-1',
  branch: 'feat/x',
  reason: 'git push failed: fatal: Authentication failed',
};

describe('GitSyncFailedBanner', () => {
  it('renders nothing until a failure arrives — the healthy case is invisible', () => {
    renderBanner();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells the author their work is safe and points an admin at the logs', () => {
    const bus = renderBanner();
    bus.emit(FAILED);

    const alert = screen.getByRole('alert');
    // The two things this banner exists to say: the save is not lost, and
    // whoever can act should look at the server logs. Neither is negotiable —
    // an author reading "sync failed" with no reassurance re-types their work.
    expect(alert.textContent).toContain('saved here');
    expect(alert.textContent).toContain('server logs');
    expect(alert.textContent).toContain('feat/x');
  });

  it('shows the sanitised git reason as the detail line', () => {
    const bus = renderBanner();
    bus.emit(FAILED);
    expect(screen.getByRole('alert').textContent).toContain('Authentication failed');
  });

  it('clears when the backend reports the push recovered', () => {
    const bus = renderBanner();
    bus.emit(FAILED);
    expect(screen.queryByRole('alert')).not.toBeNull();

    bus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws-1', branch: 'feat/x' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores events for another workspace', () => {
    // Focus changes race with in-flight events; a failure on the branch the
    // user just left must not paint a banner over the one they are on.
    const bus = renderBanner();
    bus.emit({ ...FAILED, workspaceId: 'ws-2', branch: 'feat/other' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let another workspace recovering clear this one’s banner', () => {
    const bus = renderBanner();
    bus.emit(FAILED);
    bus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws-2', branch: 'feat/other' });
    expect(screen.queryByRole('alert')).not.toBeNull();
  });

  it('stays up across repeated failures, showing the latest reason', () => {
    const bus = renderBanner();
    bus.emit(FAILED);
    bus.emit({ ...FAILED, reason: 'git push failed: could not read Username' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('could not read Username');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
