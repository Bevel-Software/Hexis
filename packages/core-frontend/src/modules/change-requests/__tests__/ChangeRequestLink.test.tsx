import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { GitApiError } from '../../git/services/git.api';

const api = vi.hoisted(() => ({ getPullRequest: vi.fn() }));
vi.mock('../../git/services/pr.api', () => ({ getPullRequest: api.getPullRequest }));

// The view itself is covered where it lives; here it is a stand-in that shows
// which request it was handed and lets a test close it.
vi.mock('../components/ChangeRequestDialog', () => ({
  ChangeRequestDialog: ({ cr, onClose }: { cr: PullRequestSummary; onClose(): void }) => (
    <div role="dialog" aria-label={`change request ${cr.number}`}>
      {cr.title}
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

import { ChangeRequestLink } from '../components/ChangeRequestLink';

/**
 * `/change-requests/<number>` is the address every agent hands a person for a
 * change request. Until this route existed the shell's catch-all sent it to
 * the workspace with nothing open — "the link didn't open anything". These
 * pin what the address does now: the request opens, a bad or hidden one says
 * so in one sentence, and leaving the view lands in Knowledge.
 */

const CR = { number: 276, title: 'Add the Q3 roadmap', author: { login: 'bot' } } as PullRequestSummary;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/change-requests/:number" element={<ChangeRequestLink />} />
        <Route path="*" element={<div data-testid="elsewhere" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getPullRequest.mockReset();
});

describe('ChangeRequestLink', () => {
  it('opens the request the address names, in the change-request view', async () => {
    api.getPullRequest.mockResolvedValue(CR);
    renderAt('/change-requests/276');
    expect(screen.getByText('Opening change request #276…')).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'change request 276' });
    expect(dialog).toHaveTextContent('Add the Q3 roadmap');
    expect(api.getPullRequest).toHaveBeenCalledWith(276);
  });

  it('goes to Knowledge when the view is closed — there is nothing under it to return to', async () => {
    api.getPullRequest.mockResolvedValue(CR);
    renderAt('/change-requests/276');
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // A request that is not there and one the viewer may not see read the
  // same: the address must not tell someone a request they may not see
  // exists.
  it.each([404, 403])('says there is no such request on a %s, naming the number', async (status) => {
    api.getPullRequest.mockRejectedValue(new GitApiError(status, 'nope'));
    renderAt('/change-requests/276');
    expect(
      await screen.findByText(/There is no change request #276 — it does not exist, or you may not see it\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the knowledge base' })).toHaveAttribute('href', '/workspace');
  });

  it('keeps the platform\'s own words for any other failure', async () => {
    api.getPullRequest.mockRejectedValue(new GitApiError(502, 'the repository host is unreachable'));
    renderAt('/change-requests/276');
    expect(await screen.findByText(/could not be opened: the repository host is unreachable/)).toBeInTheDocument();
  });

  it('asks the server nothing for an address that names no request', async () => {
    for (const bad of ['/change-requests/abc', '/change-requests/0', '/change-requests/-3', '/change-requests/12x']) {
      const { unmount } = renderAt(bad);
      expect(screen.getByText(/There is no change request/)).toBeInTheDocument();
      unmount();
    }
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it('ignores an answer that arrives after the address changed', async () => {
    let resolveFirst: (cr: PullRequestSummary) => void = () => {};
    api.getPullRequest.mockImplementationOnce(
      () => new Promise<PullRequestSummary>((resolve) => (resolveFirst = resolve)),
    );
    const { unmount } = renderAt('/change-requests/276');
    unmount();
    resolveFirst(CR);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
