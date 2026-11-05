import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminContext } from '../state/admin.context';
import { RolesCorruptedBanner } from '../components/RolesCorruptedBanner';
import { ConfirmProvider } from '../../../shared/components';

/**
 * Bevel Recovery asks before it runs — in the app's own dialog, which the
 * browser cannot silence — with today's text.
 */

const QUESTION =
  'Bevel Recovery will back up the corrupted roles.yaml to old-roles.yaml and ' +
  'restore the default Bevel roster. Only continue if you are from Bevel. Proceed?';

let confirmSpy: MockInstance<Window['confirm']>;
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
});
afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function renderBanner() {
  const runRolesRecovery = vi.fn(async () => {});
  render(
    <ConfirmProvider>
      <AdminContext.Provider
        value={{
          isAdmin: true,
          isAdminLoading: false,
          unreadCount: 0,
          lastSeen: null,
          markSeen: () => {},
          refresh: () => {},
          rolesConfigCorrupted: true,
          rolesConfigErrors: ['bad indent'],
          runRolesRecovery,
        } as never}
      >
        <RolesCorruptedBanner />
      </AdminContext.Provider>
    </ConfirmProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Bevel Recovery/ }));
  return runRolesRecovery;
}

describe('roles recovery', () => {
  it("asks with today's text; Cancel runs nothing", async () => {
    const run = renderBanner();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(QUESTION);
    expect(within(dialog).queryByText("Don't ask again")).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(run).not.toHaveBeenCalled();
  });

  it('Proceed runs the recovery, with the browser\'s dialogs suppressed', async () => {
    const run = renderBanner();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Proceed' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
});
