import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * THE ROW A WRITE JUST CHANGED STAYS ON SCREEN.
 *
 * Razvan, on the deployed sheet: Alice had edit from this folder and read from
 * a parent; picking Can read revoked the local edit — correctly — and Alice
 * vanished. Not removed: with only the parent's read left she files under
 * "People invited to <parent>", which is collapsed. The person being edited
 * must not disappear mid-edit, so the section the row lands in opens itself.
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
vi.mock('../../workspace/state/workspace.context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth/state/auth.context', () => ({
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const FOLDER: FileTreeEntry = {
  name: 'Deals',
  relativePath: 'knowledge-base/Sales/Deals',
  type: 'directory',
} as unknown as FileTreeEntry;
const ALICE = { name: 'Alice', email: 'alice@x.com' };
const PARENT = 'Sales/access.md';

const BLANK = {
  canRead: true,
  canWrite: true,
  canDownload: true,
  canOwner: true,
  eligible: { principals: [], roles: [], users: [] },
  readers: { restricted: true, principals: [], roles: [], users: [] },
  owners: { principals: [], roles: [], users: [] },
  downloaders: { principals: [], roles: [], users: [] },
  sources: {},
  denials: {},
  deniedHere: { principals: [], users: [] },
} as unknown as AccessResponse;

/** Alice: edit granted HERE, read from the parent as well — a row of this folder. */
const EDIT_HERE_READ_FROM_PARENT = {
  ...BLANK,
  eligible: { principals: [], roles: [], users: [ALICE] },
  readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
  sources: {
    'u:alice@x.com': {
      write: [{ kind: 'direct' }],
      read: [{ kind: 'direct' }, { kind: 'ancestor', path: PARENT }],
    },
  },
} as unknown as AccessResponse;

/** After the local edit is revoked: only the parent's read remains — an inherited row. */
const READ_FROM_PARENT_ONLY = {
  ...BLANK,
  readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
  sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: PARENT }] } },
} as unknown as AccessResponse;

function parentSection(): HTMLElement {
  return screen.getByRole('button', { name: /People invited to Sales/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
});

describe('ManageAccessDialog: the edited row stays on screen', () => {
  it('a row that moves under a parent after a menu pick opens that parent\'s section', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_HERE_READ_FROM_PARENT);
    api.revokeAccess.mockResolvedValue(READ_FROM_PARENT_ONLY);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');
    // Before: she is a row of this folder, and no parent section is open.
    expect(screen.queryByRole('button', { name: /People invited to Sales/ })).toBeNull();

    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    await user.click(triggers[triggers.length - 1]);
    const menu = screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0]
      .parentElement as HTMLElement;
    await user.click(within(menu).getByRole('button', { name: /^can read$/i }));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    // After: the parent's section exists AND is open, with Alice inside it —
    // nobody had to find and click it.
    await waitFor(() => expect(parentSection()).toHaveAttribute('aria-expanded', 'true'));
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // And she is no longer listed as a row of this folder.
    expect(screen.getByText(/No one is granted directly here/i)).toBeInTheDocument();
  });

  it('a row that moves under a parent after Remove is revealed too, behind the "Remove from parent?" prompt', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_HERE_READ_FROM_PARENT);
    api.revokeAccess.mockResolvedValue(READ_FROM_PARENT_ONLY);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: 'Remove access' }));
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    // The chained prompt offers to finish the job; declining it must not leave
    // her hidden in a closed section.
    const prompt = await screen.findByRole('heading', { name: /remove from parent folder\?/i });
    expect(prompt).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(parentSection()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('a row that stays on this folder leaves the sections as they were', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_HERE_READ_FROM_PARENT);
    // Granting owner keeps her a row of this folder.
    api.grantAccess.mockResolvedValue({
      ...EDIT_HERE_READ_FROM_PARENT,
      owners: { principals: [], roles: [], users: [ALICE] },
      downloaders: { principals: [], roles: [], users: [ALICE] },
      sources: {
        'u:alice@x.com': {
          owner: [{ kind: 'direct' }],
          write: [{ kind: 'direct' }],
          download: [{ kind: 'direct' }],
          read: [{ kind: 'direct' }, { kind: 'ancestor', path: PARENT }],
        },
      },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    await user.click(triggers[triggers.length - 1]);
    const menu = screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0]
      .parentElement as HTMLElement;
    await user.click(within(menu).getByRole('button', { name: /^owner$/i }));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: /^owner, can download$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /People invited to Sales/ })).toBeNull();
  });
});
