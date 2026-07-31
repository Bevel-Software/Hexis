import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BranchInfo, WorkingTreeStatus } from '@bevel-software/shared';
import {
  ProtectedBranchBanner,
  isProtectedBranchName,
} from '../components/ProtectedBranchBanner';
import { GitContext, type GitContextValue } from '../state/git.context';

function makeGit(
  overrides: { status?: WorkingTreeStatus | null; availability?: GitContextValue['availability'] } = {},
): GitContextValue {
  const status: WorkingTreeStatus | null =
    overrides.status === undefined
      ? {
          branch: 'current-company-state',
          hasUpstream: true,
          unmergedFromUpstream: false,
        }
      : overrides.status;
  const branches: BranchInfo[] = [];
  return {
    status,
    branches,
    availability: overrides.availability ?? 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    pull: async () => {},
    deleteBranch: async () => {},
    fetchForkBase: async () => null,
    revert: async () => ({ authorName: '', authorEmail: '', sha: '', subject: '', committedAt: '' }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileComparison: async () => '',
  };
}

function renderWith(git: GitContextValue) {
  return render(
    <GitContext.Provider value={git}>
      <ProtectedBranchBanner />
    </GitContext.Provider>,
  );
}

describe('isProtectedBranchName', () => {
  it('recognises current-company-state and target-company-state', () => {
    expect(isProtectedBranchName('current-company-state')).toBe(true);
    expect(isProtectedBranchName('target-company-state')).toBe(true);
  });
  it('does not flag user branches', () => {
    expect(isProtectedBranchName('alice/foo')).toBe(false);
    expect(isProtectedBranchName('main')).toBe(false);
    expect(isProtectedBranchName(null)).toBe(false);
    expect(isProtectedBranchName(undefined)).toBe(false);
  });
});

describe('ProtectedBranchBanner', () => {
  it('shows the warning when on a protected branch', () => {
    renderWith(makeGit());
    expect(screen.getByText(/Current company state/)).toBeInTheDocument();
    expect(screen.getByText(/Target company state/)).toBeInTheDocument();
    expect(screen.getByText('current-company-state')).toBeInTheDocument();
  });

  it('renders nothing on a user branch', () => {
    const { container } = renderWith(
      makeGit({
        status: { branch: 'alice/foo', hasUpstream: true, unmergedFromUpstream: false },
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while loading (no status yet)', () => {
    const { container } = renderWith(makeGit({ status: null, availability: 'loading' }));
    expect(container.firstChild).toBeNull();
  });
});
