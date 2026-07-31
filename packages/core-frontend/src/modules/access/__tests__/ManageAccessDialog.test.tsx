import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

// --- Mock the API module ----------------------------------------------------
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

// --- Mock the context hooks the dialog reads --------------------------------
vi.mock('../../workspace/state/workspace.context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth/state/auth.context', () => ({
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const KB = 'knowledge-base';
const ENTRY: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: `${KB}/Sales/Deal.md`,
  type: 'file',
} as unknown as FileTreeEntry;
const A = { name: 'Alice', email: 'alice@x.com' };

/** Open Alice's row dropdown and click its "Can edit" item (the LAST exact match
 * — the top add-row verb selector also reads "Can edit"). */
async function openAndUncheckEdit(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: /can edit, can download/i });
  await user.click(trigger);
  const editItems = await screen.findAllByRole('button', { name: /^can edit$/i });
  await user.click(editItems[editItems.length - 1]);
}

describe('ManageAccessDialog — unchecking an inherited verb on a mixed row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ groups: [], people: [], peopleWithheld: false });
  });

  it('write PURELY inherited (download direct): uncheck "Can edit" → 409 → opens prompt on FIRST click, revokes only write', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue({
      canRead: true, canWrite: true, canDownload: true, canOwner: true,
      eligible: { roles: [], users: [A] },
      readers: { restricted: true, roles: [], users: [A] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [A] },
      sources: {
        'u:alice@x.com': {
          read: [{ kind: 'ancestor', path: 'Sales/access.md' }],
          write: [{ kind: 'ancestor', path: 'Sales/access.md' }],
          download: [{ kind: 'direct' }],
        },
      },
    } as AccessResponse);
    const { GitApiError } = await import('../../git/services/git.api');
    api.revokeAccess.mockRejectedValue(
      new GitApiError(409, 'inherited', {
        kind: 'inherited', error: 'inherited',
        sources: { write: [{ kind: 'ancestor', path: 'Sales/access.md' }] },
      }),
    );

    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    await openAndUncheckEdit(user);

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'write' }));
    expect(api.revokeAccess).not.toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'read' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /remove from parent folder\?/i })).toBeInTheDocument(),
    );
  });

  it('write DIRECT + also inherited: uncheck "Can edit" → 200 strips direct, still inherited → chains to prompt on the FIRST click (no second click)', async () => {
    const user = userEvent.setup();
    // write is `[direct, ancestor]` — Alice is named on the file AND inherits write.
    api.fetchFileAccess.mockResolvedValue({
      canRead: true, canWrite: true, canDownload: true, canOwner: true,
      eligible: { roles: [], users: [A] },
      readers: { restricted: true, roles: [], users: [A] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [A] },
      sources: {
        'u:alice@x.com': {
          read: [{ kind: 'direct' }],
          write: [{ kind: 'direct' }, { kind: 'ancestor', path: 'Sales/access.md' }],
          download: [{ kind: 'direct' }],
        },
      },
    } as AccessResponse);
    // The 200 fresh view AFTER stripping the direct write: write now only inherited.
    api.revokeAccess.mockResolvedValue({
      canRead: true, canWrite: true, canDownload: true, canOwner: true,
      eligible: { roles: [], users: [A] },
      readers: { restricted: true, roles: [], users: [A] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [A] },
      sources: {
        'u:alice@x.com': {
          read: [{ kind: 'direct' }],
          write: [{ kind: 'ancestor', path: 'Sales/access.md' }], // direct gone, inherited remains
          download: [{ kind: 'direct' }],
        },
      },
    } as AccessResponse);

    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    await openAndUncheckEdit(user);

    // ONE revoke (verb: write), and the prompt opens WITHOUT a second click.
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'write' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /remove from parent folder\?/i })).toBeInTheDocument(),
    );
  });
});
