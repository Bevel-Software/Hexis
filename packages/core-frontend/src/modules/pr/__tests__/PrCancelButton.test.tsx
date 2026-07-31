import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PullRequestDetail } from '@bevel-software/platform-shared';

// API mock — replaces the network call. Each test resets and configures.
vi.mock('../services/pr-cancel.api', () => ({
  cancelPullRequest: vi.fn(),
}));

import { PrCancelButton } from '../components/PrCancelButton';
import { cancelPullRequest } from '../services/pr-cancel.api';

const cancelMock = cancelPullRequest as unknown as ReturnType<typeof vi.fn>;

function detail(overrides: Partial<PullRequestDetail>): PullRequestDetail {
  return {
    number: 42,
    title: 'Test PR',
    author: { login: 'alice' },
    branch: 'feature/x',
    base: 'current-company-state',
    state: 'open',
    createdAt: '2026-05-01T00:00:00Z',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://github.com/acme/repo/pull/42',
    body: '',
    headSha: 'head',
    baseSha: 'base',
    files: [],
    comments: [],
    approvals: [],
    mergeableInBevel: true,
    mergeBlockedReasons: [],
    mergeWarnings: [],
    viewerCanBypassMerge: false,
    viewerCanCancel: true,
    ...overrides,
  };
}

describe('PrCancelButton', () => {
  beforeEach(() => {
    cancelMock.mockReset();
  });
  afterEach(() => {
    cancelMock.mockReset();
  });

  it('renders nothing for a merged PR', () => {
    const { container } = render(
      <PrCancelButton detail={detail({ state: 'merged' })} onCancelled={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a closed PR', () => {
    const { container } = render(
      <PrCancelButton detail={detail({ state: 'closed' })} onCancelled={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('marks the button aria-disabled with the only-author-or-admin tooltip when viewerCanCancel is false', () => {
    render(
      <PrCancelButton
        detail={detail({ viewerCanCancel: false })}
        onCancelled={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /cancel change request/i });
    // aria-disabled (not the disabled attribute) so the button stays focusable
    // for keyboard users and screen readers announce the unauthorized state.
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/only the author or an admin/i);
    // Click should still be a no-op (component-level guard).
    fireEvent.click(btn);
    expect(cancelMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking the enabled button opens the confirm dialog without firing the API', () => {
    render(
      <PrCancelButton detail={detail({})} onCancelled={() => {}} />,
    );
    const btn = screen.getByRole('button', { name: /cancel change request/i });
    fireEvent.click(btn);
    // Dialog opens — both heading and a "Keep open" affordance are visible.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /cancel this change request/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep open/i })).toBeInTheDocument();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('confirms in the dialog: calls the API, dispatches bevel:pr-stale, and calls onCancelled', async () => {
    cancelMock.mockResolvedValue({ prNumber: 42, cancelledAt: '2026-05-11T15:00:00.000Z' });
    const onCancelled = vi.fn();
    const eventSpy = vi.fn();
    window.addEventListener('bevel:pr-stale', eventSpy);
    try {
      render(<PrCancelButton detail={detail({})} onCancelled={onCancelled} />);
      fireEvent.click(screen.getByRole('button', { name: /^cancel change request$/i }));
      // Click the *confirm* button inside the dialog — there are two buttons
      // with this label (the trigger and the confirm); the dialog's confirm
      // is the second match.
      const confirmButtons = screen.getAllByRole('button', { name: /^cancel change request$/i });
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
      expect(cancelMock).toHaveBeenCalledWith(42);
      expect(onCancelled).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalled();
    } finally {
      window.removeEventListener('bevel:pr-stale', eventSpy);
    }
  });

  it('on API error: surfaces friendly error inline and does NOT fire onCancelled or bevel:pr-stale', async () => {
    cancelMock.mockRejectedValue(new Error('This change request was already applied.'));
    const onCancelled = vi.fn();
    const eventSpy = vi.fn();
    window.addEventListener('bevel:pr-stale', eventSpy);
    try {
      render(<PrCancelButton detail={detail({})} onCancelled={onCancelled} />);
      fireEvent.click(screen.getByRole('button', { name: /^cancel change request$/i }));
      const confirmButtons = screen.getAllByRole('button', { name: /^cancel change request$/i });
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
      // Friendly mapping should kick in (see error-messages.ts).
      const errorEl = await screen.findByRole('alert');
      expect(errorEl.textContent).toMatch(/already applied/i);
      expect(onCancelled).not.toHaveBeenCalled();
      expect(eventSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('bevel:pr-stale', eventSpy);
    }
  });

  it('guards against double-confirm: a second click while busy does not fire the API twice', async () => {
    // Deferred resolve so the first call stays in-flight while we fire a second.
    let resolveFirst!: (v: { prNumber: number; cancelledAt: string }) => void;
    cancelMock.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = res;
        }),
    );
    render(<PrCancelButton detail={detail({})} onCancelled={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel change request$/i }));
    const confirmButtons = screen.getAllByRole('button', { name: /^cancel change request$/i });
    const dialogConfirm = confirmButtons[confirmButtons.length - 1];
    fireEvent.click(dialogConfirm);
    // Double-click while busy
    fireEvent.click(dialogConfirm);
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
    resolveFirst({ prNumber: 42, cancelledAt: '2026-05-11T15:00:00.000Z' });
  });
});
