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
  // While open, the addresses the dialog starts with; null while closed. An
  // open while already open keeps the dialog as it is.
  const [openWith, setOpenWith] = useState<string[] | null>(null);
  const [invitedRevision, setInvitedRevision] = useState(0);
  // Also wired straight to onClick handlers, so `options` may be a click
  // event: only an array of addresses counts.
  const open = useCallback((options?: { emails?: string[] }) => {
    const emails = options?.emails;
    setOpenWith((current) => current ?? (Array.isArray(emails) ? emails : []));
  }, []);
  const value = useMemo(() => ({ open, invitedRevision }), [open, invitedRevision]);
  return (
    <InviteDialogContext.Provider value={value}>
      {children}
      {openWith && (
        <InviteDialog
          open
          initialEmails={openWith}
          onClose={() => setOpenWith(null)}
          onInvited={() => setInvitedRevision((r) => r + 1)}
        />
      )}
    </InviteDialogContext.Provider>
  );
}
