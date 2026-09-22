import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * A ROW'S MENU IS TWO AXES, AND A CLICK MOVES ONE OF THEM.
 *
 * On core-staging, giving an editor "Can download" took their edit away, and
 * giving a downloader "Can edit" took their download away. Each item applied a
 * fixed whole set — Can edit meant "edit and no download", Can download meant
 * "download and no edit" — so raising one axis wrote a revoke or a denial on
 * the other, in the file, with no prompt.
 *
 * Now the tiers (Owner / Can edit / Can read) are one exclusive axis and
 * download is the other. Clicking an item changes ITS axis and leaves the other
 * alone; clicking the tier a row already holds steps it down one; an item with
 * nothing to do from where the row is renders disabled instead of writing a
 * no-op or a surprise. These tests drive the dialog through the real menu and
 * assert on what reaches the API, because that is where the bug lived.
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
const ALICE_PRINCIPAL = { kind: 'user', email: 'alice@x.com', displayName: 'Alice' };
const KEY = 'u:alice@x.com';
const HERE = { kind: 'direct' } as const;

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

/** Alice holds exactly these verbs, every one granted on this folder itself. */
function aliceWith(verbs: { owner?: boolean; write?: boolean; read?: boolean; download?: boolean }): AccessResponse {
  const owner = !!verbs.owner;
  const write = owner || !!verbs.write;
  const download = owner || !!verbs.download;
  const read = write || download || !!verbs.read;
  const sources: Record<string, unknown[]> = {};
  if (owner) sources.owner = [HERE];
  if (write) sources.write = [HERE];
  if (download) sources.download = [HERE];
  if (read) sources.read = [HERE];
  return {
    ...BLANK,
    eligible: { principals: [], roles: [], users: write ? [ALICE] : [] },
    readers: { restricted: true, principals: [], roles: [], users: read ? [ALICE] : [] },
    owners: { principals: [], roles: [], users: owner ? [ALICE] : [] },
    downloaders: { principals: [], roles: [], users: download ? [ALICE] : [] },
    sources: read ? { [KEY]: sources } : {},
  } as unknown as AccessResponse;
}

/** Open Alice's row menu (her trigger reads `summary`) and return the panel holding its items. */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  summary: RegExp,
): Promise<HTMLElement> {
  const triggers = await screen.findAllByRole('button', { name: summary });
  // The add-row selector can read the same words; a row's trigger is the later one.
  await user.click(triggers[triggers.length - 1]);
  return screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0]
    .parentElement as HTMLElement;
}

function item(menu: HTMLElement, label: RegExp): HTMLElement {
  return within(menu).getByRole('button', { name: label });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
});

describe('ManageAccessDialog row menu: download is its own axis', () => {
  it('Can download on an editor grants download and leaves edit alone', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ write: true }));
    api.grantAccess.mockResolvedValue(aliceWith({ write: true, download: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can edit$/i);
    await user.click(item(menu, /^can download$/i));

    // ONE write, a download grant. The bug was a revoke of `write` right here.
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith('ws-1', {
      path: FOLDER.relativePath,
      kind: 'folder',
      principal: ALICE_PRINCIPAL,
      verb: 'download',
    });
    expect(api.revokeAccess).not.toHaveBeenCalled();
    // And the row now says both, with both items checked.
    expect(await screen.findByRole('button', { name: /^can edit, can download$/i })).toBeInTheDocument();
    expect(item(menu, /^can edit$/i)).toHaveClass('font-medium');
    expect(item(menu, /^can download$/i)).toHaveClass('font-medium');
  });

  it('Can edit on a downloader grants edit and leaves download alone', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ download: true }));
    api.grantAccess.mockResolvedValue(aliceWith({ write: true, download: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can read, can download$/i);
    await user.click(item(menu, /^can edit$/i));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'write' }));
    // The other half of the bug: no revoke of `download`.
    expect(api.revokeAccess).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^can edit, can download$/i })).toBeInTheDocument();
  });

  it('Can download on a row that has it takes only download away', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ write: true, download: true }));
    api.revokeAccess.mockResolvedValue(aliceWith({ write: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can edit, can download$/i);
    await user.click(item(menu, /^can download$/i));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    // A local grant, so a plain revoke of that one verb — no deny line, no
    // touch on write.
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', {
      path: FOLDER.relativePath,
      kind: 'folder',
      principal: ALICE_PRINCIPAL,
      verb: 'download',
    });
    expect(api.grantAccess).not.toHaveBeenCalled();
    // The row's summary drops download, and in the still-open menu the item
    // unchecks while Can edit stays checked.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^can edit, can download$/i })).toBeNull(),
    );
    expect(item(menu, /^can download$/i)).not.toHaveClass('font-medium');
    expect(item(menu, /^can edit$/i)).toHaveClass('font-medium');
  });

  it('under Owner, Can download is conferred, not chosen: checked and disabled', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ owner: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    // An owner's summary still names download (the resolver folds it in);
    // the menu is where it reads as conferred rather than chosen.
    const menu = await openRowMenu(user, /^owner, can download$/i);
    const download = item(menu, /^can download$/i);
    expect(download).toHaveClass('font-medium');
    expect(download).toBeDisabled();
    // The tiers below Owner stay live: each is a demotion, which is an action.
    expect(item(menu, /^can edit$/i)).not.toBeDisabled();
    expect(item(menu, /^can read$/i)).not.toBeDisabled();
  });
});

describe('ManageAccessDialog row menu: the tiers are one axis', () => {
  it('clicking the held tier steps down one: Can edit becomes Can read, download untouched', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ write: true, download: true }));
    api.revokeAccess.mockResolvedValue(aliceWith({ download: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can edit, can download$/i);
    await user.click(item(menu, /^can edit$/i));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'write' }));
    expect(api.revokeAccess).not.toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'download' }));
    // Read is what download and the tier below edit both confer: nothing to grant.
    expect(api.grantAccess).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /^can read, can download$/i })).toBeInTheDocument();
  });

  it('clicking Owner on an owner steps down to Can edit, and the download Owner conferred goes with it', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ owner: true }));
    // Revoking the owner line leaves her with nothing here; the dialog then
    // writes the tier the step lands on.
    api.revokeAccess.mockResolvedValue(aliceWith({}));
    api.grantAccess.mockResolvedValue(aliceWith({ write: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^owner, can download$/i);
    await user.click(item(menu, /^owner$/i));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'owner' }));
    expect(api.grantAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'write' }));
    // She never held download on its own, so the demotion does not invent it.
    expect(api.grantAccess).not.toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'download' }));
    // The menu re-renders on the fresh view: Owner unchecked, Can edit checked,
    // and download — no longer conferred — unchecked and live again.
    await waitFor(() => expect(item(menu, /^owner$/i)).not.toHaveClass('font-medium'));
    expect(item(menu, /^can edit$/i)).toHaveClass('font-medium');
    expect(item(menu, /^can download$/i)).not.toHaveClass('font-medium');
    expect(item(menu, /^can download$/i)).not.toBeDisabled();
  });

  it('Can read at the top of a row has nothing below it: checked and disabled', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ download: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can read, can download$/i);
    const read = item(menu, /^can read$/i);
    expect(read).toHaveClass('font-medium');
    expect(read).toBeDisabled();
    // Taking read away is Remove or Deny's job; download stays a live toggle.
    expect(item(menu, /^can download$/i)).not.toBeDisabled();
    expect(item(menu, /^deny$/i)).not.toBeDisabled();
  });

  it('a tier above the held one is where the row goes, and download rides along', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(aliceWith({ download: true }));
    api.grantAccess.mockResolvedValue(aliceWith({ owner: true }));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const menu = await openRowMenu(user, /^can read, can download$/i);
    await user.click(item(menu, /^owner$/i));

    // One grant, the highest tier; owner carries download, so nothing is
    // revoked and nothing else is written.
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith('ws-1', expect.objectContaining({ verb: 'owner' }));
    expect(api.revokeAccess).not.toHaveBeenCalled();
  });
});
