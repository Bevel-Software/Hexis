import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AccessOverride, AccessResponse } from '../../access/api';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

/**
 * What the group page says about access, and what it lets you do about it.
 *
 * Every assertion here is about honesty: the exact sentence a non-writer is
 * told, the fact that a rule on an item is shown rather than hidden behind the
 * folder's summary, and — the one that matters most — that the escalation opens
 * the share dialog pinned to the DEFAULT branch, because an access edit written
 * into whatever branch happened to be open would look like it worked and do
 * nothing.
 */

const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  fetchAccessOverrides: vi.fn(),
}));
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, ...api };
});

const dialog = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
vi.mock('../../access/components/ManageAccessDialog', () => ({
  ManageAccessDialog: (props: { onClose: () => void }) => {
    dialog.props = props as unknown as Record<string, unknown>;
    return (
      <button type="button" onClick={props.onClose}>
        Close share dialog
      </button>
    );
  },
}));

import { GroupAccessSection } from '../components/GroupAccessSection';
import { DEFAULT_WORKSPACE_ID } from '../services/library.api';

const GTM_PATHS = ['Groups/GTM/outreach/SKILL.md', 'Groups/GTM/slack.tool'];
const LEGACY_PATHS = ['Skills/GTM/outreach', 'Tools/GTM/slack.tool'];

const view = (over: Partial<AccessResponse> = {}): AccessResponse =>
  ({
    canRead: true,
    canWrite: false,
    canDownload: false,
    canOwner: false,
    eligible: { roles: ['Admin'], users: [{ name: 'Olga Petrov', email: 'olga@bevel.software' }] },
    readers: {
      restricted: true,
      roles: ['GTM Team'],
      users: [{ name: 'Alice Chen', email: 'alice@bevel.software' }],
    },
    owners: { roles: [], users: [{ name: 'Olga Petrov', email: 'olga@bevel.software' }] },
    downloaders: { roles: [], users: [] },
    sources: {},
    ...over,
  }) as AccessResponse;

function renderSection(
  props: { group?: string; itemPaths?: string[] } = {},
  kbDirName: string | null = 'knowledge-base',
): ReactNode {
  const workspace = {
    workspaceId: 'some-open-draft',
    kbDirName,
  } as unknown as WorkspaceContextValue;
  render(
    <WorkspaceContext.Provider value={workspace}>
      <GroupAccessSection group={props.group ?? 'GTM'} itemPaths={props.itemPaths ?? GTM_PATHS} />
    </WorkspaceContext.Provider>,
  );
  return null;
}

const noOverrides = { overrides: [] as AccessOverride[], truncated: false };

describe('GroupAccessSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialog.props = null;
    api.fetchFileAccess.mockResolvedValue(view());
    api.fetchAccessOverrides.mockResolvedValue(noOverrides);
  });

  it('says it is checking, then shows who can use, edit and own the group', async () => {
    renderSection();

    expect(screen.getByText('Checking access…')).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'Who can use this group' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Access for GTM' })).toBeInTheDocument();
    expect(screen.getByText('GTM Team')).toBeInTheDocument();
    expect(screen.getAllByText('Alice Chen').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Can edit' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Owners' })).toBeInTheDocument();
  });

  it('states the public case in one sentence', async () => {
    api.fetchFileAccess.mockResolvedValue(
      view({ readers: { restricted: false, roles: [], users: [] } }),
    );
    renderSection();

    expect(
      await screen.findByText('Everyone at the company can use this group.'),
    ).toBeInTheDocument();
  });

  it('names the empty states rather than showing blank lists', async () => {
    api.fetchFileAccess.mockResolvedValue(
      view({
        readers: { restricted: true, roles: [], users: [] },
        eligible: { roles: [], users: [] },
        owners: { roles: [], users: [] },
      }),
    );
    renderSection();

    expect(
      await screen.findByText('Nobody has been given access yet — Admins can always see it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Only Admins can change this group.')).toBeInTheDocument();
    // No owners → no empty "Owners" heading hanging over nothing.
    expect(screen.queryByRole('heading', { name: 'Owners' })).not.toBeInTheDocument();
  });

  it('opens the share dialog on the group folder, pinned to the default branch', async () => {
    api.fetchFileAccess.mockResolvedValue(view({ canWrite: true }));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Manage access' }));

    expect(dialog.props).toMatchObject({
      entry: { name: 'GTM', relativePath: 'knowledge-base/Groups/GTM', type: 'directory' },
      workspaceId: DEFAULT_WORKSPACE_ID,
    });
    // The ambient workspace is a draft; the edit must not follow it.
    expect(dialog.props?.workspaceId).not.toBe('some-open-draft');

    fireEvent.click(screen.getByRole('button', { name: 'Close share dialog' }));

    await waitFor(() => expect(api.fetchFileAccess).toHaveBeenCalledTimes(2));
    expect(api.fetchAccessOverrides).toHaveBeenCalledTimes(2);
  });

  it('gives a non-writer no editor, and names who to ask instead', async () => {
    renderSection();

    expect(
      await screen.findByText('Managed by Olga Petrov. Ask them to change access.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
  });

  it('falls back to the Admins when the folder has no named owner', async () => {
    api.fetchFileAccess.mockResolvedValue(view({ owners: { roles: [], users: [] } }));
    renderSection();

    expect(
      await screen.findByText('Managed by the Admins. Ask an Admin to change access.'),
    ).toBeInTheDocument();
  });

  it('disables the editor until the workspace knows where the KB lives', async () => {
    api.fetchFileAccess.mockResolvedValue(view({ canWrite: true }));
    renderSection({}, null);

    const button = await screen.findByRole('button', { name: 'Manage access' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Workspace still loading');
  });

  it('lists the rules declared on items inside the group, deny included', async () => {
    api.fetchAccessOverrides.mockResolvedValue({
      truncated: false,
      overrides: [
        {
          path: 'Groups/GTM/battlecards/access.md',
          governs: 'Groups/GTM/battlecards',
          source: 'access-md',
          entries: [
            { verb: 'write', deny: false, principal: { kind: 'role', role: 'GTM Team' } },
            { verb: 'write', deny: true, principal: { kind: 'everyone' } },
          ],
        },
        {
          path: 'Groups/GTM/slack.tool',
          governs: 'Groups/GTM/slack.tool',
          source: 'frontmatter',
          entries: [
            {
              verb: 'owner',
              deny: false,
              principal: { kind: 'user', email: 'ali@bevel.software', name: 'Ali' },
            },
          ],
        },
      ] as AccessOverride[],
    });
    renderSection();

    const list = await screen.findByRole('list', { name: 'Item-specific rules' });
    expect(list).toBeInTheDocument();
    expect(
      screen.getByText(
        "Rules on an item override this folder's rules for the people and groups they name.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('battlecards')).toBeInTheDocument();
    expect(screen.getByText('write: GTM Team · deny write: Everyone')).toBeInTheDocument();
    expect(screen.getByText('slack.tool')).toBeInTheDocument();
    expect(screen.getByText('owner: Ali <ali@bevel.software>')).toBeInTheDocument();
    expect(screen.getAllByText('Own rules')).toHaveLength(2);
  });

  it('names a skill by its folder, not by the file the rules sit in', async () => {
    api.fetchAccessOverrides.mockResolvedValue({
      truncated: false,
      overrides: [
        {
          path: 'Groups/GTM/outreach/SKILL.md',
          governs: 'Groups/GTM/outreach/SKILL.md',
          source: 'frontmatter',
          entries: [{ verb: 'owner', deny: false, principal: { kind: 'role', role: 'Admin' } }],
        },
      ] as AccessOverride[],
    });
    renderSection();

    expect(await screen.findByRole('list', { name: 'Item-specific rules' })).toBeInTheDocument();
    expect(screen.getByText('outreach')).toBeInTheDocument();
    expect(screen.queryByText('SKILL')).not.toBeInTheDocument();
  });

  it('shows a rule file it could not read rather than pretending it is fine', async () => {
    api.fetchAccessOverrides.mockResolvedValue({
      truncated: false,
      overrides: [
        {
          path: 'Groups/GTM/battlecards/access.md',
          governs: 'Groups/GTM/battlecards',
          source: 'access-md',
          entries: [],
          parseError: "Groups/GTM/battlecards/access.md: 'read:' must be a list",
        },
      ] as AccessOverride[],
    });
    renderSection();

    expect(await screen.findByText('Unreadable rules')).toBeInTheDocument();
    expect(
      screen.getByText("Groups/GTM/battlecards/access.md: 'read:' must be a list"),
    ).toBeInTheDocument();
  });

  it('admits when the scan did not finish', async () => {
    api.fetchAccessOverrides.mockResolvedValue({
      truncated: true,
      overrides: [
        {
          path: 'Groups/GTM/a.tool',
          governs: 'Groups/GTM/a.tool',
          source: 'frontmatter',
          entries: [{ verb: 'read', deny: false, principal: { kind: 'everyone' } }],
        },
      ] as AccessOverride[],
    });
    renderSection();

    expect(
      await screen.findByText(
        'Showing the first rules found — this group has too many files to scan completely.',
      ),
    ).toBeInTheDocument();
  });

  it('omits the item-rules block entirely when there are none', async () => {
    renderSection();

    await screen.findByRole('heading', { name: 'Who can use this group' });
    expect(screen.queryByRole('list', { name: 'Item-specific rules' })).not.toBeInTheDocument();
  });

  it('gives an unmigrated group one card per folder, and says why', async () => {
    renderSection({ itemPaths: LEGACY_PATHS });

    expect(await screen.findByText('Skills folder — Skills/GTM')).toBeInTheDocument();
    expect(screen.getByText('Tools folder — Tools/GTM')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'This group still lives in the legacy Skills/ and Tools/ folders',
    );
    expect(api.fetchFileAccess).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ID, 'Skills/GTM', 'folder');
    expect(api.fetchFileAccess).toHaveBeenCalledWith(DEFAULT_WORKSPACE_ID, 'Tools/GTM', 'folder');
  });

  it('reports a failed lookup and retries on demand', async () => {
    api.fetchFileAccess.mockRejectedValueOnce(new Error('nope'));
    renderSection();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't load access for this group.");

    api.fetchFileAccess.mockResolvedValue(view());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Who can use this group' })).toBeInTheDocument();
  });

  it('renders nothing for something that is not a real group folder', () => {
    renderSection({ group: 'slack.tool', itemPaths: ['Tools/slack.tool'] });

    expect(screen.queryByRole('region', { name: /^Access for/ })).not.toBeInTheDocument();
    expect(api.fetchFileAccess).not.toHaveBeenCalled();
  });
});
