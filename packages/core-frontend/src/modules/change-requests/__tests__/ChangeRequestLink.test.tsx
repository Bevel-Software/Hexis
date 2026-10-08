import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { GitApiError } from '../../git/services/git.api';

const api = vi.hoisted(() => ({ getPullRequest: vi.fn() }));
vi.mock('../../git/services/pr.api', () => ({ getPullRequest: api.getPullRequest }));

// The view itself is covered where it lives; here it is a stand-in that shows
// which request it was handed and lets a test close it.
vi.mock('../components/ChangeRequestDialog', () => ({
  ChangeRequestDialog: ({
    cr,
    onClose,
    onResolved,
  }: {
    cr: PullRequestSummary;
    onClose(): void;
    onResolved(): void;
  }) => (
    <div role="dialog" aria-label={`change request ${cr.number}`}>
      {cr.title}
      <button onClick={onClose}>Close</button>
      <button onClick={onResolved}>Apply</button>
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

/** The address, and a way to change it the way a link in the app would. */
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="pathname">{location.pathname}</div>
      <button onClick={() => navigate('/change-requests/277')}>Go to 277</button>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={['/somewhere-before', path]} initialIndex={1}>
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

  it.each(['Close', 'Apply'])(
    'goes to Knowledge on %s — there is nothing under the view to return to',
    async (verb) => {
      api.getPullRequest.mockResolvedValue(CR);
      renderAt('/change-requests/276');
      await userEvent.click(await screen.findByRole('button', { name: verb }));
      expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  // The link's entry is replaced, not pushed: Back after closing must not
  // land on the address again and reopen the request.
  it('leaves no history entry behind, so Back goes to where the person was before the link', async () => {
    api.getPullRequest.mockResolvedValue(CR);
    renderAt('/change-requests/276');
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/somewhere-before$/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // The page's own way out behaves the same as the dialog's.
  it('leaves no history entry behind through "Back to the knowledge base" either', async () => {
    api.getPullRequest.mockRejectedValue(new GitApiError(404, 'nope'));
    renderAt('/change-requests/276');
    await userEvent.click(await screen.findByRole('link', { name: 'Back to the knowledge base' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/somewhere-before$/);
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
    for (const bad of [
      '/change-requests/abc',
      '/change-requests/0',
      '/change-requests/-3',
      '/change-requests/12x',
      // One past the database sequence's maximum.
      '/change-requests/2147483648',
    ]) {
      const { unmount } = renderAt(bad);
      expect(screen.getByText(/There is no change request/)).toBeInTheDocument();
      unmount();
    }
    expect(api.getPullRequest).not.toHaveBeenCalled();
  });

  it('accepts every number the database can hand out', async () => {
    api.getPullRequest.mockResolvedValue({ ...CR, number: 2147483647, title: 'The last one' });
    renderAt('/change-requests/2147483647');
    expect(await screen.findByRole('dialog', { name: 'change request 2147483647' })).toBeInTheDocument();
  });

  // The router reuses the element across a change of the parameter. A new
  // number must start from "loading", and the first request's answer, if it
  // lands late, must not replace the second's.
  it('shows the request the address names now, not the one it named before', async () => {
    // Both lookups answer when the test says, so each step is observable.
    const pending = new Map<number, (cr: PullRequestSummary) => void>();
    api.getPullRequest.mockImplementation(
      (num: number) => new Promise<PullRequestSummary>((resolve) => pending.set(num, resolve)),
    );
    renderAt('/change-requests/276');
    expect(screen.getByText('Opening change request #276…')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Go to 277' }));
    expect(screen.getByText('Opening change request #277…')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    pending.get(277)!({ ...CR, number: 277, title: 'The next one' });
    expect(await screen.findByRole('dialog', { name: 'change request 277' })).toHaveTextContent('The next one');

    // The first answer, late: it belongs to an address the page has left.
    pending.get(276)!(CR);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'change request 276' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'change request 277' })).toHaveTextContent('The next one');
  });
});
