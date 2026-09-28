import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * "Only people with edit access can share this folder. Ask an owner: Ed." —
 * and now something to do about it.
 *
 * Three things are asserted here, because each of them is a way the surface
 * could lie:
 *  - the control appears exactly where a request can actually be made, and
 *    nowhere else (an editor, a draft branch, a change-request-only file, a
 *    file whose folder governs it);
 *  - nothing says "Requested" unless the server said the request exists — a
 *    failed send keeps the control and says why;
 *  - an editor's Accept is the dialog's own grant, and a refused one leaves
 *    the request on screen with its refusal, rather than in a toast this
 *    dialog has no host for.
 */

const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  grantAccess: vi.fn(),
  revokeAccess: vi.fn(),
  suggestPrincipals: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, ...api };
});

const requests = vi.hoisted(() => ({
  fetchAccessRequestStatus: vi.fn(),
  sendAccessRequest: vi.fn(),
  listAccessRequests: vi.fn(),
  reconcileAccessRequest: vi.fn(),
}));
vi.mock('../requests.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../requests.api')>();
  return { ...actual, ...requests };
});

const cancelPullRequest = vi.hoisted(() => vi.fn());
vi.mock('../../pr/services/pr-cancel.api', () => ({ cancelPullRequest }));

const workspace = vi.hoisted(() => ({ workspaceId: 'target-company-state' }));
vi.mock('../../workspace/state/workspace.context', () => ({
  useWorkspace: () => ({ workspaceId: workspace.workspaceId, kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth/state/auth.context', () => ({
  useAuth: () => ({ user: { email: 'rita@x.io', name: 'Rita' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const FOLDER: FileTreeEntry = {
  name: 'Research',
  relativePath: 'knowledge-base/Research',
  type: 'directory',
} as unknown as FileTreeEntry;
const PDF: FileTreeEntry = {
  name: 'Deck.pdf',
  relativePath: 'knowledge-base/Research/Deck.pdf',
  type: 'file',
} as unknown as FileTreeEntry;

const ED = { name: 'Ed', email: 'ed@x.io' };

/** Rita can read Research; Ed owns it. She cannot change its access. */
const READER_VIEW = {
  canRead: true,
  canWrite: false,
  canDownload: false,
  canOwner: false,
  eligible: { roles: [], users: [ED] },
  readers: { restricted: true, roles: [], users: [ED] },
  owners: { roles: [], users: [ED] },
  downloaders: { roles: [], users: [] },
  sources: {},
} as AccessResponse;

const EDITOR_VIEW = { ...READER_VIEW, canWrite: true } as AccessResponse;
const NO_OWNER_VIEW = { ...READER_VIEW, owners: { roles: [], users: [] } } as AccessResponse;

const RITA_PROPOSAL = {
  verb: 'owner' as const,
  id: 'user:rita@x.io',
  principal: { kind: 'user' as const, email: 'rita@x.io', displayName: 'Rita' },
  label: 'Rita',
};

const requestRow = (over: Record<string, unknown> = {}) => ({
  number: 77,
  branch: 'rita/join-research',
  requesterName: 'Rita',
  createdAt: '2026-01-01T00:00:00.000Z',
  proposals: [RITA_PROPOSAL],
  ...over,
});

const control = () => screen.queryByRole('button', { name: 'Request access' });

beforeEach(() => {
  vi.clearAllMocks();
  workspace.workspaceId = 'target-company-state';
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
  api.fetchFileAccess.mockResolvedValue(READER_VIEW);
  api.grantAccess.mockResolvedValue(EDITOR_VIEW);
  api.revokeAccess.mockResolvedValue(READER_VIEW);
  requests.fetchAccessRequestStatus.mockResolvedValue({ state: 'none' });
  requests.sendAccessRequest.mockResolvedValue({ number: 77, level: 'write' });
  requests.listAccessRequests.mockResolvedValue([]);
  requests.reconcileAccessRequest.mockResolvedValue(true);
  cancelPullRequest.mockResolvedValue(undefined);
});

describe('the person asking', () => {
  it('offers a level choice with Can edit selected, a note field and Request access', async () => {
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    expect(await screen.findByText(/Ask an owner: Ed\./)).toBeInTheDocument();

    const canEdit = await screen.findByRole('radio', { name: 'Can edit' });
    expect(canEdit).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Owner' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: /Why you need it/i })).toHaveAttribute(
      'maxlength',
      '500',
    );
    expect(control()).toBeInTheDocument();
  });

  it('sends the level chosen and the note, then says who it is waiting on', async () => {
    const user = userEvent.setup();
    requests.sendAccessRequest.mockResolvedValue({ number: 77, level: 'owner' });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(await screen.findByRole('radio', { name: 'Owner' }));
    await user.type(
      screen.getByRole('textbox', { name: /Why you need it/i }),
      'I maintain these pages now',
    );
    await user.click(control()!);

    await waitFor(() =>
      expect(requests.sendAccessRequest).toHaveBeenCalledWith('target-company-state', {
        path: FOLDER.relativePath,
        kind: 'folder',
        level: 'owner',
        note: 'I maintain these pages now',
      }),
    );
    // The control is GONE, replaced by what was asked and who answers it.
    expect(await screen.findByText('Requested: Owner. Waiting on Ed.')).toBeInTheDocument();
    expect(control()).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Can edit' })).not.toBeInTheDocument();
  });

  it('a double click sends once — the button waits for the answer', async () => {
    const user = userEvent.setup();
    let release: (value: { number: number; level: 'write' }) => void = () => {};
    requests.sendAccessRequest.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const button = await screen.findByRole('button', { name: 'Request access' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);

    expect(requests.sendAccessRequest).toHaveBeenCalledTimes(1);
    release({ number: 77, level: 'write' });
    expect(await screen.findByText('Requested: Can edit. Waiting on Ed.')).toBeInTheDocument();
  });

  it('shows the level the SERVER reports, not the one this tab typed', async () => {
    // Two tabs. This one sends Can edit while an Owner request is already
    // open; the server answers with that open request, Owner and all. Echoing
    // what was typed would caption somebody else's request with the wrong
    // level until the dialog was reopened.
    const user = userEvent.setup();
    requests.sendAccessRequest.mockResolvedValue({ number: 31, level: 'owner' });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Request access' }));

    expect(await screen.findByText('Requested: Owner. Waiting on Ed.')).toBeInTheDocument();
    expect(screen.queryByText(/Requested: Can edit/)).not.toBeInTheDocument();
  });

  it('shows the same line, and no control, when the dialog is reopened while the request is open', async () => {
    requests.fetchAccessRequestStatus.mockResolvedValue({
      state: 'pending',
      level: 'owner',
      number: 77,
    });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    expect(await screen.findByText('Requested: Owner. Waiting on Ed.')).toBeInTheDocument();
    expect(control()).not.toBeInTheDocument();
  });

  it('names the people who can edit its access when the item names no owner', async () => {
    api.fetchFileAccess.mockResolvedValue(NO_OWNER_VIEW);
    requests.fetchAccessRequestStatus.mockResolvedValue({ state: 'pending', level: 'write' });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    expect(
      await screen.findByText('Requested: Can edit. Waiting on the people who can edit its access.'),
    ).toBeInTheDocument();
  });

  it('a failed send says why and keeps the control — nothing reads as Requested', async () => {
    const user = userEvent.setup();
    requests.sendAccessRequest.mockRejectedValue(new Error('the server could not be reached'));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Request access' }));

    expect(
      await screen.findByText("Couldn't send your request: the server could not be reached."),
    ).toBeInTheDocument();
    expect(control()).toBeInTheDocument();
    expect(screen.queryByText(/^Requested:/)).not.toBeInTheDocument();
  });

  it('after a request closed without the access, offers a new one at the level chosen that time', async () => {
    const user = userEvent.setup();
    requests.fetchAccessRequestStatus.mockResolvedValue({
      state: 'not-accepted',
      level: 'owner',
      number: 31,
    });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    expect(
      await screen.findByText("Your last request for Owner wasn't accepted."),
    ).toBeInTheDocument();
    // The control is back, and it starts from Can edit again.
    expect(await screen.findByRole('radio', { name: 'Can edit' })).toBeChecked();
    await user.click(control()!);
    await waitFor(() =>
      expect(requests.sendAccessRequest).toHaveBeenCalledWith(
        'target-company-state',
        expect.objectContaining({ level: 'write' }),
      ),
    );
  });
});

describe('where no request control appears', () => {
  it('not for someone who can already edit the item', async () => {
    api.fetchFileAccess.mockResolvedValue(EDITOR_VIEW);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText(/On this folder/i);
    expect(control()).not.toBeInTheDocument();
    expect(screen.queryByText(/Only people with edit access/)).not.toBeInTheDocument();
    expect(requests.fetchAccessRequestStatus).not.toHaveBeenCalled();
  });

  it('not on a draft branch view', async () => {
    workspace.workspaceId = 'rita%2Fdraft';
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    expect(await screen.findByText(/Ask an owner: Ed\./)).toBeInTheDocument();
    expect(control()).not.toBeInTheDocument();
    expect(requests.fetchAccessRequestStatus).not.toHaveBeenCalled();
    expect(requests.listAccessRequests).not.toHaveBeenCalled();
  });

  it('not on a file that exists only in a change request', async () => {
    render(
      <ManageAccessDialog
        entry={{ ...FOLDER, name: 'New.md', relativePath: 'knowledge-base/Research/New.md', type: 'file' } as FileTreeEntry}
        proposal={{ number: 12, branch: 'rita/draft' }}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/Ask an owner: Ed\./)).toBeInTheDocument();
    expect(control()).not.toBeInTheDocument();
    expect(requests.fetchAccessRequestStatus).not.toHaveBeenCalled();
  });

  it('not on a file its folder governs — which keeps its pointer at the folder', async () => {
    api.fetchFileAccess.mockResolvedValue({ ...READER_VIEW, governedByFolder: 'Research' });
    const onManageAncestor = vi.fn();
    render(
      <ManageAccessDialog entry={PDF} onClose={() => {}} onManageAncestor={onManageAncestor} />,
    );
    expect(
      await screen.findByRole('button', { name: 'Manage access on Research' }),
    ).toBeInTheDocument();
    expect(control()).not.toBeInTheDocument();
    expect(requests.fetchAccessRequestStatus).not.toHaveBeenCalled();
  });
});

describe('the editors', () => {
  const asEditor = () => {
    api.fetchFileAccess.mockResolvedValue(EDITOR_VIEW);
    requests.listAccessRequests.mockResolvedValue([
      requestRow({ note: 'I maintain these pages now' }),
    ]);
  };

  it('shows one line per open request, with the note, Accept and Decline — and no Manage access link', async () => {
    asEditor();
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    expect(await screen.findByText(/Rita asked for access to Research:/)).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.getByText('I maintain these pages now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant Owner to Rita' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Decline the request from Rita' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
    expect(requests.listAccessRequests).toHaveBeenCalledWith('target-company-state', {
      path: FOLDER.relativePath,
      kind: 'folder',
    });
  });

  it('Accept is the dialog\'s own grant: the row is re-read, then the request is settled', async () => {
    const user = userEvent.setup();
    asEditor();
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Grant Owner to Rita' }));

    await waitFor(() =>
      expect(api.grantAccess).toHaveBeenCalledWith(encodeURIComponent(DEFAULT_BRANCH), {
        path: FOLDER.relativePath,
        kind: 'folder',
        verb: 'owner',
        principal: RITA_PROPOSAL.principal,
      }),
    );
    // The dialog re-reads its rows BEFORE the line goes, so the new row is on
    // screen by the time the request disappears.
    await waitFor(() => expect(api.fetchFileAccess.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(requests.reconcileAccessRequest).toHaveBeenCalledWith('target-company-state', 77, {
        path: FOLDER.relativePath,
        kind: 'folder',
      }),
    );
  });

  it('a failed Accept shows its error on that line, and the request stays', async () => {
    const user = userEvent.setup();
    asEditor();
    api.grantAccess.mockRejectedValue(new Error('You can no longer edit this folder'));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'Grant Owner to Rita' }));

    expect(await screen.findByText('You can no longer edit this folder')).toBeInTheDocument();
    expect(screen.getByText(/Rita asked for access to Research:/)).toBeInTheDocument();
    expect(requests.reconcileAccessRequest).not.toHaveBeenCalled();
  });

  it('Decline closes the change request and grants nothing', async () => {
    const user = userEvent.setup();
    asEditor();
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    await user.click(
      await screen.findByRole('button', { name: 'Decline the request from Rita' }),
    );

    await waitFor(() => expect(cancelPullRequest).toHaveBeenCalledWith(77));
    expect(api.grantAccess).not.toHaveBeenCalled();
  });
});
