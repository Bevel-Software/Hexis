import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * ONE MENU PER ROW, AND A RESTRICTION KEEPS THE PERSON VISIBLE.
 *
 * The tester unticked "Can edit" for someone whose edit came from a parent
 * folder, chose "Restrict just this folder", and watched them vanish. The
 * restriction itself was right — a verb-scoped `deny write` here, with the read
 * their parent grant implies left standing — but the sheet built its "on this
 * folder" list from LOCAL GRANTS, and a person whose only local entry is a
 * DENIAL has none. They fell into the collapsed inherited section and read as
 * gone.
 *
 * Two things change, and these tests hold both:
 *   - the row is decided by local ENTRIES, grant or denial, so a restriction
 *     keeps the person on this folder, saying per verb where each one stands;
 *   - the prompt is gone. Every row carries the same menu — the four sets, then
 *     Deny — and picking one writes whatever difference it implies, in the
 *     background. Below the parent that means denials; back up again it means
 *     lifting them.
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
/** A FOLDER target: restrictions here are written into its own `access.md`. */
const FOLDER: FileTreeEntry = {
  name: 'Deals',
  relativePath: `${KB}/Sales/Deals`,
  type: 'directory',
} as unknown as FileTreeEntry;
const ALICE = { name: 'Alice', email: 'alice@x.com' };
const PARENT = 'Sales/access.md';

/** The shell every view below fills in: nobody, nothing, caller can manage. */
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

/** Alice holds EDIT (and the read it implies) from the parent folder — nothing here. */
const EDIT_FROM_PARENT = {
  ...BLANK,
  eligible: { principals: [], roles: [], users: [ALICE] },
  readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
  sources: {
    'u:alice@x.com': {
      read: [{ kind: 'ancestor', path: PARENT }],
      write: [{ kind: 'ancestor', path: PARENT }],
    },
  },
} as unknown as AccessResponse;

/**
 * After `deny write` is written here: Alice keeps the read her parent EDIT
 * grant implies (denials do not fold the way grants do), and the restriction is
 * reported as a local denial — the entry that keeps her row on this folder.
 */
const WRITE_RESTRICTED_HERE = {
  ...BLANK,
  readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
  sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: PARENT }] } },
  denials: { 'u:alice@x.com': { write: [{ kind: 'direct' }] } },
  deniedHere: { principals: [], users: [ALICE] },
} as unknown as AccessResponse;

/** After Deny: every verb denied here, so Alice is in no eligible list at all. */
const DENIED_HERE = {
  ...BLANK,
  denials: {
    'u:alice@x.com': {
      read: [{ kind: 'direct' }],
      write: [{ kind: 'direct' }],
      download: [{ kind: 'direct' }],
      owner: [{ kind: 'direct' }],
    },
  },
  deniedHere: { principals: [], users: [ALICE] },
} as unknown as AccessResponse;

/**
 * Expand the "People invited to Sales" disclosure.
 *
 * A row with no entry on this folder at all still belongs to the parent's
 * section — that part is unchanged, and correct. What this ticket fixes is the
 * row that DOES have an entry here (a denial), which must not be filed there.
 */
async function expandParentSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /People invited to Sales/ }));
}

/** Open a grantee row's verb menu and return the panel holding its items. */
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

/** The row-menu item for one set. */
function setItem(menu: HTMLElement, label: RegExp): HTMLElement {
  return within(menu).getByRole('button', { name: label });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({
    roles: [],
    groups: [],
    people: [],
    peopleWithheld: false,
  });
});

describe('ManageAccessDialog: lowering an inherited set by one verb', () => {
  it('picking Can read on a parent-granted editor writes a verb-scoped deny here, with no prompt', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_FROM_PARENT);
    api.revokeAccess.mockResolvedValue(WRITE_RESTRICTED_HERE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await expandParentSection(user);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^can edit$/i);
    await user.click(setItem(menu, /^can read$/i));

    // ONE write: a deny of `write` at this folder. Read is untouched — the
    // grammar leaves the parent's implied read standing, which is the whole
    // reason a verb-scoped denial is the right instrument.
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', {
      path: FOLDER.relativePath,
      kind: 'folder',
      principal: { kind: 'user', email: 'alice@x.com', displayName: 'Alice' },
      mode: 'deny-here',
      verb: 'write',
    });
    expect(api.grantAccess).not.toHaveBeenCalled();
    // No detour: the restriction is written straight from the row.
    expect(screen.queryByRole('heading', { name: /remove from parent folder\?/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /restrict access here\?/i })).toBeNull();
  });

  it('the restricted person STAYS on this folder, with each verb explained', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(WRITE_RESTRICTED_HERE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);

    // The bug: her only local entry is a denial, so a sections-by-local-GRANT
    // rule filed her under the collapsed parent section and she looked removed.
    const heading = await screen.findByRole('heading', { name: /on this folder/i });
    expect(heading).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /People invited to Sales/ })).toBeNull();
    expect(screen.getByText('Alice')).toBeInTheDocument();

    // And the row says, verb by verb, where each one stands.
    const menu = await openRowMenu(user, /^can read$/i);
    expect(setItem(menu, /^can edit$/i)).toHaveAttribute('aria-description', 'restricted here');
    expect(setItem(menu, /^can read$/i)).toHaveAttribute('aria-description', 'from Sales');
  });

  it('a GROUP with download from the parent: picking Can read denies download for the group', async () => {
    const user = userEvent.setup();
    const GTM = { name: 'GTM Team', kind: 'group' as const };
    api.fetchFileAccess.mockResolvedValue({
      ...BLANK,
      readers: { restricted: true, principals: [GTM], roles: ['GTM Team'], users: [] },
      downloaders: { principals: [GTM], roles: ['GTM Team'], users: [] },
      sources: {
        'g:gtm team': {
          read: [{ kind: 'ancestor', path: PARENT }],
          download: [{ kind: 'ancestor', path: PARENT }],
        },
      },
    } as unknown as AccessResponse);
    api.revokeAccess.mockResolvedValue({
      ...BLANK,
      readers: { restricted: true, principals: [GTM], roles: ['GTM Team'], users: [] },
      sources: { 'g:gtm team': { read: [{ kind: 'ancestor', path: PARENT }] } },
      denials: { 'g:gtm team': { download: [{ kind: 'direct' }] } },
      deniedHere: { principals: [GTM], users: [] },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await expandParentSection(user);
    await screen.findByText("GTM Team");

    const menu = await openRowMenu(user, /^can read, can download$/i);
    await user.click(setItem(menu, /^can read$/i));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith(
      'ws-1',
      // The GROUP kind round-trips: a bare token, not a `role/` one.
      expect.objectContaining({
        mode: 'deny-here',
        verb: 'download',
        principal: { kind: 'group', group: 'GTM Team' },
      }),
    );
  });
});

describe('ManageAccessDialog: raising a lowered set back', () => {
  it('picking Can edit again lifts the local deny and grants nothing — the parent already gives it', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(WRITE_RESTRICTED_HERE);
    // Lifting the denial restores what the parent grants, and the fresh view
    // says so: write is hers again, from Sales.
    api.revokeAccess.mockResolvedValue(EDIT_FROM_PARENT);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^can read$/i);
    await user.click(setItem(menu, /^can edit$/i));

    // A plain verb-scoped revoke — which strips the `deny write` line, denials
    // and grants being removed by the same splice.
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', {
      path: FOLDER.relativePath,
      kind: 'folder',
      principal: { kind: 'user', email: 'alice@x.com', displayName: 'Alice' },
      verb: 'write',
    });
    // Nothing granted: the parent's grant is back the moment the denial is gone.
    expect(api.grantAccess).not.toHaveBeenCalled();
  });

  it('picking a set ABOVE the parent lifts the denial AND grants the part the parent does not give', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(WRITE_RESTRICTED_HERE);
    // Lifting `deny owner` (there is none) is skipped; lifting `deny write`
    // restores edit from the parent, but owner is nobody's grant — so it is
    // written here.
    api.revokeAccess.mockResolvedValue(EDIT_FROM_PARENT);
    api.grantAccess.mockResolvedValue(EDIT_FROM_PARENT);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^can read$/i);
    await user.click(setItem(menu, /^owner$/i));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    // Exactly one grant line, the highest tier: owner carries write, download
    // and read, so no redundant second grant is written under it.
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'owner' }),
    );
    // And the denial the new set no longer needs was lifted first.
    expect(api.revokeAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'write' }),
    );
    expect(api.revokeAccess).not.toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ mode: 'deny-here' }),
    );
  });
});

describe('ManageAccessDialog: Deny, and re-granting after it', () => {
  it('Deny denies every verb here in one write, and the row stays, marked Denied here', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_FROM_PARENT);
    api.revokeAccess.mockResolvedValue(DENIED_HERE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await expandParentSection(user);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^can edit$/i);
    await user.click(setItem(menu, /^deny$/i));

    // One verb-less deny-here: the server strips every local grant and denies
    // all four verbs, READ INCLUDED — which is what makes Deny different from
    // picking the lowest set.
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith('ws-1', {
      path: FOLDER.relativePath,
      kind: 'folder',
      principal: { kind: 'user', email: 'alice@x.com', displayName: 'Alice' },
      mode: 'deny-here',
    });
    // She holds nothing, so no eligible list carries her — and yet the row is
    // still here, saying what was decided rather than silently disappearing.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^denied here$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^no access$/i })).toBeNull();
  });

  it('a denied row keeps its menu, and picking a set from it lifts the denial and applies the set', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(DENIED_HERE);
    api.revokeAccess.mockResolvedValue(BLANK);
    api.grantAccess.mockResolvedValue(BLANK);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^denied here$/i);
    await user.click(setItem(menu, /^can read$/i));

    // The read denial is lifted, then read is granted here: with every verb
    // denied there was no parent grant left to fall back on.
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'read' }),
    );
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'read' }),
    );
    // Only the denials the new set needs gone are lifted — edit, download and
    // owner stay denied, because "Can read" is what was asked for.
    for (const verb of ['write', 'download', 'owner']) {
      expect(api.revokeAccess).not.toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ verb }),
      );
    }
  });
});

describe('ManageAccessDialog: every row has the same controls', () => {
  it('an inherited row carries the verb menu and Deny, not read-only text', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_FROM_PARENT);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await expandParentSection(user);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^can edit$/i);
    // The four sets, then Deny. Matched by ACCESSIBLE NAME and compared as
    // elements, so the assertion is about the items and their order — not about
    // how the trailing note happens to be glued onto `textContent` (it is
    // aria-hidden there, and reaches assistive tech as `aria-description`).
    expect(within(menu).getAllByRole('button')).toEqual([
      setItem(menu, /^owner$/i),
      setItem(menu, /^can edit$/i),
      setItem(menu, /^can read$/i),
      setItem(menu, /^can download$/i),
      setItem(menu, /^deny$/i),
    ]);
    // And the provenance rides along as a description, on exactly the verbs she
    // holds: edit from the parent, and the read it implies.
    expect(setItem(menu, /^can edit$/i)).toHaveAttribute('aria-description', 'from Sales');
    expect(setItem(menu, /^can read$/i)).toHaveAttribute('aria-description', 'from Sales');
    expect(setItem(menu, /^owner$/i)).not.toHaveAttribute('aria-description');
    expect(setItem(menu, /^can download$/i)).not.toHaveAttribute('aria-description');
    // Nothing is disabled: picking a set BELOW what is held is the point.
    for (const item of within(menu).getAllByRole('button')) expect(item).not.toBeDisabled();
  });

  it('a row restricted here is not "No access" — it names the decision', async () => {
    api.fetchFileAccess.mockResolvedValue(DENIED_HERE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: /^denied here$/i })).toBeInTheDocument();
  });

  it('the x on an INHERITED row still offers remove-at-parent or restrict-here', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_FROM_PARENT);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await expandParentSection(user);
    await screen.findByText("Alice");

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    // Unchanged by this ticket: the whole-row removal is still a choice between
    // two different acts, and it still asks which.
    expect(
      await screen.findByRole('heading', { name: /remove from parent folder\?/i }),
    ).toBeInTheDocument();
    expect(api.revokeAccess).not.toHaveBeenCalled();
  });

  it('the x on a DIRECT row revokes here, with no question asked', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue({
      ...BLANK,
      eligible: { principals: [], roles: [], users: [ALICE] },
      readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
      sources: { 'u:alice@x.com': { read: [{ kind: 'direct' }], write: [{ kind: 'direct' }] } },
    } as unknown as AccessResponse);
    api.revokeAccess.mockResolvedValue(BLANK);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText("Alice");

    await user.click(screen.getByRole('button', { name: 'Remove access' }));

    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    expect(api.revokeAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        principal: { kind: 'user', email: 'alice@x.com', displayName: 'Alice' },
      }),
    );
    expect(screen.queryByRole('heading', { name: /remove from parent/i })).toBeNull();
  });

  it('the x on a row a PARENT restricts offers restrict-here, never "remove from" that parent', async () => {
    const user = userEvent.setup();
    // Alice reads through a role (no grant entry of her own anywhere), and the
    // parent folder denies her edit. Her only ancestor ENTRY is that denial.
    api.fetchFileAccess.mockResolvedValue({
      ...BLANK,
      eligible: { principals: [], roles: [], users: [ALICE] },
      readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
      sources: {},
      denials: { 'u:alice@x.com': { write: [{ kind: 'ancestor', path: PARENT }] } },
    } as unknown as AccessResponse);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    // The denial still files her under the folder holding it — that is where
    // the rule lives, and the row says so.
    await expandParentSection(user);
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    // "Remove from Sales" would delete the parent's RESTRICTION — more access,
    // from a click that asked for less. The only act offered is restricting here.
    expect(await screen.findByRole('heading', { name: /restrict access here\?/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remove from /i })).toBeNull();
    expect(screen.getByRole('button', { name: /restrict just this folder/i })).toBeInTheDocument();
    expect(api.revokeAccess).not.toHaveBeenCalled();
  });
});

describe('ManageAccessDialog: lowering a grant written here', () => {
  it('a purely local grant is revoked, not denied — no dead deny line is left behind', async () => {
    const user = userEvent.setup();
    // Alice is an owner by a grant on this folder; nothing above names her.
    api.fetchFileAccess.mockResolvedValue({
      ...BLANK,
      owners: { principals: [], roles: [], users: [ALICE] },
      eligible: { principals: [], roles: [], users: [ALICE] },
      readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
      downloaders: { principals: [], roles: [], users: [ALICE] },
      sources: {
        'u:alice@x.com': {
          owner: [{ kind: 'direct' }],
          write: [{ kind: 'direct' }],
          read: [{ kind: 'direct' }],
          download: [{ kind: 'direct' }],
        },
      },
    } as unknown as AccessResponse);
    api.revokeAccess.mockResolvedValue(BLANK);
    api.grantAccess.mockResolvedValue(BLANK);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText("Alice");

    const menu = await openRowMenu(user, /^owner, can download$/i);
    await user.click(setItem(menu, /^can read$/i));

    await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
    // Owner comes off first — a grant folds downward inside one scope, so
    // denying write under a live `owner:` here would be refused as ineffective.
    const verbs = api.revokeAccess.mock.calls.map((c) => (c[1] as { verb?: string }).verb);
    expect(verbs[0]).toBe('owner');
    // Every removal is a plain revoke: the grants were all written here, so
    // there is nothing above to shadow with a denial.
    for (const call of api.revokeAccess.mock.calls) {
      expect((call[1] as { mode?: string }).mode).toBeUndefined();
    }
    // Read was hers by a grant here that the owner revoke took with it, so it is
    // written back.
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ verb: 'read' }),
    );
  });
});
