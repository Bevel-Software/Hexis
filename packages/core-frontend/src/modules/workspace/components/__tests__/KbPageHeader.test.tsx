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
    railOpen: false,
    historyAvailable: true,
    isDirty: false,
    waitingOnAgentUpdate: false,
    isReviewingPending: false,
    activeTab: 'content',
    onEdit: vi.fn(),
    onDone: vi.fn(),
    onToggleRail: vi.fn(),
    onOpenHistory: vi.fn(),
    onOpenCompare: vi.fn(),
    onShare: vi.fn(),
    onCopyPage: vi.fn(async () => true),
    onCopyLink: vi.fn(async () => true),
    onCopyPath: vi.fn(async () => true),
    onViewRaw: vi.fn(),
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

  it('opens the file dialog from Share, and offers link + folder behind the chevron', async () => {
    const user = userEvent.setup();
    const { props } = renderHeader();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(props.onShare).toHaveBeenCalledWith('file');

    await user.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(screen.getByRole('menuitem', { name: /Manage access/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Copy link to this page/ })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /Share the whole folder/ }));
    expect(props.onShare).toHaveBeenCalledWith('folder');
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
    for (const label of [
      /File details/,
      /Version history/,
      /Compare versions/,
      /View raw file/,
      /Copy path/,
    ]) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('hides both history entries when git is not ready', async () => {
    const user = userEvent.setup();
    renderHeader({ historyAvailable: false });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: /Version history/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Compare versions/ })).not.toBeInTheDocument();
    // …and the rest of the menu is intact.
    expect(screen.getByRole('menuitem', { name: /View raw file/ })).toBeInTheDocument();
  });

  it('names the rail toggle by what clicking it will do', async () => {
    const user = userEvent.setup();
    const { props } = renderHeader({ railOpen: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Hide file details/ }));
    expect(props.onToggleRail).toHaveBeenCalled();
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
