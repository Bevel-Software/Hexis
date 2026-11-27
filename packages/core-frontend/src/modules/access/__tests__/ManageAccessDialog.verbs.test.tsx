import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BRANCH, type FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * Can read, Can edit, Can download and Owner each say what they let someone
 * do where a person meets them: a visible line under each verb in an opened
 * picker (the add field's, each row's, and a read-only row's) and under each
 * request choice, and the accessible description of the verbs shown, the
 * closed verb buttons included. The closed dialog shows none of the lines.
 */

const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  grantAccess: vi.fn(),
  revokeAccess: vi.fn(),
  suggestPrincipals: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  ...api,
}));

const requests = vi.hoisted(() => ({
  fetchAccessRequestStatus: vi.fn(),
  sendAccessRequest: vi.fn(),
  listAccessRequests: vi.fn(),
  reconcileAccessRequest: vi.fn(),
}));
vi.mock('../requests.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../requests.api')>()),
  ...requests,
}));

// The dialog's own contexts, through the modules' entries. The live
// workspace, so a reader who cannot edit is offered the request control.
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useWorkspace: () => ({ workspaceId: encodeURIComponent(DEFAULT_BRANCH), kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth')>()),
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

const FILE: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: 'knowledge-base/Sales/Deal.md',
  type: 'file',
} as unknown as FileTreeEntry;

const READ = 'Open and read it';
const EDIT = 'Read, change, approve, manage access; no download';
const DOWNLOAD = 'Read and save a copy';
const OWNER = 'Can edit and download; the one people ask';

/** Each verb under the name the pickers show for it. */
const VERB_LINES: [string, string][] = [
  ['Owner', OWNER],
  ['Can edit', EDIT],
  ['Can read', READ],
  ['Can download', DOWNLOAD],
];

const ALICE = { name: 'Alice', email: 'alice@x.com' };
const BO = { name: 'Bo', email: 'bo@x.com' };
const ED = { name: 'Ed', email: 'ed@x.com' };

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

/** What a reader who cannot change the item sees: Ed owns it, Alice reads, Bo reads and downloads. */
const READER_VIEW = view({
  canWrite: false,
  eligible: { roles: [], users: [ED] },
  readers: { restricted: true, roles: [], users: [ED, ALICE, BO] },
  owners: { roles: [], users: [ED] },
  downloaders: { roles: [], users: [BO] },
  sources: {
    'u:alice@x.com': { read: [{ kind: 'direct' }] },
    'u:bo@x.com': { download: [{ kind: 'direct' }] },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
  requests.fetchAccessRequestStatus.mockResolvedValue({ state: 'none' });
  requests.listAccessRequests.mockResolvedValue([]);
});

describe('ManageAccessDialog: what each access verb means', () => {
  it('the closed dialog shows none of the lines', async () => {
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [ALICE] },
        sources: { 'u:alice@x.com': { read: [{ kind: 'direct' }] } },
      }),
    );
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    await screen.findByText('Alice');
    for (const [, line] of VERB_LINES) expect(screen.queryByText(line)).toBeNull();
  });

  it("the closed verb buttons carry their verbs' lines as their description", async () => {
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [ALICE, BO] },
        downloaders: { roles: [], users: [BO] },
        sources: {
          'u:alice@x.com': { read: [{ kind: 'direct' }] },
          'u:bo@x.com': { download: [{ kind: 'direct' }] },
        },
      }),
    );
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    // The add field's button, and each row's; each says whether its menu is open.
    const add = await screen.findByRole('button', { name: 'Can edit' });
    expect(add).toHaveAccessibleDescription(EDIT);
    expect(add).toHaveAttribute('aria-expanded', 'false');
    const row = screen.getByRole('button', { name: 'Can read' });
    expect(row).toHaveAccessibleDescription(READ);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    // A row naming two verbs says which line is whose.
    expect(screen.getByRole('button', { name: 'Can read, Can download' })).toHaveAccessibleDescription(
      `Can read: ${READ}. Can download: ${DOWNLOAD}`,
    );
  });

  it("shows each verb's line under it in the add field's opened picker", async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(view());
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    const trigger = await screen.findByRole('button', { name: 'Can edit' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('button', { name: 'Can download' }).parentElement as HTMLElement;
    for (const [name, line] of VERB_LINES) {
      // Named by the verb alone; the line is visible inside it and is its description.
      const item = within(menu).getByRole('button', { name });
      expect(within(item).getByText(line)).toBeVisible();
      expect(item).toHaveAccessibleDescription(line);
      expect(item).not.toHaveAttribute('title');
    }
  });

  it("shows each verb's line under it in a grantee row's opened picker, after the row's own note", async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [ALICE] },
        sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: 'Sales/access.md' }] } },
      }),
    );
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /People invited to Sales/ }));
    await user.click(screen.getByRole('button', { name: 'Can read' }));
    const menu = screen.getByRole('button', { name: 'Deny' }).parentElement as HTMLElement;
    for (const [name, line] of VERB_LINES) {
      const item = within(menu).getByRole('button', { name });
      expect(within(item).getByText(line)).toBeVisible();
      expect(item).not.toHaveAttribute('title');
      // Alice's read comes from Sales: the row says so first, then what read means.
      expect(item).toHaveAccessibleDescription(name === 'Can read' ? `from Sales. ${line}` : line);
    }
  });

  it('a reader who cannot edit sees each request choice with its line, and the note names the action as the title does', async () => {
    api.fetchFileAccess.mockResolvedValue(READER_VIEW);
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    // A line under EACH choice, before anything is chosen: the two can be compared.
    for (const [name, line] of [
      ['Can edit', EDIT],
      ['Owner', OWNER],
    ]) {
      const radio = await screen.findByRole('radio', { name });
      expect(radio).toHaveAccessibleDescription(line);
      expect(screen.getByText(line)).toBeVisible();
    }
    expect(screen.getByRole('dialog', { name: 'Manage access' })).toBeInTheDocument();
    expect(screen.getByText(/^Only people with edit access can manage access here\./)).toBeInTheDocument();
  });

  it("a reader who cannot edit opens a row's verbs read-only from the keyboard: every line shown, nothing to change", async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(READER_VIEW);
    render(<ManageAccessDialog entry={FILE} onClose={() => {}} />);

    const trigger = await screen.findByRole('button', { name: 'Can read, Can download' });
    expect(screen.queryByText(READ)).toBeNull();
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const menu = screen.getByRole('button', { name: 'Can download' }).parentElement as HTMLElement;
    for (const [name, line] of VERB_LINES) {
      const item = within(menu).getByRole('button', { name });
      expect(within(item).getByText(line)).toBeVisible();
      expect(item).toHaveAccessibleDescription(line);
      // Unavailable, yet focusable, so its line reaches assistive tech.
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).not.toBeDisabled();
    }
    // No Deny, and pressing an item writes nothing.
    expect(within(menu).queryByRole('button', { name: 'Deny' })).toBeNull();
    await user.click(within(menu).getByRole('button', { name: 'Owner' }));
    expect(api.grantAccess).not.toHaveBeenCalled();
    expect(api.revokeAccess).not.toHaveBeenCalled();
  });
});
