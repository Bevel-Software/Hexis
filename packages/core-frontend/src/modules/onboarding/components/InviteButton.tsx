import { Users } from 'lucide-react';
import { Button, IconButton } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { useInviteDialog } from '../state/invite-dialog.context';

/**
 * The toolbar's Invite button — admins only, because creating accounts is an
 * admin act and a button that answers "Admins only" is worse than none.
 * Opens the same dialog as the "Get set up" column's invite step.
 *
 * `compact` is the toolbar's narrow layout, where every control shares one
 * row with the essentials: the button sheds its word and keeps the icon, so
 * it cannot push the profile menu off-screen. Its name stays "Invite" either
 * way — the label carries it where the word is gone.
 *
 * Renders nothing outside an invite provider: the toolbar is mounted bare in
 * tests and by hosts, and a button with nothing to open is a dead control.
 */
export function InviteButton({ compact = false }: { compact?: boolean }) {
  const { isAdmin } = useAdmin();
  const invite = useInviteDialog();
  if (!isAdmin || !invite) return null;
  if (compact) {
    return (
      <IconButton aria-label="Invite" title="Invite" onClick={invite.open}>
        <Users size={16} aria-hidden />
      </IconButton>
    );
  }
  return (
    <Button size="sm" leadingIcon={<Users size={14} aria-hidden />} onClick={invite.open}>
      Invite
    </Button>
  );
}
