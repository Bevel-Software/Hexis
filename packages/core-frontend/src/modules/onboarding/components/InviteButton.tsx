import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { Button, IconButton, MenuPanel, buttonClasses, useDismissableMenu } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { fetchAdmins, type AdminContact } from '../../access/api';
import { useInviteDialog } from '../state/invite-dialog.context';

/**
 * An email to one admin asking them to invite someone: the person only has
 * to fill in who. The workspace's address is in it so the admin knows which
 * workspace is meant.
 */
function inviteRequestMailto(admin: AdminContact, origin: string): string {
  const first = admin.name.split(/\s+/)[0] || admin.name;
  const subject = 'Please invite someone to Hexis';
  const body = `Hi ${first},\n\nCould you invite ... to our workspace at ${origin}?\n\nThanks`;
  return `mailto:${admin.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The toolbar's Invite button, shown to everyone signed in. An admin's click
 * opens the Invite dialog — the same one as the "Get set up" column's invite
 * step. Anyone else's opens a popover under the button saying only admins
 * add people, and listing the admins, each with an Email button: a person
 * who wants a colleague in learns how to get them in. The popover creates
 * nothing, and closes like the profile menu (a click outside, or Escape,
 * which hands focus back to the button).
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
  const { isAdmin, isAdminLoading = false } = useAdmin();
  const invite = useInviteDialog();
  const [asking, setAsking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useDismissableMenu<HTMLDivElement>({
    open: asking,
    onClose: () => setAsking(false),
    returnFocusTo: triggerRef,
  });
  if (!invite) return null;

  // While the admin check is still out, a click does nothing rather than
  // show an admin the ask-an-admin popover.
  const onClick = isAdmin ? () => invite.open() : isAdminLoading ? () => {} : () => setAsking((a) => !a);
  const expanded = isAdmin || isAdminLoading ? undefined : asking;
  const trigger = compact ? (
    <IconButton ref={triggerRef} aria-label="Invite" title="Invite" aria-expanded={expanded} onClick={onClick}>
      <Users size={16} aria-hidden />
    </IconButton>
  ) : (
    <Button
      ref={triggerRef}
      size="sm"
      leadingIcon={<Users size={14} aria-hidden />}
      aria-expanded={expanded}
      onClick={onClick}
    >
      Invite
    </Button>
  );

  return (
    <div className="relative">
      {trigger}
      {asking && !isAdmin && (
        <div ref={panelRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
          <AskAnAdmin />
        </div>
      )}
    </div>
  );
}

/**
 * The popover's body. Reads the admins as it opens; when they cannot be
 * read it keeps its two lines and lists nobody — the person still learns
 * that only admins invite.
 */
function AskAnAdmin() {
  const [admins, setAdmins] = useState<AdminContact[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAdmins().then(
      (list) => {
        if (!cancelled) setAdmins(list);
      },
      () => {
        if (!cancelled) setAdmins([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const origin = window.location.origin;
  return (
    <MenuPanel role="group" aria-label="Ask an admin to invite people" className="w-[320px] p-3">
      <p className="text-strong font-semibold text-ink">Ask an admin to invite people</p>
      <p className="mt-1 text-ui text-ink-muted">Only admins can add people to this workspace.</p>
      {admins && admins.length > 0 && (
        <ul aria-label="Admins" className="mt-3 max-h-64 overflow-y-auto border-t border-line pt-1.5">
          {admins.map((admin) => (
            <li key={admin.email} className="flex items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium text-ink">{admin.name}</p>
                <p className="truncate text-detail text-ink-muted">{admin.email}</p>
              </div>
              <a
                href={inviteRequestMailto(admin, origin)}
                aria-label={`Email ${admin.name}`}
                className={buttonClasses({ variant: 'outline', size: 'sm' })}
              >
                Email
              </a>
            </li>
          ))}
        </ul>
      )}
    </MenuPanel>
  );
}
