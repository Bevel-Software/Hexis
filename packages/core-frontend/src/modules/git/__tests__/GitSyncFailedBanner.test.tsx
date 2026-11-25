import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { GitSyncFailedBanner } from '../components/GitSyncFailedBanner';
import { EventBusProvider } from '../../version-control';
import { WorkspaceContext, type WorkspaceContextValue } from '../../workspace';

// The conflict rendering opens files through the file-navigation hook, which
// needs a router and the git context. Neither belongs in this suite: the
// banner's contract is what it says and which paths it offers, so the hook
// the workspace module offers is replaced with a recorder; everything else
// the module offers stays its own.
const { openWorkspacePath } = vi.hoisted(() => ({ openWorkspacePath: vi.fn() }));
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useFileNav: () => ({ openFile: vi.fn(), openWorkspacePath }),
}));

/**
 * The server's event stream, as the browser offers it. jsdom ships no
 * EventSource; this one keeps the listeners the real `EventBusProvider`
 * registers and lets a test send an event down the stream, so the banner is
 * driven the way the backend drives it: by a message on the wire, through
 * the provider the app mounts.
 */
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  private readonly listeners = new Map<string, ((e: Event) => void)[]>();
  constructor() {
    FakeEventSource.latest = this;
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {}
  send(event: unknown) {
    const message = new MessageEvent('message', { data: JSON.stringify(event) });
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn(message);
  }
}

beforeEach(() => {
  FakeEventSource.latest = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

/** Sends one event down the stream the mounted provider opened. */
function emit(event: {
  kind: string;
  workspaceId: string;
  branch: string;
  reason?: string;
  conflictedPaths?: string[];
  accessRefusal?: { path?: string };
}) {
  act(() => {
    FakeEventSource.latest?.send(event);
  });
}

/** The workspace the banner stands in: what it reads of it, and nothing else. */
function workspaceValue(overrides: Partial<WorkspaceContextValue> = {}): WorkspaceContextValue {
  return { workspaceId: 'ws-1', kbDirName: 'knowledge-base', ...overrides } as WorkspaceContextValue;
}

function renderBanner(workspace: Partial<WorkspaceContextValue> = {}) {
  const tree = (value: Partial<WorkspaceContextValue>) => (
    <EventBusProvider>
      <WorkspaceContext.Provider value={workspaceValue(value)}>
        <GitSyncFailedBanner />
      </WorkspaceContext.Provider>
    </EventBusProvider>
  );
  const view = render(tree(workspace));
  return { emit, rerender: (next: Partial<WorkspaceContextValue>) => view.rerender(tree(next)) };
}

const FAILED = {
  kind: 'git-sync-failed',
  workspaceId: 'ws-1',
  branch: 'feat/x',
  reason: 'git push failed: fatal: Authentication failed',
};

/** The backend's sentence for a viewer who may not read the blocking file. */
const UNNAMED_REFUSAL =
  'The platform’s access check refused the push of "feat/x": an unshared commit on it changes a file you may not read.';

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
    expect(alert.textContent).toContain('aren’t reaching your git host');
    expect(alert.textContent).not.toMatch(/remote repository/i);
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

  it("says the platform's access check refused, not the git host, when the platform refused the push", () => {
    const bus = renderBanner();
    const reason =
      'The platform’s access check refused the push of "feat/x": "G/a.md" may be written by Admin; qa-b@example.com.';
    bus.emit({ ...FAILED, reason, accessRefusal: { path: 'G/a.md' } });

    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('feat/x');
    expect(text).toContain('saved here but were not shared');
    expect(text).toContain(reason);
    // Who refused is said once, by the detail line.
    expect(text.match(/access check refused the push/g)).toHaveLength(1);
    expect(text).not.toMatch(/git host|server logs/i);
  });

  it('keeps the platform headline when the file was withheld from this person', () => {
    const bus = renderBanner();
    bus.emit({ ...FAILED, reason: UNNAMED_REFUSAL, accessRefusal: {} });
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('saved here but were not shared');
    expect(text).toContain(UNNAMED_REFUSAL);
    expect(text).not.toMatch(/git host|server logs/i);
  });

  it('a host failure after a platform refusal goes back to the git-host headline', () => {
    const bus = renderBanner();
    bus.emit({ ...FAILED, reason: UNNAMED_REFUSAL, accessRefusal: {} });
    bus.emit(FAILED);
    expect(screen.getByRole('alert').textContent).toContain('aren’t reaching your git host');
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
    expect(alert.textContent).toContain('changed both here and on your git host');
    expect(alert.textContent).not.toContain('server logs');
    // Plain words: no branch name, no "in sync", no "reconcile".
    expect(alert.textContent).not.toContain('feat/x');
    expect(alert.textContent).not.toMatch(/\bsync|reconcile|repository/i);
    expect(alert.textContent).toContain('open each one, keep the content you want');
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

describe('GitSyncFailedBanner — a conflict that arrives before the workspace has bootstrapped', () => {
  it('lists the files as text, never as links to null/<path>', () => {
    const bus = renderBanner({ kbDirName: null });
    const early = {
      kind: 'git-sync-failed',
      workspaceId: 'ws-1',
      branch: 'feat/x',
      reason: 'conflict',
      conflictedPaths: ['Docs/a.md'],
    };
    bus.emit(early);
    expect(screen.getByText('Docs/a.md')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Docs/a.md' })).toBeNull();
  });
});

describe('GitSyncFailedBanner — for a named workspace (the change-request view)', () => {
  function renderFor(workspaceId: string, focused: Partial<WorkspaceContextValue> | null) {
    const banner = <GitSyncFailedBanner workspaceId={workspaceId} />;
    render(
      <EventBusProvider>
        {focused ? (
          <WorkspaceContext.Provider value={workspaceValue(focused)}>{banner}</WorkspaceContext.Provider>
        ) : (
          banner
        )}
      </EventBusProvider>,
    );
    return { emit };
  }

  it('follows the named workspace, not the focused one', () => {
    const bus = renderFor('ali%2Fx', { workspaceId: 'main' });
    bus.emit({ ...FAILED, workspaceId: 'main', branch: 'main' });
    expect(screen.queryByRole('alert')).toBeNull();
    bus.emit({ ...FAILED, workspaceId: 'ali/x', branch: 'ali/x' });
    expect(screen.getByRole('alert').textContent).toContain('ali/x');
    bus.emit({ kind: 'git-sync-recovered', workspaceId: 'ali/x', branch: 'ali/x' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('needs no workspace context at all', () => {
    const bus = renderFor('ali%2Fx', null);
    bus.emit({ ...FAILED, workspaceId: 'ali/x', branch: 'ali/x' });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it("lists another branch's conflicted files as text — a link would open the focused branch's copy", () => {
    const bus = renderFor('ali%2Fx', { workspaceId: 'main', kbDirName: 'knowledge-base' });
    const conflict = {
      kind: 'git-sync-failed',
      workspaceId: 'ali/x',
      branch: 'ali/x',
      reason: 'conflict',
      conflictedPaths: ['Docs/a.md'],
    };
    bus.emit(conflict);
    expect(screen.getByText('Docs/a.md').tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: 'Docs/a.md' })).toBeNull();
    // Nothing here opens, so the copy sends the person to the branch first —
    // named, since it is not the one on screen.
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('switch to ali/x, open each one there');
    expect(text).not.toContain('open each one, keep');
  });
});
