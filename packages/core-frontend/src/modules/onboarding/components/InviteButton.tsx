import { Users } from 'lucide-react';
import { Button } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { useInviteDialog } from '../state/invite-dialog.context';

/**
 * The toolbar's Invite button — admins only, because creating accounts is an
 * admin act and a button that answers "Admins only" is worse than none.
 * Opens the same dialog as the "Get set up" column's invite step.
 *
 * Renders nothing outside an invite provider: the toolbar is mounted bare in
 * tests and by hosts, and a button with nothing to open is a dead control.
 */
export function InviteButton() {
  const { isAdmin } = useAdmin();
  const invite = useInviteDialog();
  if (!isAdmin || !invite) return null;
  return (
    <Button size="sm" leadingIcon={<Users size={14} aria-hidden />} onClick={invite.open}>
      Invite
    </Button>
  );
}
