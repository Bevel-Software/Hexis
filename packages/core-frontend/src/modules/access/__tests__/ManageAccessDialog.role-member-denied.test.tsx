import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * A PERSON DENIED ONE VERB IS NOT "NO ACCESS" WHILE THEY CAN READ.
 *
 * QA's case: `QAAccess/access.md` has `write: [QAEditors, deny QA Denied
 * <qa-denied@example.com>]` and qa-denied is a QAEditors member. They read
 * through the role, so no list names them as a holder; only the denial does.
 * The row held nothing and read "No access". The response below is the shape
 * the server now answers for that folder (`access-view.role-member-denied`
 * pins the server side): the row shows what they hold and names the denied verb.
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
// The workspace and the signed-in person, through each module's entry, which
// is where the dialog imports them from.
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth')>()),
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const FOLDER: FileTreeEntry = {
  name: 'QAAccess',
  relativePath: 'knowledge-base/QAAccess',
  type: 'directory',
} as unknown as FileTreeEntry;
const DENIED = { name: 'QA Denied', email: 'qa-denied@example.com' };
const EDITORS = { name: 'QAEditors', kind: 'role' as const };

/** The folder as the server reports it: QAEditors edit here, qa-denied's edit denied here. */
const ROLE_MEMBER_DENIED_WRITE = {
  canRead: true,
  canWrite: true,
  canDownload: true,
  canOwner: true,
  eligible: { principals: [EDITORS], roles: ['QAEditors'], users: [] },
  readers: { restricted: true, principals: [EDITORS], roles: ['QAEditors'], users: [] },
  owners: { principals: [], roles: [], users: [] },
  downloaders: { principals: [], roles: [], users: [] },
  sources: {
    'r:qaeditors': { read: [{ kind: 'direct' }], write: [{ kind: 'direct' }] },
    'u:qa-denied@example.com': {},
  },
  denials: { 'u:qa-denied@example.com': { write: [{ kind: 'direct' }] } },
  deniedHere: { principals: [], users: [DENIED] },
  holds: { 'u:qa-denied@example.com': { read: true, write: false, download: false, owner: false } },
} as unknown as AccessResponse;

/** The row for one person: the element holding their name and their controls. */
async function rowOf(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name);
  return label.closest('.py-2') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
});

describe('ManageAccessDialog: a role member denied write', () => {
  it('shows the read they hold and names edit as denied, never "No access"', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(ROLE_MEMBER_DENIED_WRITE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('QA Denied');
    const trigger = within(row).getByRole('button', { name: /^can read$/i });
    expect(within(row).getByText('edit denied')).toBeInTheDocument();
    expect(within(row).queryByText(/no access/i)).toBeNull();
    expect(within(row).queryByText(/denied here/i)).toBeNull();

    // The menu agrees: read held, edit restricted by the entry on this folder.
    await user.click(trigger);
    const canRead = screen.getAllByRole('button', { name: /^can read$/i }).slice(-1)[0];
    const menu = canRead.parentElement as HTMLElement;
    expect(within(menu).getByRole('button', { name: /^can read$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(within(menu).getByRole('button', { name: /^can edit$/i })).toHaveAttribute(
      'aria-description',
      'restricted here',
    );
    expect(within(menu).getByRole('button', { name: /^can edit$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a server that does not report holds leaves the row as it was: nothing invented', async () => {
    api.fetchFileAccess.mockResolvedValue({ ...ROLE_MEMBER_DENIED_WRITE, holds: undefined });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('QA Denied');
    expect(within(row).getByRole('button', { name: /^no access$/i })).toBeInTheDocument();
  });

  it('a person with no denial carries no denied note', async () => {
    const READER = { name: 'Plain Reader', email: 'reader@example.com' };
    api.fetchFileAccess.mockResolvedValue({
      ...ROLE_MEMBER_DENIED_WRITE,
      readers: { ...ROLE_MEMBER_DENIED_WRITE.readers, users: [READER] },
      sources: { ...ROLE_MEMBER_DENIED_WRITE.sources, 'u:reader@example.com': { read: [{ kind: 'direct' }] } },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('Plain Reader');
    expect(within(row).getByRole('button', { name: /^can read$/i })).toBeInTheDocument();
    expect(within(row).queryByText(/denied/i)).toBeNull();
  });

  it('a person denied every verb here reads "Denied here", with no per-verb note', async () => {
    api.fetchFileAccess.mockResolvedValue({
      ...ROLE_MEMBER_DENIED_WRITE,
      denials: {
        'u:qa-denied@example.com': {
          read: [{ kind: 'direct' }],
          write: [{ kind: 'direct' }],
          download: [{ kind: 'direct' }],
          owner: [{ kind: 'direct' }],
        },
      },
      holds: { 'u:qa-denied@example.com': { read: false, write: false, download: false, owner: false } },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('QA Denied');
    expect(within(row).getByRole('button', { name: /^denied here$/i })).toBeInTheDocument();
    expect(within(row).queryByText(/^(owner|edit|download|read)(, \w+)* denied$/)).toBeNull();
  });
});

describe('ManageAccessDialog: a viewer who cannot manage sees the same row', () => {
  it('a role member denied write reads "Can read" and "edit denied", never "No access"', async () => {
    api.fetchFileAccess.mockResolvedValue({ ...ROLE_MEMBER_DENIED_WRITE, canWrite: false, canOwner: false });
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('QA Denied');
    expect(within(row).queryByRole('button', { name: /^can read$/i })).toBeNull();
    expect(within(row).getByText('Can read')).toBeInTheDocument();
    expect(within(row).getByText('edit denied')).toBeInTheDocument();
    expect(within(row).queryByText(/no access/i)).toBeNull();
  });

  it('a person denied every verb reads "Denied here", not "No access"', async () => {
    api.fetchFileAccess.mockResolvedValue({
      ...ROLE_MEMBER_DENIED_WRITE,
      canWrite: false,
      canOwner: false,
      denials: {
        'u:qa-denied@example.com': {
          read: [{ kind: 'direct' }],
          write: [{ kind: 'direct' }],
          download: [{ kind: 'direct' }],
          owner: [{ kind: 'direct' }],
        },
      },
      holds: { 'u:qa-denied@example.com': { read: false, write: false, download: false, owner: false } },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    const row = await rowOf('QA Denied');
    expect(within(row).getByText('Denied here')).toBeInTheDocument();
    expect(within(row).queryByText(/no access/i)).toBeNull();
  });
});
