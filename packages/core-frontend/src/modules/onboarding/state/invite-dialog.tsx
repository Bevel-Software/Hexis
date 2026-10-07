import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { InviteDialog } from '../components/InviteDialog';
import { InviteDialogContext } from './invite-dialog.context';

/**
 * Hosts the invite dialog for everything below it (see
 * `invite-dialog.context.ts` for what it shares). Mounted in `AppChrome`, so
 * the dialog renders INSIDE the registry's providers — the `inviteExtras`
 * slot it carries may read state a distribution provides there.
 *
 * The dialog only mounts while open, so the provider costs nothing — and
 * reads nothing, not even the admin verdict — until somebody asks for it.
 */
export function InviteDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [invitedRevision, setInvitedRevision] = useState(0);
  const open = useCallback(() => setIsOpen(true), []);
  const value = useMemo(() => ({ open, invitedRevision }), [open, invitedRevision]);
  return (
    <InviteDialogContext.Provider value={value}>
      {children}
      {isOpen && (
        <InviteDialog
          open
          onClose={() => setIsOpen(false)}
          onInvited={() => setInvitedRevision((r) => r + 1)}
        />
      )}
    </InviteDialogContext.Provider>
  );
}
