import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BranchInfo, PullRequestSummary } from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({ listPullRequestsForMe: vi.fn() }));
vi.mock('../services/pr.api', () => ({ listPullRequestsForMe: api.listPullRequestsForMe }));

import { PullRequestsForMe } from '../components/PullRequestsForMe';
import { GitContext, type GitContextValue } from '../state/git.context';
import { PrViewerContext, type PrViewerContextValue } from '../../pr/state/pr-viewer.context';

function pr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 32,
    title: 'Restate the enforcement wording so it reads as a rule',
    author: { login: 'bevel-bot' },
    appAuthor: { name: 'Ali Raza' },
    branch: 'ali/wording',
    base: 'main',
    state: 'open',
    createdAt: '2026-07-27T00:00:00.000Z',
    touchedNodePaths: ['Knowledge/Foo.md'],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: 'https://example.com/pr/32',
    ...over,
  };
}

function makeGit(availability: GitContextValue['availability'] = 'ready'): GitContextValue {
  const branches: BranchInfo[] = [];
  return {
    status: { branch: 'main', hasUpstream: true, unmergedFromUpstream: false },
    branches,
    availability,
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    revert: async () => ({
      sha: 'a', authorName: 'n', authorEmail: 'e', subject: 's', committedAt: '2026-01-01T00:00:00Z',
    }),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
  };
}

const openPr = vi.fn();

function renderDock() {
  const prViewer: PrViewerContextValue = {
    openPrNumber: null,
    detail: null,
    notFound: false,
    selectedPath: null,
    isLoading: false,
    lastError: null,
    openPr,
    closeViewer: () => {},
    selectPath: () => {},
    refresh: async () => {},
  };
  return render(
    <GitContext.Provider value={makeGit()}>
      <PrViewerContext.Provider value={prViewer}>
        <PullRequestsForMe />
      </PrViewerContext.Provider>
    </GitContext.Provider>,
  );
}

describe('PullRequestsForMe — the change-request dock', () => {
  beforeEach(() => {
    api.listPullRequestsForMe.mockReset();
    openPr.mockReset();
  });

  it('carries the count in its header and expands by default', async () => {
    api.listPullRequestsForMe.mockResolvedValue([pr({ number: 32 }), pr({ number: 41 })]);
    renderDock();
    const header = await screen.findByRole('button', { name: 'Change requests for you' });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(header).toHaveTextContent('2');
  });

  it('shows the number, the title and who wants how much changed', async () => {
    api.listPullRequestsForMe.mockResolvedValue([
      pr({ number: 32, touchedNodePaths: ['a.md', 'b.md'] }),
    ]);
    renderDock();
    expect(await screen.findByText('#32')).toBeInTheDocument();
    expect(screen.getByText(/Restate the enforcement wording/)).toBeInTheDocument();
    expect(screen.getByText('Ali Raza')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
  });

  it('says "1 file", not "1 files"', async () => {
    api.listPullRequestsForMe.mockResolvedValue([pr({ touchedNodePaths: ['only.md'] })]);
    renderDock();
    expect(await screen.findByText('1 file')).toBeInTheDocument();
  });

  // A queue you notice, not one you live in.
  it('renders nothing at all when nothing is waiting', async () => {
    api.listPullRequestsForMe.mockResolvedValue([]);
    const { container } = renderDock();
    await waitFor(() => expect(api.listPullRequestsForMe).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // `appAuthor` is absent for a request opened outside this backend, or after
  // the app user was removed. Never render "undefined" at somebody.
  it('falls back to the GitHub login when there is no app author', async () => {
    api.listPullRequestsForMe.mockResolvedValue([
      pr({ appAuthor: undefined, author: { login: 'octocat' } }),
    ]);
    renderDock();
    expect(await screen.findByText('octocat')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('collapses and re-expands from the header', async () => {
    const user = userEvent.setup();
    api.listPullRequestsForMe.mockResolvedValue([pr()]);
    renderDock();
    const header = await screen.findByRole('button', { name: 'Change requests for you' });
    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('#32')).not.toBeInTheDocument();
  });

  it('opens the request viewer from a row', async () => {
    const user = userEvent.setup();
    api.listPullRequestsForMe.mockResolvedValue([pr({ number: 32 })]);
    renderDock();
    await user.click(await screen.findByRole('button', { name: /Restate the enforcement/ }));
    expect(openPr).toHaveBeenCalledWith(32);
  });

  // "We could not ask" is not the same answer as "there is nothing".
  it('still shows itself when the list could not be loaded', async () => {
    api.listPullRequestsForMe.mockRejectedValue(new Error('network down'));
    renderDock();
    expect(
      await screen.findByRole('button', { name: 'Change requests for you' }),
    ).toBeInTheDocument();
  });
});
