import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

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
vi.mock('../../workspace/state/workspace.context', () => ({
  useWorkspace: () => ({ workspaceId: 'main', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth/state/auth.context', () => ({
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

/**
 * A file that exists only on an open change request's branch. Its access is
 * edited THERE — the rules land in the proposed file and merge with it — and
 * the sheet says so. Every other target keeps the ambient workspace and shows
 * no notice.
 */

const ENTRY: FileTreeEntry = {
  name: 'New.md',
  relativePath: 'knowledge-base/Sales/New.md',
  type: 'file',
} as unknown as FileTreeEntry;
const BRANCH = 'suggestions/me/knowledge';
const BRANCH_WS = encodeURIComponent(BRANCH);
const PROPOSAL = { number: 12, branch: BRANCH };
const NOTICE = /editing access on change request #12\. It takes effect when the request merges/i;
const A = { name: 'Alice', email: 'alice@x.com' };

/** Alice, granted `write` directly on the file. */
const VIEW = {
  canRead: true,
  canWrite: true,
  canDownload: false,
  canOwner: false,
  eligible: { roles: [], users: [A] },
  readers: { restricted: true, roles: [], users: [A] },
  owners: { roles: [], users: [] },
  downloaders: { roles: [], users: [] },
  sources: { 'u:alice@x.com': { read: [{ kind: 'direct' }], write: [{ kind: 'direct' }] } },
} as AccessResponse;

async function checkDownloadOnAlice(user: ReturnType<typeof userEvent.setup>) {
  const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
  await user.click(triggers[triggers.length - 1]);
  await user.click(await screen.findByRole('button', { name: /^can download$/i }));
}

describe('ManageAccessDialog: a proposed-only file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
    api.revokeAccess.mockResolvedValue(VIEW);
  });

  it('reads access from the proposal branch and shows the notice', async () => {
    render(<ManageAccessDialog entry={ENTRY} proposal={PROPOSAL} onClose={() => {}} />);

    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith(BRANCH_WS, 'Sales/New.md', 'file'),
    );
    expect(api.fetchFileAccess).not.toHaveBeenCalledWith('main', expect.anything(), expect.anything());
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
  });

  it('wins over a pinned workspace: the file is not on any other branch', async () => {
    render(
      <ManageAccessDialog entry={ENTRY} workspaceId="main" proposal={PROPOSAL} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith(BRANCH_WS, 'Sales/New.md', 'file'),
    );
  });

  it('grants on the proposal branch', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} proposal={PROPOSAL} onClose={() => {}} />);
    await checkDownloadOnAlice(user);

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith(
      BRANCH_WS,
      expect.objectContaining({ path: ENTRY.relativePath, kind: 'file', verb: 'download' }),
    );
  });

  it('revokes on the proposal branch — symmetric with grant', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} proposal={PROPOSAL} onClose={() => {}} />);
    // Remove sits beside the row's verb control, not inside its menu.
    await user.click(await screen.findByRole('button', { name: 'Remove access' }));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith(
      BRANCH_WS,
      expect.objectContaining({
        path: ENTRY.relativePath,
        principal: expect.objectContaining({ email: 'alice@x.com' }),
      }),
    );
  });

  it('surfaces a gate refusal from the proposal branch — never a silent success', async () => {
    const user = userEvent.setup();
    const { GitApiError } = await import('../../git/services/git.api');
    api.grantAccess.mockRejectedValue(
      new GitApiError(403, 'You need write access to Sales/New.md to change who can access it.', {}),
    );
    render(<ManageAccessDialog entry={ENTRY} proposal={PROPOSAL} onClose={() => {}} />);
    await checkDownloadOnAlice(user);

    expect(
      await screen.findByText(/You need write access to Sales\/New\.md/i),
    ).toBeInTheDocument();
    expect(api.grantAccess).toHaveBeenCalledWith(BRANCH_WS, expect.anything());
  });

  it('refuses to load when the request branch cannot be resolved, instead of editing another branch', async () => {
    render(
      <ManageAccessDialog entry={ENTRY} proposal={{ number: 12, branch: null }} onClose={() => {}} />,
    );
    expect(await screen.findByText(/branch of change request #12 could not be found/i)).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(api.fetchFileAccess).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^share$/i })).toBeNull();
  });
});

describe('ManageAccessDialog: an ordinary file (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
  });

  it('keeps the ambient workspace and shows no proposal notice', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith('main', 'Sales/New.md', 'file'),
    );
    expect(screen.queryByText(/editing access on change request/i)).toBeNull();

    await checkDownloadOnAlice(user);
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith('main', expect.anything());
  });
});
