import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * A FILE'S SHEET SHOWS THE DENY IT INHERITS, UNDER THE FOLDER IT COMES FROM.
 *
 * QA opened Manage access on `QAAccess/Deal.md` and expanded "People invited
 * to QAAccess": the QAEditors role read "Can edit", and qa-denied, whom the
 * folder denies edit by name, was nowhere. The server now reports such a
 * person in `deniedAbove`; these tests hold the sheet to giving them a row,
 * filed under the folder that denies them, saying so.
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
const FILE: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: `${KB}/QAAccess/Deal.md`,
  type: 'file',
} as unknown as FileTreeEntry;
const PARENT = 'QAAccess/access.md';
const DENIED = { name: 'QA Denied', email: 'qa-denied@x.com', hasAccount: true };
const EDITORS = { name: 'QAEditors', kind: 'role' as const };

/** The view of Deal.md: QAEditors edit from the folder, which denies qa-denied edit. */
const VIEW = {
  canRead: true,
  canWrite: true,
  canDownload: true,
  canOwner: true,
  eligible: { principals: [EDITORS], roles: ['QAEditors'], users: [] },
  readers: { restricted: true, principals: [EDITORS], roles: ['QAEditors'], users: [] },
  owners: { principals: [], roles: [], users: [] },
  downloaders: { principals: [], roles: [], users: [] },
  sources: {
    'r:qaeditors': {
      read: [{ kind: 'ancestor', path: PARENT }],
      write: [{ kind: 'ancestor', path: PARENT }],
    },
    'u:qa-denied@x.com': {},
  },
  denials: { 'u:qa-denied@x.com': { write: [{ kind: 'ancestor', path: PARENT }] } },
  deniedHere: { principals: [], users: [] },
  deniedAbove: { principals: [], users: [DENIED] },
} as unknown as AccessResponse;

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
});

async function expandFolderSection(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /People invited to QAAccess/ }));
}

describe('ManageAccessDialog: a deny inherited from a folder', () => {
  it('lists the person under the folder that denies them, saying where', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(VIEW);
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);
    await expandFolderSection(user);

    expect(await screen.findByText('QA Denied')).toBeInTheDocument();
    // Not "No access": the role may still let them read. The row says what is
    // known, the folder the restriction is written in.
    const trigger = screen.getByRole('button', { name: /^restricted in qaaccess$/i });
    expect(trigger).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^no access$/i })).toBeNull();

    // Verb by verb, the menu names the folder for the one that is off.
    await user.click(trigger);
    const menu = screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0].parentElement as HTMLElement;
    expect(within(menu).getByRole('button', { name: /^can edit$/i })).toHaveAttribute(
      'aria-description',
      'restricted in QAAccess',
    );
  });

  it('a group a folder denies gets its row the same way', async () => {
    const user = userEvent.setup();
    const GTM = { name: 'GTM Team', kind: 'group' as const };
    api.fetchFileAccess.mockResolvedValue({
      ...VIEW,
      sources: { 'r:qaeditors': VIEW.sources['r:qaeditors'], 'g:gtm team': {} },
      denials: { 'g:gtm team': { read: [{ kind: 'ancestor', path: PARENT }] } },
      deniedAbove: { principals: [GTM], users: [] },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);
    await expandFolderSection(user);

    expect(await screen.findByText('GTM Team')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^restricted in qaaccess$/i })).toBeInTheDocument();
  });

  it('an older server without deniedAbove renders as before', async () => {
    const user = userEvent.setup();
    const { deniedAbove: _omitted, ...older } = VIEW as AccessResponse & { deniedAbove: unknown };
    api.fetchFileAccess.mockResolvedValue(older);
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);
    await expandFolderSection(user);

    expect(await screen.findByText('QAEditors')).toBeInTheDocument();
    expect(screen.queryByText('QA Denied')).toBeNull();
  });
});
