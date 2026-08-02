import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BranchInfo, WorkingTreeStatus } from '@bevel-software/platform-shared';
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
  it('names the branch it is on, and where to propose changes instead', () => {
    renderWith(makeGit());
    expect(screen.getByText(/Current company state/)).toBeInTheDocument();
    // Not the default branch, so the sentence redirects rather than instructs.
    expect(screen.getByText(/Target company state/)).toBeInTheDocument();
    expect(screen.getByText(/propose your edits there instead/)).toBeInTheDocument();
  });

  // The branch SLUG used to be printed beside the display name — the same fact
  // in the machine's spelling. It is the one piece of the sentence that made a
  // note to a person look like a system message.
  it('does not print the raw branch slug', () => {
    renderWith(makeGit());
    expect(screen.queryByText('current-company-state')).not.toBeInTheDocument();
  });

  // On the default branch a draft lands back here, so the sentence is an
  // instruction about editing rather than a redirect somewhere else.
  it('tells you how to edit when you are on the default branch', () => {
    renderWith(
      makeGit({
        status: { branch: 'target-company-state', hasUpstream: true, unmergedFromUpstream: false },
      }),
    );
    expect(screen.getByText(/the version everyone works from/)).toBeInTheDocument();
    expect(screen.getByText(/start a draft/)).toBeInTheDocument();
    expect(screen.queryByText(/instead/)).not.toBeInTheDocument();
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
