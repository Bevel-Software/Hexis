import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PullRequestDetail, WorkflowEvent } from '@bevel-software/platform-shared';
import { PrMergeButton } from '../components/PrMergeButton';
// The button doesn't seed chat directly — on a conflicted apply it calls the
// change-request port's `resolveCrConflicts`. In the enterprise build a
// registry provider binds that port to chat seeding; core tests mount a stub
// port and assert the port itself is invoked.
import { CrCreationPortContext, type CrCreationPort } from '../../../core/registry';
import { EventBusContext, type EventBusContextValue } from '../../workflow/state/event-bus.context';
import { mergePullRequest } from '../services/pr-merge.api';
import { fetchPrDetail } from '../services/pr-detail.api';

vi.mock('../services/pr-merge.api', () => ({
  mergePullRequest: vi.fn().mockResolvedValue({ status: 'merging', number: 1 }),
}));

vi.mock('../services/pr-detail.api', () => ({
  fetchPrDetail: vi.fn(),
}));

/** A test double for the event bus that lets a test push events to subscribers. */
function makeFakeBus() {
  const handlers: Record<string, ((e: WorkflowEvent) => void)[]> = {};
  const bus: EventBusContextValue & { emit(e: WorkflowEvent): void } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: WorkflowEvent) => void);
      return () => {
        handlers[kind] = (handlers[kind] ?? []).filter((h) => h !== handler);
      };
    },
    setFocus() {},
    emit(e) {
      (handlers[e.kind] ?? []).forEach((h) => h(e));
    },
  };
  return bus;
}

/**
 * `PrMergeButton` reads the change-request port to hand off merge-conflict
 * outcomes (so a registered resolver — the enterprise agent flow — picks up
 * the resolution instead of the user). Tests render under a stub port;
 * conflict-path tests can pass a spying `resolveCrConflicts` to assert the
 * hand-off payload.
 */
function makeStubPort(resolveCrConflicts: ReturnType<typeof vi.fn> = vi.fn()): CrCreationPort {
  return { start: vi.fn(), resolveCrConflicts };
}

function renderWithChat(ui: ReactNode, resolveCrConflicts: ReturnType<typeof vi.fn> = vi.fn()) {
  return render(
    <CrCreationPortContext.Provider value={makeStubPort(resolveCrConflicts)}>
      {ui}
    </CrCreationPortContext.Provider>,
  );
}

function renderWithBus(
  ui: ReactNode,
  bus: ReturnType<typeof makeFakeBus>,
  resolveCrConflicts: ReturnType<typeof vi.fn> = vi.fn(),
) {
  return render(
    <EventBusContext.Provider value={bus}>
      <CrCreationPortContext.Provider value={makeStubPort(resolveCrConflicts)}>
        {ui}
      </CrCreationPortContext.Provider>
    </EventBusContext.Provider>,
  );
}

function detail(overrides: Partial<PullRequestDetail>): PullRequestDetail {
  return {
    number: 1,
    title: 'Test PR',
    author: { login: 'alice' },
    branch: 'feature/x',
    base: 'current-company-state',
    state: overrides.state ?? 'open',
    createdAt: '2026-04-20T10:00:00Z',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://github.com/acme/repo/pull/1',
    body: '',
    headSha: 'head',
    baseSha: 'base',
    files: [],
    comments: [],
    approvals: [],
    mergeableInBevel: overrides.mergeableInBevel ?? true,
    mergeBlockedReasons: overrides.mergeBlockedReasons ?? [],
    mergeWarnings: overrides.mergeWarnings ?? [],
    // Default to admin (true) so existing tests describe the admin-with-bypass
    // path. The non-admin path has its own dedicated test below.
    viewerCanBypassMerge: overrides.viewerCanBypassMerge ?? true,
    // Default true for parity with the admin assumption above — keeps existing
    // tests focused on the merge gate; the cancel button has its own test file.
    viewerCanCancel: overrides.viewerCanCancel ?? true,
    ...overrides,
  };
}

describe('PrMergeButton', () => {
  it('is hidden when the PR is already merged', () => {
    const { container } = renderWithChat(
      <PrMergeButton detail={detail({ state: 'merged', mergeableInBevel: true })} onMerged={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is hidden when the PR is closed', () => {
    const { container } = renderWithChat(
      <PrMergeButton detail={detail({ state: 'closed' })} onMerged={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('is disabled when a hard block applies (mergeableInBevel = false)', () => {
    renderWithChat(
      <PrMergeButton
        detail={detail({
          mergeableInBevel: false,
          mergeBlockedReasons: ['This pull request has no file changes to approve.'],
        })}
        onMerged={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /apply draft/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('no file changes');
  });

  it('joins multiple hard-block reasons into the tooltip on newlines', () => {
    renderWithChat(
      <PrMergeButton
        detail={detail({
          mergeableInBevel: false,
          mergeBlockedReasons: [
            'This pull request has already been merged.',
            'This pull request has no file changes to approve.',
          ],
        })}
        onMerged={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /apply draft/i });
    expect(btn.getAttribute('title')).toMatch(/already been merged/);
    expect(btn.getAttribute('title')).toMatch(/no file changes/);
  });

  it('is enabled with the default (purple) label when the gate is clean', () => {
    renderWithChat(
      <PrMergeButton
        detail={detail({ mergeableInBevel: true, mergeWarnings: [] })}
        onMerged={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /^apply draft to current company state$/i });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('title')).toMatch(/all files confirmed/i);
    expect(btn.getAttribute('title')).toMatch(/Current company state/);
  });

  it('stays enabled when warnings exist but no hard block (admin bypass path)', () => {
    // Same "Apply draft …" label as the clean path — the bypass dialog
    // appears AFTER the user clicks, not as a relabel up front. The
    // amber color + tooltip carry the "something to review" signal.
    renderWithChat(
      <PrMergeButton
        detail={detail({
          mergeableInBevel: true,
          mergeBlockedReasons: [],
          mergeWarnings: ['Waiting on Bob to approve B.md.'],
          viewerCanBypassMerge: true,
        })}
        onMerged={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /^apply draft to current company state$/i });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('title')).toMatch(/1 confirmation pending/i);
    expect(btn.getAttribute('title')).toMatch(/click to review/i);
  });

  it('drops the "to {base}" suffix in compact mode while keeping the full tooltip', () => {
    renderWithChat(
      <PrMergeButton
        detail={detail({
          mergeableInBevel: true,
          mergeBlockedReasons: [],
          mergeWarnings: ['Waiting on Bob to approve B.md.'],
          viewerCanBypassMerge: true,
        })}
        onMerged={() => {}}
        compact
      />,
    );
    const btn = screen.getByRole('button', { name: /^apply draft$/i });
    expect(btn).toBeEnabled();
    expect(btn.getAttribute('title')).toMatch(/1 confirmation pending/i);
    expect(btn.getAttribute('title')).toMatch(/click to review/i);
  });

  it('disables the merge button with admin-only copy when the viewer cannot bypass', () => {
    // Non-admin user: backend would 403 on a bypass click. Frontend should
    // surface that as a disabled button up front instead of letting the
    // user open the bypass dialog only to hit an error.
    renderWithChat(
      <PrMergeButton
        detail={detail({
          mergeableInBevel: true,
          mergeBlockedReasons: [],
          mergeWarnings: ['Waiting on approval for test.md from Admin.'],
          viewerCanBypassMerge: false,
        })}
        onMerged={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /waiting on confirmations/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/only an admin can apply now/i);
  });

  describe('async merge (202 + event bus)', () => {
    it('shows "Applying…" on click and completes via change-request-merged', async () => {
      vi.mocked(mergePullRequest).mockResolvedValueOnce({ status: 'merging', number: 1 });
      const onMerged = vi.fn();
      const bus = makeFakeBus();
      renderWithBus(<PrMergeButton detail={detail({ mergeableInBevel: true })} onMerged={onMerged} />, bus);

      fireEvent.click(screen.getByRole('button', { name: /apply draft/i }));
      // Pending state shows immediately; the POST only acks (202).
      expect(screen.getByRole('button', { name: /applying/i })).toBeInTheDocument();
      expect(mergePullRequest).toHaveBeenCalledWith(1, {});
      await act(async () => {}); // flush the awaited 202 ack

      // onMerged fires only when the merge event for THIS CR lands.
      expect(onMerged).not.toHaveBeenCalled();
      act(() => bus.emit({ kind: 'change-request-merged', number: 1, id: 1, ts: '' }));
      expect(onMerged).toHaveBeenCalledTimes(1);
    });

    it('hands conflicts to the change-request port (does not error) when the merge reports conflicts', async () => {
      vi.mocked(mergePullRequest).mockResolvedValueOnce({ status: 'merging', number: 1 });
      const resolveCrConflicts = vi.fn();
      const bus = makeFakeBus();
      renderWithBus(<PrMergeButton detail={detail({ mergeableInBevel: true })} onMerged={() => {}} />, bus, resolveCrConflicts);

      fireEvent.click(screen.getByRole('button', { name: /apply draft/i }));
      await act(async () => {});
      act(() =>
        bus.emit({
          kind: 'change-request-merge-failed',
          forUserId: 'u',
          number: 1,
          reason: 'conflicts',
          conflicts: true,
          id: 1,
          ts: '',
        }),
      );
      expect(resolveCrConflicts).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'apply', changeRequestNumber: 1, base: 'current-company-state' }),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('surfaces the reason as an error banner on a non-conflict merge failure', async () => {
      vi.mocked(mergePullRequest).mockResolvedValueOnce({ status: 'merging', number: 1 });
      const bus = makeFakeBus();
      renderWithBus(<PrMergeButton detail={detail({ mergeableInBevel: true })} onMerged={() => {}} />, bus);

      fireEvent.click(screen.getByRole('button', { name: /apply draft/i }));
      await act(async () => {});
      act(() =>
        bus.emit({
          kind: 'change-request-merge-failed',
          forUserId: 'u',
          number: 1,
          reason: 'gh pr merge failed: timed out',
          conflicts: false,
          id: 1,
          ts: '',
        }),
      );
      expect(screen.getByRole('alert').textContent).toMatch(/timed out/);
    });

    it('closes the bypass dialog (not just shows the error) when a bypass merge fails', async () => {
      vi.mocked(mergePullRequest).mockResolvedValueOnce({ status: 'merging', number: 1 });
      const bus = makeFakeBus();
      renderWithBus(
        <PrMergeButton
          detail={detail({
            mergeableInBevel: true,
            mergeWarnings: ['Waiting on Bob to approve B.md.'],
            viewerCanBypassMerge: true,
          })}
          onMerged={() => {}}
        />,
        bus,
      );

      fireEvent.click(screen.getByRole('button', { name: /apply draft/i }));
      // Confirm through the bypass dialog (acknowledge checkbox enables it).
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: /with bypass/i }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await act(async () => {});

      act(() =>
        bus.emit({
          kind: 'change-request-merge-failed',
          forUserId: 'u',
          number: 1,
          reason: 'gh pr merge failed',
          conflicts: false,
          id: 1,
          ts: '',
        }),
      );
      // Dialog dismissed, error surfaced in the button row (not stranded behind it).
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('alert').textContent).toMatch(/gh pr merge failed/);
    });

    it('completes via the polling fallback when the merge event is lost (SSE drop)', async () => {
      // Reproduces the reported bug: the apply lands server-side but the
      // `change-request-merged` event never arrives (proxy 502 / backend
      // restart took the SSE connection with it). The button must still
      // resolve off the CR's real state instead of spinning "Applying…".
      vi.useFakeTimers();
      try {
        vi.mocked(mergePullRequest).mockResolvedValueOnce({ status: 'merging', number: 1 });
        // First poll: still open (merge in flight). Second poll: merged.
        vi.mocked(fetchPrDetail)
          .mockResolvedValueOnce(detail({ state: 'open' }))
          .mockResolvedValueOnce(detail({ state: 'merged' }));
        const onMerged = vi.fn();
        const bus = makeFakeBus();
        renderWithBus(<PrMergeButton detail={detail({ mergeableInBevel: true })} onMerged={onMerged} />, bus);

        fireEvent.click(screen.getByRole('button', { name: /apply draft/i }));
        await act(async () => {}); // flush the 202 ack → arms the poll

        // NO SSE event arrives. First poll tick: CR still open → keep waiting.
        await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
        expect(onMerged).not.toHaveBeenCalled();

        // Second poll tick: CR now reads merged → resolve without the event.
        await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
        expect(onMerged).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
