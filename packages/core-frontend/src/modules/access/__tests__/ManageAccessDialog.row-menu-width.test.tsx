import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';

/**
 * A ROW'S MENU IS AS WIDE AS ITS ITEMS, NOT AS ITS TRIGGER.
 *
 * On core-staging the menu under a "Can read" trigger opened at the trigger's
 * width, and an item carrying a note ("from KnowledgeBase") had its LABEL
 * squeezed down to "C…" to make room — the label is the flex child that gives
 * way. The panel now measures its widest item once at `max-content` and pins
 * itself to that, between 200px and 360px; at the cap it is the note that
 * truncates (with the full text on hover), never the label; and the panel
 * re-measures when its items change while it stays open across writes.
 *
 * jsdom does not lay text out, so `offsetWidth` is stubbed to a deterministic
 * width per item (8px a character of its text); what these tests pin is the
 * CONTRACT — which element's width the panel follows, the clamp, what
 * truncates, and the re-measure — not a pixel rendering.
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
const PX_PER_CHAR = 8;
const MIN = 200;
const MAX = 360;

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

/** Alice holds edit (and its read) from the parent folder at `parent`. */
function editFrom(parent: string): AccessResponse {
  return {
    ...BLANK,
    eligible: { principals: [], roles: [], users: [ALICE] },
    readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
    sources: {
      'u:alice@x.com': {
        read: [{ kind: 'ancestor', path: parent }],
        write: [{ kind: 'ancestor', path: parent }],
      },
    },
  } as unknown as AccessResponse;
}

/** Alice holds edit granted right here: no notes on any item. */
const EDIT_HERE = {
  ...BLANK,
  eligible: { principals: [], roles: [], users: [ALICE] },
  readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
  sources: { 'u:alice@x.com': { read: [{ kind: 'direct' }], write: [{ kind: 'direct' }] } },
} as unknown as AccessResponse;

/** After `deny write` here: read still from the parent at `parent`, write restricted here. */
function writeRestrictedHere(parent: string): AccessResponse {
  return {
    ...BLANK,
    readers: { restricted: true, principals: [], roles: [], users: [ALICE] },
    sources: { 'u:alice@x.com': { read: [{ kind: 'ancestor', path: parent }] } },
    denials: { 'u:alice@x.com': { write: [{ kind: 'direct' }] } },
    deniedHere: { principals: [], users: [ALICE] },
  } as unknown as AccessResponse;
}

/** A folder name long enough that "Can edit · from <it>" measures between the floor and the cap. */
const MID_PARENT = 'Regional-Sales-Operations/access.md';

/** The width the stub gives a panel: its widest item's text, 8px a character. */
function widestItemPx(panel: HTMLElement): number {
  const items = Array.from(panel.querySelectorAll('button'));
  return Math.max(...items.map((b) => (b.textContent ?? '').length)) * PX_PER_CHAR;
}

/** Open Alice's row menu; return the item panel and the positioned wrapper the width is pinned on. */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  summary: RegExp,
): Promise<{ panel: HTMLElement; wrapper: HTMLElement }> {
  const triggers = await screen.findAllByRole('button', { name: summary });
  await user.click(triggers[triggers.length - 1]);
  const panel = screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0]
    .parentElement as HTMLElement;
  return { panel, wrapper: panel.parentElement as HTMLElement };
}

let offsetWidth: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  api.suggestPrincipals.mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
  // jsdom lays nothing out: every element is 0px wide. Give the positioned
  // wrapper the width its widest item would take — which is what a real
  // `max-content` measurement returns — and leave everything else at 0.
  offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('fixed') ? widestItemPx(this) : 0;
  });
});
afterEach(() => {
  offsetWidth.mockRestore();
});

describe('ManageAccessDialog row menu: width follows the items', () => {
  it('a menu whose items carry notes is as wide as its widest item, wider than the minimum', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(editFrom(MID_PARENT));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await user.click(
      await screen.findByRole('button', { name: /People invited to Regional-Sales-Operations/ }),
    );
    await screen.findByText('Alice');

    const { panel, wrapper } = await openRowMenu(user, /^can edit$/i);
    const expected = widestItemPx(panel);
    expect(expected).toBeGreaterThan(MIN);
    expect(expected).toBeLessThan(MAX);
    await waitFor(() => expect(wrapper.style.width).toBe(`${expected}px`));
    // The label is whole: it is the note beside it that is bounded.
    const edit = within(panel).getByRole('button', { name: /^can edit$/i });
    expect(edit).toHaveTextContent(/^Can edit/);
    expect(edit.querySelector('[title="from Regional-Sales-Operations"]')).toHaveClass('truncate');
  });

  it('a menu with no notes sits at the minimum width', async () => {
    const user = userEvent.setup();
    api.fetchFileAccess.mockResolvedValue(EDIT_HERE);
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await screen.findByText('Alice');

    const { panel, wrapper } = await openRowMenu(user, /^can edit$/i);
    expect(widestItemPx(panel)).toBeLessThan(MIN);
    await waitFor(() => expect(wrapper.style.width).toBe(`${MIN}px`));
  });

  it('a very long folder name stops at the cap, and the note is what truncates, with its full text on hover', async () => {
    const user = userEvent.setup();
    const longParent = 'Very-Long-Department-Name-For-Testing-Purposes/access.md';
    api.fetchFileAccess.mockResolvedValue(editFrom(longParent));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await user.click(
      await screen.findByRole('button', { name: /People invited to Very-Long-Department-Name/ }),
    );
    await screen.findByText('Alice');

    const { panel, wrapper } = await openRowMenu(user, /^can edit$/i);
    expect(widestItemPx(panel)).toBeGreaterThan(MAX);
    await waitFor(() => expect(wrapper.style.width).toBe(`${MAX}px`));
    const note = panel.querySelector('[title="from Very-Long-Department-Name-For-Testing-Purposes"]');
    expect(note).toHaveClass('truncate');
    expect(note).toHaveClass('max-w-44');
  });

  it('re-measures when the items change while the menu stays open', async () => {
    const user = userEvent.setup();
    // Short notes to start with ("from Sales"): the widest item is under the
    // floor, so the menu opens at the minimum.
    api.fetchFileAccess.mockResolvedValue(editFrom('Sales/access.md'));
    // The fresh view after the write names a longer folder for the read that
    // remains, so the widest item now clears the floor.
    api.revokeAccess.mockResolvedValue(writeRestrictedHere(MID_PARENT));
    render(<ManageAccessDialog entry={FOLDER} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /People invited to Sales/ }));
    await screen.findByText('Alice');

    const { panel, wrapper } = await openRowMenu(user, /^can edit$/i);
    expect(widestItemPx(panel)).toBeLessThan(MIN);
    await waitFor(() => expect(wrapper.style.width).toBe(`${MIN}px`));

    // Picking Can read writes a deny and the fresh view relabels the items:
    // "restricted here" on Can edit, "from Regional-Sales-Operations" on Can
    // read. The menu stays open, so its width has to follow the new widest
    // item — which the observer on the pinned wrapper alone could never see.
    await user.click(within(panel).getByRole('button', { name: /^can read$/i }));
    await waitFor(() => expect(api.revokeAccess).toHaveBeenCalledTimes(1));
    // The restriction makes her a row of THIS folder, so the row — and the
    // open menu with it — remounts in the other section: find it again.
    const relocated = await waitFor(() => {
      const p = screen.getAllByRole('button', { name: /^deny$/i }).slice(-1)[0]
        .parentElement as HTMLElement;
      expect(p.querySelector('[title="restricted here"]')).not.toBeNull();
      return p;
    });
    const after = widestItemPx(relocated);
    expect(after).toBeGreaterThan(MIN);
    await waitFor(() =>
      expect((relocated.parentElement as HTMLElement).style.width).toBe(`${after}px`),
    );
  });
});
