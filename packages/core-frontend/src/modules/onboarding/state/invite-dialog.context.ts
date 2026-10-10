import { createContext, useContext } from 'react';

/**
 * The invite dialog's channel, split out from the provider that renders it so
 * the provider module exports only a component (Fast Refresh; the same split
 * as `library/state/toast.context.ts` / `toast.tsx`). The provider lives in
 * `./invite-dialog.tsx`.
 *
 * What the invite entry points share: a way to open THE invite dialog, and a
 * counter that moves every time it invited somebody.
 *
 * Several places open it — the toolbar's Invite button, the "Get set up"
 * column, User accounts' "Invite new users" row and Manage access's Invite
 * on a person with no account — and they must open the same dialog rather
 * than one each, or the column's "Invite your team" would tick from one and
 * not the other. The
 * counter is how the column hears about it: it re-reads the account list
 * when `invitedRevision` moves instead of polling for a change it caused.
 */
export interface InviteDialogController {
  /** `emails` fills in the address field (Manage access's Invite). */
  open(options?: { emails?: string[] }): void;
  invitedRevision: number;
}

export const InviteDialogContext = createContext<InviteDialogController | null>(null);

/**
 * The shared controller, or null outside a provider. Null rather than a throw
 * because the toolbar is rendered bare in its own tests, and an entry point
 * with nothing to open should simply not be offered.
 */
export function useInviteDialog(): InviteDialogController | null {
  return useContext(InviteDialogContext);
}
