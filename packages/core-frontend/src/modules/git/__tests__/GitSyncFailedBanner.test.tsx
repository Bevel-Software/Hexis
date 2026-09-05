import { describe, it, expect, vi } from 'vitest';
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

// The conflict rendering opens files through the file-navigation hook, which
// needs a router and the git context. Neither belongs in this suite: the
// banner's contract is what it says and which paths it offers, so the hook
// is replaced with a recorder.
const { openWorkspacePath } = vi.hoisted(() => ({ openWorkspacePath: vi.fn() }));
vi.mock('../../workspace/routing/kb-routes', () => ({
  useFileNav: () => ({ openFile: vi.fn(), openWorkspacePath }),
}));

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
  const view = render(
    <EventBusContext.Provider value={bus.ctx}>
      <WorkspaceContext.Provider value={makeWorkspaceFixture(workspace)}>
        <GitSyncFailedBanner />
      </WorkspaceContext.Provider>
    </EventBusContext.Provider>,
  );
  const rerender = (next: Partial<WorkspaceContextValue>) =>
    view.rerender(
      <EventBusContext.Provider value={bus.ctx}>
        <WorkspaceContext.Provider value={makeWorkspaceFixture(next)}>
          <GitSyncFailedBanner />
        </WorkspaceContext.Provider>
      </EventBusContext.Provider>,
    );
  return { ...bus, rerender };
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

  it('matches a slashed feature branch across the encode/decode split', () => {
    // Local `workspace.id` is URL-encoded; the SSE event id is URL-decoded.
    // A raw `===` drops every event on a `<user>/<branch>` workspace — which
    // is every feature branch — so the banner would never show, silently
    // recreating the invisible-failure bug this whole feature fixes.
    const bus = renderBanner({ workspaceId: 'razvan-radulescu%2Ffeat' });
    bus.emit({
      kind: 'git-sync-failed',
      workspaceId: 'razvan-radulescu/feat', // decoded, as the backend emits it
      branch: 'razvan-radulescu/feat',
      reason: 'git push failed: fatal: Authentication failed',
    });
    expect(screen.getByRole('alert').textContent).toContain('Authentication failed');

    bus.emit({
      kind: 'git-sync-recovered',
      workspaceId: 'razvan-radulescu/feat',
      branch: 'razvan-radulescu/feat',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps each branch’s failure separately — returning to a broken branch still shows it', () => {
    // A single retained record let branch B's failure overwrite branch A's;
    // switching back to A then showed nothing despite A being unresolved.
    const bus = renderBanner({ workspaceId: 'ws-1' });
    bus.emit(FAILED); // ws-1 fails

    act(() => bus.rerender({ workspaceId: 'ws-2' }));
    bus.emit({ ...FAILED, workspaceId: 'ws-2', branch: 'feat/y', reason: 'ws-2 broke too' });
    expect(screen.getByRole('alert').textContent).toContain('ws-2 broke too');

    act(() => bus.rerender({ workspaceId: 'ws-1' }));
    expect(screen.getByRole('alert').textContent).toContain('feat/x');

    // ws-1 recovering clears only ws-1's record.
    bus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws-1', branch: 'feat/x' });
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => bus.rerender({ workspaceId: 'ws-2' }));
    expect(screen.getByRole('alert').textContent).toContain('ws-2 broke too');
  });

  it('clears a stale banner when the focused workspace changes', () => {
    // FileViewer is not keyed by workspace, so this component survives a branch
    // switch. A failure from the branch just left must not paint over the new
    // one — and no recovered event would ever arrive for it.
    const bus = renderBanner({ workspaceId: 'ws-1' });
    bus.emit(FAILED);
    expect(screen.queryByRole('alert')).not.toBeNull();

    act(() => bus.rerender({ workspaceId: 'ws-2' }));
    expect(screen.queryByRole('alert')).toBeNull();
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

describe('GitSyncFailedBanner — remote-sync conflict', () => {
  const CONFLICT = {
    kind: 'git-sync-failed',
    workspaceId: 'ws-1',
    branch: 'feat/x',
    reason:
      'feat/x could not be synced: Plugins/x/SKILL.md was changed in Hexis and on the git host. Resolve the conflict on feat/x in Hexis, then sync again.',
    conflictedPaths: ['Plugins/x/SKILL.md', 'Docs/a.md'],
  };

  it('tells the author to reconcile the files, and lists each one', () => {
    const bus = renderBanner();
    bus.emit(CONFLICT);
    const alert = screen.getByRole('alert');
    // This one IS the author's to act on — no "check the server logs".
    expect(alert.textContent).toContain('changed both here and there');
    expect(alert.textContent).not.toContain('server logs');
    expect(screen.getByRole('button', { name: 'Plugins/x/SKILL.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Docs/a.md' })).toBeTruthy();
  });

  it('a file link opens that file in this workspace', () => {
    const bus = renderBanner();
    bus.emit(CONFLICT);
    openWorkspacePath.mockClear();
    act(() => {
      screen.getByRole('button', { name: 'Docs/a.md' }).click();
    });
    expect(openWorkspacePath).toHaveBeenCalledWith('knowledge-base/Docs/a.md');
  });

  it('clears like any other failure once the branch syncs', () => {
    const bus = renderBanner();
    bus.emit(CONFLICT);
    bus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws-1', branch: 'feat/x' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
