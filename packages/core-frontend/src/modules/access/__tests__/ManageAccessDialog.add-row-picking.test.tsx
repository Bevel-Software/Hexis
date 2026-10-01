import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * PICKING SEVERAL PRINCIPALS IN A ROW.
 *
 * Customer feedback on the Manage access add row: after picking a group from
 * the list you had to click back into the field to type the next one, and a
 * group you had already picked was offered again as you typed. Two small
 * things, both in the way of the common case — sharing with a few groups at
 * once — and both fixed here: a pick puts the caret back in the field, and the
 * list offers only what is not already a chip.
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

const ENTRY: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: 'knowledge-base/Sales/Deal.md',
  type: 'file',
} as unknown as FileTreeEntry;

const EMPTY = {
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

const FIELD = 'Add people, groups, roles or plugins…';

/** The suggestion list (debounced, so awaited), located from an item that must be in it. */
async function listHolding(label: RegExp): Promise<HTMLElement> {
  return (await screen.findByRole('button', { name: label })).parentElement as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchFileAccess.mockResolvedValue(EMPTY);
  api.grantAccess.mockResolvedValue(EMPTY);
  // The server answers every query with BOTH teams: it does not know what
  // the dialog already holds as a chip, and it must not need to.
  api.suggestPrincipals.mockResolvedValue({
    roles: [],
    groups: ['GTM Team', 'Sales Team'],
    people: [{ name: 'Ana', email: 'ana@x.io' }],
    peopleWithheld: false,
  });
});

describe('ManageAccessDialog add row: picking several in a row', () => {
  it('a pick from the list puts the caret back in the field', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    const field = await screen.findByPlaceholderText(FIELD);

    await user.type(field, 'team');
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));

    // The chip is up, the query is cleared, and the NEXT name can be typed
    // without clicking into the white space first.
    expect(screen.getByRole('button', { name: 'Remove GTM Team' })).toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
  });

  it('a principal already picked is not offered again, whatever the server returns', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    const field = await screen.findByPlaceholderText(FIELD);

    await user.type(field, 'team');
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));
    await user.type(field, 'team');

    const list = await listHolding(/Sales Team/);
    expect(within(list).getByText('Sales Team')).toBeInTheDocument();
    expect(within(list).getByText('Ana')).toBeInTheDocument();
    expect(within(list).queryByText('GTM Team')).toBeNull();
  });

  it('removing the chip offers the principal again', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    const field = await screen.findByPlaceholderText(FIELD);

    await user.type(field, 'team');
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));
    await user.click(screen.getByRole('button', { name: 'Remove GTM Team' }));

    await user.type(field, 'team');
    const list = await listHolding(/Sales Team/);
    expect(within(list).getByText('GTM Team')).toBeInTheDocument();
  });

  it('when everything the server offers is already picked, no list opens', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: ['GTM Team'],
      people: [],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    const field = await screen.findByPlaceholderText(FIELD);

    await user.type(field, 'gtm');
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));
    await user.type(field, 'gtm');

    // The only match is the chip already in the field; an empty list would
    // be a box with nothing in it.
    expect(screen.queryByRole('button', { name: /^GT GTM Team/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /GTM Team/ })).toHaveLength(1); // the chip's Remove
  });
});
