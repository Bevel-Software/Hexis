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

describe('ManageAccessDialog: unchecking an inherited verb on a mixed row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ plugins: [], people: [], peopleWithheld: false });
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

/**
 * Which BRANCH an access edit lands on.
 *
 * The file explorer edits the branch the user is looking at, so the ambient
 * workspace is the right default and stays the default. The Library is the
 * other case entirely: it describes the default branch no matter which branch
 * happens to be open, so a plugin's access edit has to be pinned. Without the
 * pin the same click would splice `access.md` on a draft — a rule that looks
 * written and governs nothing.
 */
describe('ManageAccessDialog: which workspace the edit targets', () => {
  const PINNED = 'target-company-state';

  /** Alice, granted `write` directly here — one row, one editable checklist. */
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

  /** Check "Can download" on Alice's row — the shortest path to a grant call. */
  async function grantDownloadToAlice(user: ReturnType<typeof userEvent.setup>) {
    // The add-row's verb selector also reads "Can edit"; Alice's row trigger is
    // the later one in the DOM.
    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    await user.click(triggers[triggers.length - 1]);
    await user.click(await screen.findByRole('button', { name: /^can download$/i }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ plugins: [], people: [], peopleWithheld: false });
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
  });

  it('reads and writes the workspace given by the prop, not the ambient one', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} workspaceId={PINNED} onClose={() => {}} />);

    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith(PINNED, 'Sales/Deal.md', 'file'),
    );
    expect(api.fetchFileAccess).not.toHaveBeenCalledWith('ws-1', expect.anything(), expect.anything());

    await grantDownloadToAlice(user);

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith(
      PINNED,
      expect.objectContaining({ verb: 'download' }),
    );
  });

  it('falls back to the ambient workspace when the prop is absent', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await waitFor(() =>
      expect(api.fetchFileAccess).toHaveBeenCalledWith('ws-1', 'Sales/Deal.md', 'file'),
    );

    await grantDownloadToAlice(user);

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'download' }));
  });
});

// ── the sheet's two headings, and what they name ──
//
// The direct section used to read "People with access" and every inherited
// grant collapsed into one "Inherited access (N) — from parent folders &
// roles" disclosure. Both were named after the CONCEPT rather than the thing:
// the reader could not tell which of the two lists was the rule set HERE, and
// a merged inherited list threw away the only fact that makes an inherited
// grant actionable — which folder to go and edit (proto:3625, 3637-3649).
describe('ManageAccessDialog: naming the rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ users: [], plugins: [], peopleWithheld: false });
  });

  /** The real AccessResponse shape — see the passing fixture above. */
  const view = (over: Partial<AccessResponse> = {}): AccessResponse =>
    ({
      canRead: true,
      canWrite: true,
      canDownload: false,
      canOwner: false,
      eligible: { roles: [], users: [] },
      readers: { restricted: true, roles: [], users: [] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [] },
      sources: {},
      ...over,
    }) as AccessResponse;

  it('names the target in the direct heading, not the concept', async () => {
    api.fetchFileAccess.mockResolvedValue(view());
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    expect(await screen.findByRole('heading', { name: /On this file/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /People with access/i })).not.toBeInTheDocument();
  });

  it('gives each granting folder its own plugin, named after the folder', async () => {
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [A, { name: 'Bo', email: 'bo@x.com' }] },
        sources: {
          'u:alice@x.com': { read: [{ kind: 'ancestor', path: 'Sales/access.md' }] },
          'u:bo@x.com': { read: [{ kind: 'ancestor', path: 'Sales/EMEA/access.md' }] },
        },
      }),
    );
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    // One disclosure per folder — never one merged "Inherited access".
    expect(await screen.findByRole('button', { name: /People invited to EMEA/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /People invited to Sales/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Inherited access/ })).not.toBeInTheDocument();
  });

  it('offers a way to the folder that owns the rule, and retargets the sheet', async () => {
    const user = userEvent.setup();
    const onManageAncestor = vi.fn();
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [A] },
        sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: 'Sales/access.md' }] } },
      }),
    );
    render(
      <ManageAccessDialog entry={ENTRY} onClose={() => {}} onManageAncestor={onManageAncestor} />,
    );

    await user.click(await screen.findByRole('button', { name: /People invited to Sales/ }));
    await user.click(await screen.findByRole('button', { name: /Manage Sales →/ }));

    // The path handed back is workspace-relative, which is what the dialog takes.
    expect(onManageAncestor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sales', relativePath: `${KB}/Sales`, type: 'directory' }),
    );
  });

  it('does not offer the link when the caller cannot retarget', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [A] },
        sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: 'Sales/access.md' }] } },
      }),
    );
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /People invited to Sales/ }));
    expect(screen.queryByRole('button', { name: /Manage Sales →/ })).not.toBeInTheDocument();
  });
});
