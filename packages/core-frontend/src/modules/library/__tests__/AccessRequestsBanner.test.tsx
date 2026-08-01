import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccessRequestsBanner } from '../components/AccessRequestsBanner';
import type { GroupAccessRequestEntry } from '../services/groups.api';

/**
 * The admin notice. Who it names, what it offers, and — the part that is easy
 * to get wrong — that it disappears entirely rather than leaving an empty
 * bordered box behind when there is nothing pending.
 */

const request = (over: Partial<GroupAccessRequestEntry> = {}): GroupAccessRequestEntry => ({
  id: 'req-1',
  group: 'Finance',
  requesterName: 'Juan Viera',
  requesterEmail: 'juan@bevel.software',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function renderBanner(
  requests: GroupAccessRequestEntry[],
  folders: string[] = ['Groups/Finance'],
) {
  const onManage = vi.fn();
  const onDismiss = vi.fn();
  const view = render(
    <AccessRequestsBanner
      group="Finance"
      folders={folders}
      requests={requests}
      onManage={onManage}
      onDismiss={onDismiss}
    />,
  );
  return { ...view, onManage, onDismiss };
}

describe('AccessRequestsBanner', () => {
  it('names one requester and says what granting read would do', () => {
    renderBanner([request()]);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.getByText('Juan Viera asked to join Finance — grant read access to let them in.'),
    ).toBeInTheDocument();
  });

  it('counts and lists several requesters', () => {
    renderBanner([
      request(),
      request({ id: 'req-2', requesterName: 'Ali Baba' }),
      request({ id: 'req-3', requesterName: 'Olga Ivanova' }),
    ]);
    expect(
      screen.getByText('3 people asked to join Finance: Juan Viera, Ali Baba and Olga Ivanova.'),
    ).toBeInTheDocument();
  });

  it('never prints a requester email, even though the endpoint hands one over', () => {
    const { container } = renderBanner([request()]);
    expect(container.textContent).not.toContain('@');
  });

  it('opens the access dialog on the group folder', () => {
    const { onManage } = renderBanner([request()]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage access' }));
    expect(onManage).toHaveBeenCalledWith('Groups/Finance');
  });

  it('offers one button per folder on an unmigrated KB, named by its root', () => {
    // `Skills/Finance` and `Tools/Finance` carry SEPARATE access.md files —
    // one button would silently grant half the group.
    const { onManage } = renderBanner([request()], ['Skills/Finance', 'Tools/Finance']);
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage access (Skills)' }));
    expect(onManage).toHaveBeenCalledWith('Skills/Finance');
    fireEvent.click(screen.getByRole('button', { name: 'Manage access (Tools)' }));
    expect(onManage).toHaveBeenCalledWith('Tools/Finance');
  });

  it('dismisses one named requester at a time', () => {
    const { onDismiss } = renderBanner([
      request(),
      request({ id: 'req-2', requesterName: 'Ali Baba' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss request from Ali Baba' }));
    expect(onDismiss).toHaveBeenCalledWith('req-2');
  });

  it('renders nothing at all with no pending requests', () => {
    const { container } = renderBanner([]);
    expect(container.firstChild).toBeNull();
  });
});
