import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const KNOWN = { name: 'Alice', email: 'alice@x.com' };
const UNKNOWN = { name: 'new.colleague', email: 'new.colleague@company.com' };

const NOTE = /hasn't signed in yet/i;

/** A view granting `users` read directly on the file. */
const viewWith = (users: { name: string; email: string; hasAccount?: boolean }[]): AccessResponse =>
  ({
    canRead: true,
    canWrite: true,
    canDownload: false,
    canOwner: false,
    eligible: { roles: [], users: [] },
    readers: { restricted: true, roles: [], users },
    owners: { roles: [], users: [] },
    downloaders: { roles: [], users: [] },
    sources: Object.fromEntries(
      users.map((u) => [`u:${u.email.toLowerCase()}`, { read: [{ kind: 'direct' }] }]),
    ),
  }) as AccessResponse;

const EMPTY = viewWith([]);

/** The chip is the element its remove button sits in. */
function chipFor(label: string): HTMLElement {
  const remove = screen.getByRole('button', { name: `Remove ${label}` });
  const chip = remove.parentElement;
  if (!chip) throw new Error(`chip for ${label} has no parent`);
  return chip;
}

/** The grantee row for a person, found from the name it renders (once loaded). */
async function rowFor(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name);
  const row = label.closest('div.flex.flex-wrap');
  if (!row) throw new Error(`no row around ${name}`);
  return row as HTMLElement;
}

/**
 * Typing an email nobody has an account for is allowed — this is the whole
 * decision the ticket records — so the dialog says so instead of refusing:
 * "hasn't signed in yet" beside the chip while the grant is being composed,
 * and beside the name once it is saved. It is a label and nothing else; the
 * grant call is identical either way, and the note goes when the person does
 * sign in.
 */
describe('ManageAccessDialog: an email with no account is labelled, not refused', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchFileAccess.mockResolvedValue(EMPTY);
    api.grantAccess.mockResolvedValue(EMPTY);
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [],
      peopleWithheld: false,
      accountsKnown: true,
    });
  });

  it('a typed UNKNOWN email chips with the note, and Share still saves the grant', async () => {
    const user = userEvent.setup();
    // The server knows of nobody by this address — the unknown case.
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [],
      peopleWithheld: false,
      accountsKnown: true,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, UNKNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    // The chip exists, carries the note, and is removable like any other.
    const chip = chipFor(UNKNOWN.name);
    expect(within(chip).getByText(NOTE)).toBeInTheDocument();

    // And the grant saves — unchanged, with the typed address.
    await user.click(screen.getByRole('button', { name: /^share$/i }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
    expect(api.grantAccess).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        principal: { kind: 'user', email: UNKNOWN.email, displayName: UNKNOWN.name },
      }),
    );
  });

  it('a typed KNOWN email chips with no note', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [{ ...KNOWN, hasAccount: true }],
      peopleWithheld: false,
      accountsKnown: true,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, KNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    expect(within(chipFor('alice')).queryByText(NOTE)).toBeNull();
  });

  it('an older server that says nothing about accounts labels nobody', async () => {
    const user = userEvent.setup();
    // No `hasAccount` anywhere — version skew. Silence is not "no account".
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [{ name: KNOWN.name, email: KNOWN.email }],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, KNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    expect(within(chipFor('alice')).queryByText(NOTE)).toBeNull();
  });

  it('an older server labels nobody even for an address it never names', async () => {
    const user = userEvent.setup();
    // Version skew again, this time with the address absent from the answer.
    // An old build does not report accounts at all, so "not in the answer"
    // carries no information about accounts and the chip stays unlabelled —
    // the previous behaviour was to read that silence as "no account" and
    // accuse every free-typed address.
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, UNKNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    expect(within(chipFor(UNKNOWN.name)).queryByText(NOTE)).toBeNull();
  });

  it('autocomplete being DOWN labels nobody — and the grant still saves', async () => {
    const user = userEvent.setup();
    // No answer at all. Nothing was ruled on, so nothing is claimed: the note
    // would otherwise appear on every address typed while suggest is failing.
    api.suggestPrincipals.mockRejectedValue(new Error('suggest unavailable'));
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, UNKNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    expect(within(chipFor(UNKNOWN.name)).queryByText(NOTE)).toBeNull();

    // The point of the ticket survives the outage: the grant is never gated
    // on knowing whether an account exists.
    await user.click(screen.getByRole('button', { name: /^share$/i }));
    await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
  });

  it('a later answer that says the account is GONE relabels the chip', async () => {
    const user = userEvent.setup();
    // An account can be erased while this dialog is open. The first answer
    // said the address had one; the second explicitly says it does not, and
    // that has to be able to take the earlier claim back.
    let signedIn = true;
    api.suggestPrincipals.mockImplementation(async () => ({
      roles: [],
      groups: [],
      people: [{ ...KNOWN, hasAccount: signedIn }],
      peopleWithheld: false,
      accountsKnown: true,
    }));
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, KNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');
    expect(within(chipFor('alice')).queryByText(NOTE)).toBeNull();

    signedIn = false;
    await user.type(input, 'alice');
    await waitFor(() =>
      expect(within(chipFor('alice')).getByText(NOTE)).toBeInTheDocument(),
    );
  });

  it('an answer that WITHHELD people labels nobody, however it flags itself', async () => {
    const user = userEvent.setup();
    // The harvesting guard returns nobody by design. Its empty list is not
    // evidence that nobody has an account — read that way it would label
    // every address at once — so the dialog refuses it even when the answer
    // also claims to rule on accounts, which a correct server never does.
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      people: [],
      peopleWithheld: true,
      accountsKnown: true,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, UNKNOWN.email);
    await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
    await user.keyboard('{Enter}');

    expect(within(chipFor(UNKNOWN.name)).queryByText(NOTE)).toBeNull();
  });

  it('a direct-grant ROW for an unknown email carries the note beside the name', async () => {
    api.fetchFileAccess.mockResolvedValue(
      viewWith([
        { ...KNOWN, hasAccount: true },
        { ...UNKNOWN, hasAccount: false },
      ]),
    );
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const unknownRow = await rowFor(UNKNOWN.name);
    expect(within(unknownRow).getByText(NOTE)).toBeInTheDocument();
    // The one who has signed in is not labelled — the note names a difference.
    expect(within(await rowFor(KNOWN.name)).queryByText(NOTE)).toBeNull();
  });

  it('a person only RESTRICTED here carries the note too', async () => {
    // A `deny` on a mistyped address restricts nobody and looks fine; the
    // restricted row is the one place that typo would otherwise stay hidden.
    api.fetchFileAccess.mockResolvedValue({
      ...EMPTY,
      deniedHere: {
        principals: [],
        users: [
          { ...KNOWN, hasAccount: true },
          { ...UNKNOWN, hasAccount: false },
        ],
      },
      // The `deny` is written HERE, which is what gives a restricted-only
      // person a direct row of their own (see `classifyManage`).
      denials: {
        [`u:${KNOWN.email}`]: { read: [{ kind: 'direct' }] },
        [`u:${UNKNOWN.email}`]: { read: [{ kind: 'direct' }] },
      },
    } as AccessResponse);
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    expect(within(await rowFor(UNKNOWN.name)).getByText(NOTE)).toBeInTheDocument();
    expect(within(await rowFor(KNOWN.name)).queryByText(NOTE)).toBeNull();
  });

  it('the row note disappears once that person has signed in', async () => {
    // Same grant, two loads of the dialog: before the first sign-in and after
    // it. Nothing about the grant changed in between.
    api.fetchFileAccess.mockResolvedValue(viewWith([{ ...UNKNOWN, hasAccount: false }]));
    const before = render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    expect(within(await rowFor(UNKNOWN.name)).getByText(NOTE)).toBeInTheDocument();
    before.unmount();

    api.fetchFileAccess.mockResolvedValue(viewWith([{ ...UNKNOWN, hasAccount: true }]));
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(UNKNOWN.name)).toBeInTheDocument());
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
