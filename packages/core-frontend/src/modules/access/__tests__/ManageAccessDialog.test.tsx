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
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
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
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
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
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
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

  it('gives each granting folder its own section, named after the folder', async () => {
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

// ── group principals in the picker ──
describe('ManageAccessDialog: group principals', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: ['GTM Team'],
      people: [],
      peopleWithheld: false,
    });
  });

  it('suggests active groups, chips one, and grants it with the group kind', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText(/add people, groups, or roles/i),
      'gtm',
    );
    // The suggestion row carries the "group" tag and chips on click.
    await user.click(await screen.findByRole('button', { name: /GTM Team/ }));
    expect(screen.getByText('GTM Team')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ principal: { kind: 'group', group: 'GTM Team' } }),
    );
  });

  it('suggests roles from the `roles` field (never the retired `plugins` alias) and grants the role kind', async () => {
    const user = userEvent.setup();
    // A server still emitting the deprecated alias: the dialog must read
    // `roles` and IGNORE `plugins` — the alias is not in the type, and the
    // suggestion list must come from the new field alone.
    api.suggestPrincipals.mockResolvedValue({
      roles: ['Admin'],
      groups: [],
      people: [],
      peopleWithheld: false,
      plugins: ['Stale Alias Role'],
    } as never);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText(/add people, groups, or roles/i),
      'adm',
    );
    expect(await screen.findByRole('button', { name: /Admin/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stale Alias Role/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Admin/ }));
    await user.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ principal: { kind: 'role', role: 'Admin' } }),
    );
  });

  it('a suggest response missing `roles` and `groups` renders people and never throws', async () => {
    const user = userEvent.setup();
    // Version skew: an older/newer server may omit either field entirely. The
    // dialog reads every field defensively — this used to crash.
    api.suggestPrincipals.mockResolvedValue({
      people: [{ name: 'Bo', email: 'bo@x.com' }],
      peopleWithheld: false,
    } as never);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText(/add people, groups, or roles/i),
      'bo',
    );
    expect(await screen.findByRole('button', { name: /Bo/ })).toBeInTheDocument();
  });

  it('a suggest response with ONLY roles/groups (people absent) still lists them', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: ['Admin'],
      groups: ['GTM Team'],
    } as never);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText(/add people, groups, or roles/i),
      'a',
    );
    expect(await screen.findByRole('button', { name: /GTM Team/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Admin/ })).toBeInTheDocument();
  });
});

// ── grantee rows: a group is badged "Group", a role "Role" ──
//
// The eligible lists' `principals` carry each collective's kind; the old
// name-only `roles` list forced every collective row into a "Role" badge —
// a group grantee rendered as a role, and its mutations round-tripped with
// the wrong principal kind (a grant on the row would 404 as an unknown role).
describe('ManageAccessDialog: grantee rows badge roles vs groups', () => {
  /** GTM Team (a GROUP) holds write directly; Engineering (a ROLE) holds read. */
  const VIEW = {
    canRead: true,
    canWrite: true,
    canDownload: false,
    canOwner: false,
    eligible: {
      principals: [{ name: 'GTM Team', kind: 'group' }],
      roles: ['GTM Team'],
      users: [],
    },
    readers: {
      restricted: true,
      principals: [{ name: 'Engineering', kind: 'role' }],
      roles: ['Engineering'],
      users: [],
    },
    owners: { principals: [], roles: [], users: [] },
    downloaders: { principals: [], roles: [], users: [] },
    sources: {
      'r:gtm team': { write: [{ kind: 'direct' }] },
      'r:engineering': { read: [{ kind: 'direct' }] },
    },
  } as AccessResponse;

  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
  });

  it('badges each collective row with its kind', async () => {
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    expect(await screen.findByText('GTM Team')).toBeInTheDocument();
    // One badge each, with the right words — a group must NOT read "Role".
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
  });

  it('round-trips a group row mutation with the group principal kind', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    // The GTM row's trigger reads "Can edit" (the add-row selector does too —
    // the row's is the later one in the DOM). Check "Can download" on it.
    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    await user.click(triggers[triggers.length - 1]);
    await user.click(await screen.findByRole('button', { name: /^can download$/i }));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        verb: 'download',
        principal: { kind: 'group', group: 'GTM Team' },
      }),
    );
  });

  it('a group and a role SHARING one name are two rows, each mutating its own kind', async () => {
    // The backend treats bare `Product` (the group) and `role/Product` (the
    // role) as different principals. One collapsed row silently pointed every
    // edit at the group and hid the role's grant.
    const user = userEvent.setup();
    const SHARED = {
      ...VIEW,
      eligible: {
        principals: [
          { name: 'Product', kind: 'group' },
          { name: 'Product', kind: 'role' },
        ],
        roles: ['Product'],
        users: [],
      },
      readers: { restricted: true, principals: [], roles: [], users: [] },
      sources: {
        'g:product': { write: [{ kind: 'direct' }] },
        'r:product': { write: [{ kind: 'direct' }] },
      },
    } as AccessResponse;
    api.fetchFileAccess.mockResolvedValue(SHARED);
    api.grantAccess.mockResolvedValue(SHARED);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    // Both rows render, one badged Group, one badged Role.
    expect(await screen.findAllByText('Product')).toHaveLength(2);
    expect(screen.getByText('Group')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();

    // Toggling "Can download" on each row round-trips ITS kind. Rows render
    // in eligible order (group first), after the add-row selector — so the
    // trigger list is [add-row, group row, role row].
    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    expect(triggers).toHaveLength(3);
    await user.click(triggers[1]); // the group row
    await user.click(await screen.findByRole('button', { name: /^can download$/i }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.grantAccess).toHaveBeenLastCalledWith(
      'ws-1',
      expect.objectContaining({ principal: { kind: 'group', group: 'Product' } }),
    );

    // Close the group row's still-open menu (its items also read "Can edit"),
    // then open the role row's.
    await user.click((await screen.findAllByRole('button', { name: /^can edit$/i }))[1]);
    const after = await screen.findAllByRole('button', { name: /^can edit$/i });
    expect(after).toHaveLength(3);
    await user.click(after[2]); // the role row
    await user.click(await screen.findByRole('button', { name: /^can download$/i }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(2));
    expect(api.grantAccess).toHaveBeenLastCalledWith(
      'ws-1',
      expect.objectContaining({ principal: { kind: 'role', role: 'Product' } }),
    );
  });

  it('the picker keeps BOTH chips when a group and a role share the typed name', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: ['Product'],
      groups: ['Product'],
      people: [],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText(/add people, groups, or roles/i);
    await user.type(input, 'prod');
    // The group suggestion (tagged "group") chips first…
    await user.click(await screen.findByRole('button', { name: /Product group/i }));
    // …then the role suggestion must NOT be dropped as a duplicate.
    await user.type(input, 'prod');
    await user.click(await screen.findByRole('button', { name: /Product role/i }));

    // Two chips — one per kind — each with its own remove affordance.
    const chips = screen.getAllByRole('button', { name: /Remove Product/ });
    expect(chips).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /^Share$/ }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(2));
    const granted = api.grantAccess.mock.calls.map((c) => (c[1] as { principal: unknown }).principal);
    expect(granted).toContainEqual({ kind: 'group', group: 'Product' });
    expect(granted).toContainEqual({ kind: 'role', role: 'Product' });
  });

  it('falls back to name-only `roles` (badged "Role") when `principals` is absent — version skew', async () => {
    api.fetchFileAccess.mockResolvedValue({
      ...VIEW,
      eligible: { roles: ['GTM Team'], users: [] },
      readers: { restricted: true, roles: [], users: [] },
    } as AccessResponse);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    expect(await screen.findByText('GTM Team')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.queryByText('Group')).not.toBeInTheDocument();
  });
});

/**
 * CLOSING A VERB MENU WITHOUT PICKING ANYTHING.
 *
 * Both permission dropdowns (a grantee row's checklist and the add-row's verb
 * selector) used to stay open until an item inside them was clicked or the
 * trigger was clicked again: a click anywhere else in the dialog left the menu
 * hanging, and Escape closed the whole dialog around it. Outside click and
 * Escape now close the menu — and only the menu.
 */
describe('ManageAccessDialog: dismissing a verb menu', () => {
  /** Alice, read + write directly here — her trigger reads "Can edit". */
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

  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
    api.fetchFileAccess.mockResolvedValue(VIEW);
  });

  /** The add-row's verb selector reads "Can edit" too; Alice's row trigger is the later one. */
  async function aliceTrigger() {
    const triggers = await screen.findAllByRole('button', { name: /^can edit$/i });
    return triggers[triggers.length - 1];
  }

  it("a click outside a row's menu closes it and leaves the dialog open", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ManageAccessDialog entry={ENTRY} onClose={onClose} />);

    await user.click(await aliceTrigger());
    expect(screen.getByRole('button', { name: /remove access/i })).toBeInTheDocument();

    // The dialog's own heading: inside the dialog, outside the menu.
    await user.click(screen.getByRole('dialog'));

    expect(screen.queryByRole('button', { name: /remove access/i })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.grantAccess).not.toHaveBeenCalled();
    expect(api.revokeAccess).not.toHaveBeenCalled();
  });

  it("a click outside the add-row's verb selector closes it", async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const [addRowTrigger] = await screen.findAllByRole('button', { name: /^can edit$/i });
    await user.click(addRowTrigger);
    // The open selector adds a "Can download" item; Alice's closed row adds none.
    expect(screen.getByRole('button', { name: /^can download$/i })).toBeInTheDocument();

    await user.click(screen.getByRole('dialog'));

    expect(screen.queryByRole('button', { name: /^can download$/i })).not.toBeInTheDocument();
  });

  it('the trigger itself still toggles: one click opens, a second closes', async () => {
    const user = userEvent.setup();
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const trigger = await aliceTrigger();
    await user.click(trigger);
    expect(screen.getByRole('button', { name: /remove access/i })).toBeInTheDocument();
    // The outside-click listener must NOT fire on the trigger, or this click
    // would close-then-reopen and the menu would look stuck open.
    await user.click(trigger);
    expect(screen.queryByRole('button', { name: /remove access/i })).not.toBeInTheDocument();
  });

  it('Escape closes the menu, not the dialog, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ManageAccessDialog entry={ENTRY} onClose={onClose} />);

    const trigger = await aliceTrigger();
    await user.click(trigger);
    expect(screen.getByRole('button', { name: /remove access/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: /remove access/i })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);

    // With the menu gone the dialog is the top layer again: Escape closes it.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
