import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * Download implies read, and the dialog says so.
 *
 * The resolver folds a `download:` grant into `read` server-side, so the two
 * boxes can never disagree in the file — the dialog has to render Read as
 * checked-and-implied under Download, the way it already does under Edit, and
 * must not write a redundant second `read:` line for a grant that already
 * carries one.
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

const KB = 'knowledge-base';
const ENTRY: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: `${KB}/Sales/Deal.md`,
  type: 'file',
} as unknown as FileTreeEntry;
const A = { name: 'Alice', email: 'alice@x.com' };

const EMPTY: AccessResponse = {
  canRead: true,
  canWrite: true,
  canDownload: true,
  canOwner: true,
  eligible: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  owners: { roles: [], users: [] },
  downloaders: { roles: [], users: [] },
  sources: {},
} as unknown as AccessResponse;

/** The add-row verb menu, opened from its summary trigger. */
async function openNewGrantMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const trigger = await screen.findByRole('button', { name: /^can edit$/i });
  await user.click(trigger);
  return screen.getByRole('button', { name: /^can download$/i }).parentElement as HTMLElement;
}

describe('ManageAccessDialog: Download carries Read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: ['GTM Team'],
      people: [],
      peopleWithheld: false,
    });
    api.fetchFileAccess.mockResolvedValue(EMPTY);
    api.grantAccess.mockResolvedValue(EMPTY);
  });

  it('on a NEW grant: ticking Can download checks Can read and greys it, and the summary says both', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const menu = await openNewGrantMenu(user);
    // Start from Edit (the default) turned off, so nothing but Download can
    // be what checks Read.
    await user.click(within(menu).getByRole('button', { name: /^can edit$/i }));
    expect(within(menu).getByRole('button', { name: /^can read$/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(within(menu).getByRole('button', { name: /^can download$/i }));

    const readItem = within(menu).getByRole('button', { name: /^can read$/i });
    expect(readItem).toHaveAttribute('aria-pressed', 'true');
    expect(readItem).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(
      await screen.findByRole('button', { name: /^can read, can download$/i }),
    ).toBeInTheDocument();
  });

  it('grants Download alone — no redundant second read grant, since download carries it', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const menu = await openNewGrantMenu(user);
    await user.click(within(menu).getByRole('button', { name: /^can edit$/i }));
    await user.click(within(menu).getByRole('button', { name: /^can download$/i }));
    await user.keyboard('{Escape}');

    await user.type(
      await screen.findByPlaceholderText('Add people, groups, roles or plugins…'),
      'gtm',
    );
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));
    await user.click(screen.getByRole('button', { name: /^Share$/ }));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'download', principal: { kind: 'group', group: 'GTM Team' } }),
    );
  });

  it('Everyone picked with Can download alone: one public read grant, no failure', async () => {
    const user = userEvent.setup();
    // `everyone` is public-read only (the backend refuses any other verb), so
    // the dialog clamps it to read and says so plainly, up front, while the
    // chip is up. Download-only used to be the one pick that clamped to
    // NOTHING and failed after the fact; now that Download carries Read it
    // clamps like every other pick.
    api.suggestPrincipals.mockResolvedValue({
      roles: ['everyone'],
      groups: [],
      people: [],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const menu = await openNewGrantMenu(user);
    await user.click(within(menu).getByRole('button', { name: /^can edit$/i }));
    await user.click(within(menu).getByRole('button', { name: /^can download$/i }));
    await user.keyboard('{Escape}');

    await user.type(
      await screen.findByPlaceholderText('Add people, groups, roles or plugins…'),
      'every',
    );
    await user.click(await screen.findByRole('button', { name: /everyone/i }));
    await user.click(screen.getByRole('button', { name: /^Share$/ }));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'read', principal: { kind: 'role', role: 'everyone' } }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('on an EXISTING row whose only grant is download: Read reads as checked and implied', async () => {
    const user = userEvent.setup();
    // A server that has not folded yet (`readers` empty): the row must still
    // show Read, because the grant the file holds confers it.
    api.fetchFileAccess.mockResolvedValue({
      ...EMPTY,
      downloaders: { roles: [], users: [A] },
      sources: { 'u:alice@x.com': { download: [{ kind: 'direct' }], read: [{ kind: 'direct' }] } },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    await screen.findByText('Alice');

    const rowTrigger = await screen.findByRole('button', { name: /^can read, can download$/i });
    await user.click(rowTrigger);
    const menu = screen.getAllByRole('button', { name: /^can download$/i }).slice(-1)[0]
      .parentElement as HTMLElement;
    const readItem = within(menu).getByRole('button', { name: /^can read$/i });
    expect(readItem).toBeDisabled();
    expect(within(menu).getByRole('button', { name: /^can download$/i })).not.toBeDisabled();
  });
});
