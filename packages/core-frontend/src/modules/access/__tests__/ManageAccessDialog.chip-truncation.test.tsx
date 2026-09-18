import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

/** Nothing granted yet — the sheet opens on an empty, manageable file. */
const VIEW = {
  canRead: true,
  canWrite: true,
  canDownload: false,
  canOwner: false,
  eligible: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  owners: { roles: [], users: [] },
  downloaders: { roles: [], users: [] },
  sources: {},
} as AccessResponse;

/** The address from the tester's report: one unbroken run, wider than the field. */
const LONG_EMAIL = 'agent-interaction-test-user@example.invalid';
/** A group name long enough to overflow, and with no space to wrap on either. */
const LONG_GROUP = 'KnowledgeBasePlatformReliabilityWorkingGroupEurope';

/**
 * The chip is the element the remove button sits in — found from the button so
 * the test never depends on where in the tree the field puts it.
 */
function chipFor(label: string): HTMLElement {
  const remove = screen.getByRole('button', { name: `Remove ${label}` });
  const chip = remove.parentElement;
  if (!chip) throw new Error(`chip for ${label} has no parent`);
  return chip;
}

describe('ManageAccessDialog: a picked chip is bounded by the field it sits in', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchFileAccess.mockResolvedValue(VIEW);
    api.grantAccess.mockResolvedValue(VIEW);
  });

  /**
   * happy-dom runs no layout engine and loads no Tailwind stylesheet, so a
   * width here would only ever read 0. What these assert instead is the whole
   * mechanism the fix is: the chip is clamped to its container, only the label
   * gives way, and the remove control does not. That is what a browser needs to
   * keep the chip inside the box, and it is checkable without a renderer.
   */
  async function pickAndAssertChip(label: string) {
    const chip = chipFor(label);
    // 1. The chip can never be wider than the field it is laid out in, and it
    //    is allowed to shrink below its own content.
    expect(chip).toHaveClass('max-w-full');
    expect(chip).toHaveClass('min-w-0');

    // 2. The label is the part that truncates, and it carries the full name as
    //    its tooltip.
    const labelEl = chip.querySelector('[title]');
    expect(labelEl).not.toBeNull();
    expect(labelEl).toHaveTextContent(label);
    expect(labelEl).toHaveAttribute('title', label);
    expect(labelEl).toHaveClass('truncate');
    expect(labelEl).toHaveClass('min-w-0');

    // 3. The remove button keeps its full size at the end of the chip, and its
    //    accessible name is the whole untruncated label.
    const remove = screen.getByRole('button', { name: `Remove ${label}` });
    expect(remove).toHaveClass('shrink-0');
    // Last child: visibly at the end, after the label, in reading order too.
    expect(chip.lastElementChild).toBe(remove);

    // 4. Nothing in the chip is measured in pixels — the bound is a percentage
    //    of the field and the padding/text are rem — so zooming to 200% scales
    //    the chip and the field together instead of bursting one out of the
    //    other.
    expect(chip.getAttribute('style')).toBeNull();
    expect(remove.getAttribute('style')).toBeNull();
    for (const el of [chip, labelEl as Element]) {
      expect(el.className).not.toMatch(/\[\d+(?:\.\d+)?px\]/);
    }
  }

  it('a long email picked from the suggestions truncates in its chip, tooltip and remove intact', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [],
      // No display name: the label the chip renders IS the long address.
      people: [{ name: '', email: LONG_EMAIL }],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText('Add people, groups, roles or plugins…'),
      'agent',
    );
    await user.click(await screen.findByRole('button', { name: new RegExp(LONG_EMAIL) }));

    await pickAndAssertChip(LONG_EMAIL);
  });

  it('a long unbroken group name truncates the same way', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [LONG_GROUP],
      people: [],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    await user.type(
      await screen.findByPlaceholderText('Add people, groups, roles or plugins…'),
      'knowledge',
    );
    await user.click(await screen.findByRole('button', { name: new RegExp(LONG_GROUP) }));

    await pickAndAssertChip(LONG_GROUP);
  });

  it('two long chips stay inside the one field, which wraps them rather than stretching', async () => {
    const user = userEvent.setup();
    api.suggestPrincipals.mockResolvedValue({
      roles: [],
      groups: [LONG_GROUP],
      people: [{ name: '', email: LONG_EMAIL }],
      peopleWithheld: false,
    });
    render(<ManageAccessDialog entry={ENTRY} onClose={() => {}} />);

    const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
    await user.type(input, 'long');
    await user.click(await screen.findByRole('button', { name: new RegExp(LONG_GROUP) }));
    await user.type(input, 'long');
    await user.click(await screen.findByRole('button', { name: new RegExp(LONG_EMAIL) }));

    await pickAndAssertChip(LONG_GROUP);
    await pickAndAssertChip(LONG_EMAIL);

    // Both chips share one field box, and that box wraps: a second long chip
    // goes onto a new line inside the border instead of widening it.
    const field = chipFor(LONG_GROUP).parentElement as HTMLElement;
    expect(chipFor(LONG_EMAIL).parentElement).toBe(field);
    expect(field).toHaveClass('flex-wrap');
    expect(field).toHaveClass('w-full');
  });
});
