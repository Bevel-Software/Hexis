import { Users } from 'lucide-react';
import { Button, IconButton } from '../../../shared/components';
import { useInviteDialog } from '../state/invite-dialog.context';

/**
 * The toolbar's Invite button, shown to everyone signed in. A click opens
 * the Invite dialog — the same one as the "Get set up" column's invite step
 * — for an admin and anyone else alike: anyone signed in invites, and the
 * dialog offers the Role choice only to an admin.
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
  const invite = useInviteDialog();
  if (!invite) return null;
  const onClick = () => invite.open();
  return compact ? (
    <IconButton aria-label="Invite" title="Invite" onClick={onClick}>
      <Users size={16} aria-hidden />
    </IconButton>
  ) : (
    <Button size="sm" leadingIcon={<Users size={14} aria-hidden />} onClick={onClick}>
      Invite
    </Button>
  );
}
