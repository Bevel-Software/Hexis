import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KbPageHeader, type KbPageHeaderProps } from '../KbPageHeader';

function renderHeader(overrides: Partial<KbPageHeaderProps> = {}) {
  const props: KbPageHeaderProps = {
    path: 'knowledge-base/Knowledge/Invariant.md',
    canWrite: true,
    editMode: false,
    entering: false,
    lockedBy: null,
    historyAvailable: true,
    isDirty: false,
    waitingOnAgentUpdate: false,
    isReviewingPending: false,
    activeTab: 'content',
    onEdit: vi.fn(),
    onDone: vi.fn(),
    onOpenHistory: vi.fn(),
    onShare: vi.fn(),
    onCopyPage: vi.fn(async () => true),
    onCopyLink: vi.fn(async () => true),
    ...overrides,
  };
  return { props, ...render(<KbPageHeader {...props} />) };
}

describe('KbPageHeader', () => {
  it('leads with the basename, minus a known extension', () => {
    renderHeader();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invariant');
  });

  it('leaves an unknown extension alone', () => {
    renderHeader({ path: 'Knowledge/roles.unknownext' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('roles.unknownext');
  });

  it('shows the name verbatim for a file with no extension', () => {
    renderHeader({ path: 'Knowledge/LICENSE' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('LICENSE');
  });

  it('opens Manage access from Share, and offers the link behind the chevron', async () => {
    const user = userEvent.setup();
    const { props } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onShare).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(screen.getByRole('menuitem', { name: /Manage access/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy link to this page/ })).toBeInTheDocument();
  });

  // This page shares ONE thing. "Share the whole folder" was one click from
  // handing over everything in the folder, with nothing on screen showing what
  // "everything" was; it lives on the folder's own tree row now.
  it('does not offer to share the whole folder', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(screen.queryByRole('menuitem', { name: /whole folder/i })).not.toBeInTheDocument();
  });

  // `canWrite` is `boolean | null`, and null means "not known yet". Treating it
  // as false would flicker the button out on every file open.
  it('hides Edit only on a hard false — null still renders it', () => {
    const { unmount } = renderHeader({ canWrite: false });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    unmount();

    renderHeader({ canWrite: null });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('disables Edit while someone else holds the lock and names the holder', () => {
    renderHeader({ lockedBy: 'Ali Raza' });
    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Locked by Ali Raza');
  });

  it('swaps Edit for Done in edit mode', () => {
    renderHeader({ editMode: true });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  // The pairing FileViewer.test.tsx already asserts: the review badge and the
  // button's absence in the same case.
  it('renders the review badge and no Edit while a pending agent update is under review', () => {
    renderHeader({ isReviewingPending: true });
    expect(screen.getByText('Reviewing agent update')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('renders the Unsaved and Agent-update badges independently', () => {
    const { unmount } = renderHeader({ isDirty: true });
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    expect(screen.queryByText('Agent update waiting')).not.toBeInTheDocument();
    unmount();

    renderHeader({ waitingOnAgentUpdate: true });
    expect(screen.getByText('Agent update waiting')).toBeInTheDocument();
  });

  it('offers the whole overflow behind ⋯', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: /Version history/ })).toBeInTheDocument();
  });

  // Copying a reference to this page is one errand, and Share owns it. Two
  // menus offering near-identical copies is how someone pastes the wrong one.
  it('does not repeat Copy path in the overflow — Share owns copying a reference', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: /Copy path/i })).not.toBeInTheDocument();
  });

  // Version history is the whole menu now, so git not being ready leaves
  // nothing behind ⋯ — and the trigger goes with it rather than opening onto
  // an empty panel.
  it('drops the ⋯ trigger entirely when git is not ready', () => {
    renderHeader({ historyAvailable: false });
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  // A copy that fails must say so — `navigator.clipboard` rejects outright on
  // a non-secure origin, and a silent no-op is the worst possible answer.
  it('confirms a copy on the control that was clicked', async () => {
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Copy page as Markdown' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reports a failed copy rather than swallowing it', async () => {
    const user = userEvent.setup();
    renderHeader({ onCopyPage: vi.fn(async () => false) });
    await user.click(screen.getByRole('button', { name: 'Copy page as Markdown' }));
    expect(await screen.findByRole('button', { name: "Couldn't copy" })).toBeInTheDocument();
  });

  // Copy link's confirmation is the ROW, and the row is inside the menu — so
  // the menu has to outlive the copy. Closing it first would leave the one
  // action on this page with no answer at all.
  it('confirms a copied link on the row, before the menu goes away', async () => {
    const user = userEvent.setup();
    const { props } = renderHeader();
    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy link to this page/ }));
    expect(props.onCopyLink).toHaveBeenCalled();
    expect(await screen.findByRole('menuitem', { name: /Copied/ })).toBeInTheDocument();
  });

  it('says so on the row when copying the link fails', async () => {
    const user = userEvent.setup();
    renderHeader({ onCopyLink: vi.fn(async () => false) });
    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy link to this page/ }));
    expect(await screen.findByRole('menuitem', { name: /Couldn't copy/ })).toBeInTheDocument();
  });

  it('omits Copy page entirely when there is no markdown to copy', () => {
    renderHeader({ onCopyPage: undefined });
    expect(screen.queryByRole('button', { name: /Copy page/ })).not.toBeInTheDocument();
  });

  it('closes an open menu on Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    renderHeader();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    await user.click(trigger);
    expect(screen.getByRole('menu', { name: 'More actions' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(screen.queryByRole('menu', { name: 'More actions' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});
