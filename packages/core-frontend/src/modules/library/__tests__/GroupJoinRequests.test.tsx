import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type { JoinRequest } from '../services/groups.api';

/**
 * The manager-side join-request surface.
 *
 * The behaviour that matters is that accepting is a GRANT, not a merge: one
 * proposal at a time, through the ordinary access API, leaving the request's
 * branch untouched. The request then settles itself server-side, which this
 * surface only has to ask about.
 */
const groupsMock = vi.hoisted(() => ({
  listJoinRequests: vi.fn(),
  reconcileJoinRequest: vi.fn(),
}));
vi.mock('../services/groups.api', () => ({
  listJoinRequests: groupsMock.listJoinRequests,
  reconcileJoinRequest: groupsMock.reconcileJoinRequest,
}));

const accessMock = vi.hoisted(() => ({ grantAccess: vi.fn() }));
vi.mock('../../access/api', () => ({ grantAccess: accessMock.grantAccess }));

const prMock = vi.hoisted(() => ({ cancelPullRequest: vi.fn() }));
vi.mock('../../pr/services/pr-cancel.api', () => ({
  cancelPullRequest: prMock.cancelPullRequest,
}));

import { LibraryToastProvider } from '../state/toast';
import { GroupJoinRequests } from '../components/GroupJoinRequests';

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
      <GroupJoinRequests group="GTM" folders={['Groups/GTM']} onManage={onManage} />
    </LibraryToastProvider>,
  );
  return { onManage };
}

describe('GroupJoinRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupsMock.listJoinRequests.mockResolvedValue([request()]);
    groupsMock.reconcileJoinRequest.mockResolvedValue(true);
    accessMock.grantAccess.mockResolvedValue({});
    prMock.cancelPullRequest.mockResolvedValue({});
  });

  it('names the requester and the exact grant being proposed', async () => {
    renderBanner();
    expect(await screen.findByText(/Ali Baba asked to join GTM/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Grant read to Ali Baba' }),
    ).toBeInTheDocument();
  });

  it('states the VERB when a request asks for more than read', async () => {
    // "asked to join" must never hide a write/owner request.
    groupsMock.listJoinRequests.mockResolvedValue([
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

  it('accepting GRANTS the one proposal on the default branch — it never merges', async () => {
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: 'Grant read to Ali Baba' }));
    await waitFor(() => expect(accessMock.grantAccess).toHaveBeenCalledTimes(1));
    // The grant lands on the DEFAULT branch — that is where "the list" lives.
    expect(accessMock.grantAccess).toHaveBeenCalledWith(encodeURIComponent(DEFAULT_BRANCH), {
      path: 'Groups/GTM',
      kind: 'folder',
      verb: 'read',
      principal: { kind: 'user', email: 'ali@bevel.software', displayName: 'Ali Baba' },
    });
    // Then it asks the server to settle the request now rather than waiting
    // for the next listing.
    await waitFor(() => expect(groupsMock.reconcileJoinRequest).toHaveBeenCalledWith('GTM', 7));
  });

  it('offers each proposal separately, so one request can be answered in parts', async () => {
    groupsMock.listJoinRequests.mockResolvedValue([
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

  it('declining rejects the change request', async () => {
    renderBanner();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Decline the request from Ali Baba' }),
    );
    await waitFor(() => expect(prMock.cancelPullRequest).toHaveBeenCalledWith(7));
    expect(accessMock.grantAccess).not.toHaveBeenCalled();
  });

  it('renders nothing when there is nothing pending', async () => {
    groupsMock.listJoinRequests.mockResolvedValue([]);
    const { container } = render(
      <LibraryToastProvider>
        <GroupJoinRequests group="GTM" folders={['Groups/GTM']} onManage={vi.fn()} />
      </LibraryToastProvider>,
    );
    await waitFor(() => expect(groupsMock.listJoinRequests).toHaveBeenCalled());
    expect(container.textContent).not.toContain('asked to join');
  });

  it('stays silent when the listing fails — a manager surface must not break the page', async () => {
    groupsMock.listJoinRequests.mockRejectedValue(new Error('boom'));
    const { container } = render(
      <LibraryToastProvider>
        <GroupJoinRequests group="GTM" folders={['Groups/GTM']} onManage={vi.fn()} />
      </LibraryToastProvider>,
    );
    await waitFor(() => expect(groupsMock.listJoinRequests).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
