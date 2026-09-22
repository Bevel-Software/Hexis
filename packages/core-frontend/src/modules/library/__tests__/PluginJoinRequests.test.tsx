import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type { JoinRequest } from '../services/plugins.api';

/**
 * The manager-side join-request surface.
 *
 * The behaviour that matters is that accepting is a GRANT, not a merge: one
 * proposal at a time, through the ordinary access API, leaving the request's
 * branch untouched. The request then settles itself server-side, which this
 * surface only has to ask about.
 */
const pluginsMock = vi.hoisted(() => ({
  listJoinRequests: vi.fn(),
  reconcileJoinRequest: vi.fn(),
}));
vi.mock('../services/plugins.api', () => ({
  listJoinRequests: pluginsMock.listJoinRequests,
  reconcileJoinRequest: pluginsMock.reconcileJoinRequest,
}));

const accessMock = vi.hoisted(() => ({ grantAccess: vi.fn() }));
vi.mock('../../access/api', () => ({ grantAccess: accessMock.grantAccess }));

const prMock = vi.hoisted(() => ({ cancelPullRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: prMock.cancelPullRequest,
}));

import { LibraryToastProvider } from '../state/toast';
import { PluginJoinRequests } from '../components/PluginJoinRequests';

const request = (over: Partial<JoinRequest> = {}): JoinRequest => ({
  number: 7,
  branch: 'ali/join-gtm-abc1234',
  requesterName: 'Ali Baba',
  createdAt: '2026-01-01T00:00:00.000Z',
  proposals: [
    {
      verb: 'read',
      id: 'user:ali@bevel.software',
      principal: { kind: 'user', email: 'ali@bevel.software', displayName: 'Ali Baba' },
      label: 'Ali Baba',
    },
  ],
  ...over,
});

function renderBanner(onManage = vi.fn()) {
  render(
    <LibraryToastProvider>
      <PluginJoinRequests plugin="GTM" folders={['Plugins/GTM']} onManage={onManage} />
    </LibraryToastProvider>,
  );
  return { onManage };
}

describe('PluginJoinRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pluginsMock.listJoinRequests.mockResolvedValue([request()]);
    pluginsMock.reconcileJoinRequest.mockResolvedValue(true);
    accessMock.grantAccess.mockResolvedValue({});
    prMock.cancelPullRequest.mockResolvedValue({});
  });

  it('names the requester and the exact grant being proposed', async () => {
    renderBanner();
    expect(await screen.findByText(/Ali Baba asked for access to GTM/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Grant read to Ali Baba' }),
    ).toBeInTheDocument();
  });

  it('states the VERB when a request asks for more than read', async () => {
    // "asked for access to" must never hide a write/owner request.
    pluginsMock.listJoinRequests.mockResolvedValue([
      request({
        proposals: [
          {
            verb: 'write',
            id: 'role:finance team',
            principal: { kind: 'role', role: 'Finance Team' },
            label: 'Finance Team',
          },
        ],
      }),
    ]);
    renderBanner();
    expect(
      await screen.findByRole('button', { name: 'Grant write to Finance Team' }),
    ).toBeInTheDocument();
  });

  it('accepting GRANTS the one proposal on the default branch. It never merges', async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Grant read to Ali Baba' }));
    await waitFor(() => expect(accessMock.grantAccess).toHaveBeenCalledTimes(1));
    // The grant lands on the DEFAULT branch — that is where "the list" lives.
    expect(accessMock.grantAccess).toHaveBeenCalledWith(encodeURIComponent(DEFAULT_BRANCH), {
      path: 'Plugins/GTM',
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'user', email: 'ali@bevel.software', displayName: 'Ali Baba' },
    });
    // Then it asks the server to settle the request now rather than waiting
    // for the next listing.
    await waitFor(() => expect(pluginsMock.reconcileJoinRequest).toHaveBeenCalledWith('GTM', 7));
  });

  it('offers each proposal separately, so one request can be answered in parts', async () => {
    pluginsMock.listJoinRequests.mockResolvedValue([
      request({
        proposals: [
          ...request().proposals,
          {
            verb: 'read',
            id: 'user:juan@bevel.software',
            principal: { kind: 'user', email: 'juan@bevel.software', displayName: 'Juan Viera' },
            label: 'Juan Viera',
          },
        ],
      }),
    ]);
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Grant read to Juan Viera' }));
    await waitFor(() => expect(accessMock.grantAccess).toHaveBeenCalledTimes(1));
    expect(accessMock.grantAccess.mock.calls[0][1]).toMatchObject({
      principal: { email: 'juan@bevel.software' },
    });
  });

  it('a failed grant keeps the proposal on offer and never asks to reconcile', async () => {
    // The optimistic removal must not survive a grant that didn't land — the
    // refetch restores the row, and reconciling would be asking the server to
    // settle a request whose proposal is still pending.
    accessMock.grantAccess.mockRejectedValue(new Error('Not allowed'));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Grant read to Ali Baba' }));
    await waitFor(() => expect(accessMock.grantAccess).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole('button', { name: 'Grant read to Ali Baba' }),
    ).toBeInTheDocument();
    expect(pluginsMock.reconcileJoinRequest).not.toHaveBeenCalled();
  });

  it('declining rejects the change request', async () => {
    renderBanner();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Decline the request from Ali Baba' }),
    );
    await waitFor(() => expect(prMock.cancelPullRequest).toHaveBeenCalledWith(7));
    expect(accessMock.grantAccess).not.toHaveBeenCalled();
  });

  it('renders nothing when there is nothing pending', async () => {
    pluginsMock.listJoinRequests.mockResolvedValue([]);
    const { container } = render(
      <LibraryToastProvider>
        <PluginJoinRequests plugin="GTM" folders={['Plugins/GTM']} onManage={vi.fn()} />
      </LibraryToastProvider>,
    );
    await waitFor(() => expect(pluginsMock.listJoinRequests).toHaveBeenCalled());
    expect(container.textContent).not.toContain('asked for access to');
  });

  it('stays silent when the listing fails. A manager surface must not break the page', async () => {
    pluginsMock.listJoinRequests.mockRejectedValue(new Error('boom'));
    const { container } = render(
      <LibraryToastProvider>
        <PluginJoinRequests plugin="GTM" folders={['Plugins/GTM']} onManage={vi.fn()} />
      </LibraryToastProvider>,
    );
    await waitFor(() => expect(pluginsMock.listJoinRequests).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /**
   * The answers sit where the question is. Accept and Decline used to sit on
   * separate lines, and Manage access was a button on a line of its own.
   */
  describe('layout', () => {
    /** The line (flex row) a control sits on. */
    const lineOf = (el: HTMLElement) => el.closest('div.flex-wrap') as HTMLElement;

    it('puts Accept then Decline at the end of the line naming the requester', async () => {
      renderBanner();
      const text = await screen.findByText(/Ali Baba asked for access to GTM/);
      const accept = screen.getByRole('button', { name: 'Grant read to Ali Baba' });
      const decline = screen.getByRole('button', { name: 'Decline the request from Ali Baba' });
      expect(lineOf(accept)).toBe(lineOf(text));
      expect(lineOf(decline)).toBe(lineOf(text));
      expect(accept.compareDocumentPosition(decline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(text).toHaveTextContent('Ali Baba asked for access to GTM: read');
    });

    it('with several proposals, each proposal line ends in its own Accept and the request line in Decline', async () => {
      pluginsMock.listJoinRequests.mockResolvedValue([
        request({
          proposals: [
            ...request().proposals,
            {
              verb: 'write',
              id: 'user:juan@bevel.software',
              principal: { kind: 'user', email: 'juan@bevel.software', displayName: 'Juan Viera' },
              label: 'Juan Viera',
            },
          ],
        }),
      ]);
      renderBanner();
      const requestLine = lineOf(await screen.findByText('Ali Baba asked for access to GTM.'));
      expect(within(requestLine).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
        'Decline the request from Ali Baba',
      ]);
      const ali = screen.getByRole('button', { name: 'Grant read to Ali Baba' });
      const juan = screen.getByRole('button', { name: 'Grant write to Juan Viera' });
      expect(lineOf(ali)).not.toBe(requestLine);
      expect(lineOf(juan)).not.toBe(lineOf(ali));
      expect(lineOf(juan)).toHaveTextContent('Juan Viera: write');
    });

    it('Manage access is a text link closing the last line, and opens the plugin folder', async () => {
      const { onManage } = renderBanner();
      const accept = await screen.findByRole('button', { name: 'Grant read to Ali Baba' });
      const manage = screen.getByRole('button', { name: 'Manage access' });
      // Not a line of its own: it shares the requester's line, after the answers.
      expect(lineOf(manage)).toBe(lineOf(accept));
      const decline = screen.getByRole('button', { name: 'Decline the request from Ali Baba' });
      expect(decline.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(manage.className).toContain('underline');
      fireEvent.click(manage);
      expect(onManage).toHaveBeenCalledWith('Plugins/GTM');
    });
  });
});
