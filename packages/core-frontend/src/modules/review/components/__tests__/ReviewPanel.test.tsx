import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ReviewSession } from '@bevel-software/platform-shared';
import { ReviewPanel } from '../ReviewPanel';
import { ReviewContext, type ReviewContextValue } from '../../state/review.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../workspace/state/workspace.context';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';

const session: ReviewSession = {
  branchName: 'razvan/onboarding-tweaks',
  baselineRef: '',
  createdAt: '2026-06-08T00:00:00.000Z',
  changes: [
    { path: 'processes/onboarding.md', kind: 'modified', isBinary: false, linesAdded: 12, linesRemoved: 3 },
    { path: 'processes/new-hire-checklist.md', kind: 'added', isBinary: false, linesAdded: 40, linesRemoved: 0 },
  ],
};

function makeReview(overrides: Partial<ReviewContextValue> = {}): ReviewContextValue {
  return {
    session,
    selectedPath: 'processes/onboarding.md',
    fileDiff: null,
    isLoadingDiff: false,
    isLoading: false,
    lastError: null,
    refresh: vi.fn(async () => {}),
    selectPath: vi.fn(async () => {}),
    acceptOne: vi.fn(async () => {}),
    rejectOne: vi.fn(async () => {}),
    acceptAll: vi.fn(async () => {}),
    rejectAll: vi.fn(async () => {}),
    clearError: vi.fn(),
    ...overrides,
  };
}

function renderPanel(review: ReviewContextValue) {
  const workspace = { refreshFileTree: vi.fn(async () => null) } as unknown as WorkspaceContextValue;
  const git = { status: { branch: session.branchName } } as unknown as GitContextValue;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <GitContext.Provider value={git}>
        <WorkspaceContext.Provider value={workspace}>
          <ReviewContext.Provider value={review}>{children}</ReviewContext.Provider>
        </WorkspaceContext.Provider>
      </GitContext.Provider>
    </MemoryRouter>
  );
  return render(<ReviewPanel />, { wrapper });
}

describe('ReviewPanel top-bar actions (BEVA-77)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Accept/Delete and an unchecked Apply-to-all checkbox, not the old "all" buttons', () => {
    renderPanel(makeReview());

    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject all' })).toBeNull();

    const checkbox = screen.getByRole('checkbox', { name: /apply to all/i }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('with Apply-to-all OFF, Accept/Delete act on the selected file only', async () => {
    const review = makeReview();
    renderPanel(review);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(review.acceptOne).toHaveBeenCalledWith('processes/onboarding.md'));
    expect(review.acceptAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(review.rejectOne).toHaveBeenCalledWith('processes/onboarding.md'));
    expect(review.rejectAll).not.toHaveBeenCalled();
  });

  it('with Apply-to-all ON, Accept/Delete act on every change', async () => {
    const review = makeReview();
    renderPanel(review);
    const user = userEvent.setup();

    await user.click(screen.getByRole('checkbox', { name: /apply to all/i }));

    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(review.acceptAll).toHaveBeenCalledTimes(1));
    expect(review.acceptOne).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(review.rejectAll).toHaveBeenCalledTimes(1));
    expect(review.rejectOne).not.toHaveBeenCalled();
  });

  it('disables the single-file actions when nothing is selected (Apply-to-all OFF)', () => {
    renderPanel(makeReview({ selectedPath: null }));
    expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
