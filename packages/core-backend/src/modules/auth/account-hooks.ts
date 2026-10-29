import type { AuthUser } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { ListenerSeam, type NotifyingListener } from '../../shared/listener-seam.js';

const log = logger('accounts');

/**
 * Somebody invited somebody: a NEW account was made for the address, by an
 * admin or by anyone signed in (`POST /api/invitations`). Never raised for an
 * account that was already there (a password reset, a rename), and never
 * for a first single sign-on, which provisions by itself: the person is
 * already in.
 */
export interface AccountInvitedEvent {
  /** The new account, as the inviter's answer carries it. */
  account: Pick<AuthUser, 'id' | 'email' | 'name'>;
  /** Who invited them. */
  invitedBy: Pick<AuthUser, 'id' | 'email' | 'name'>;
  /** Whether the account was created with a starting password. */
  passwordSet: boolean;
  /**
   * The starting password the platform generated for the account, absent
   * when none was. It travels here so a listener that writes to the person
   * can put it in the invitation, with the request to sign in and change
   * it; a listener must not log it or keep it.
   */
  startingPassword?: string;
}

/**
 * Who invited, for the event: their account, by name, when it can be read.
 * The invited account is already made by the time this is asked, so a failed
 * read falls back to the identity the request carries rather than answering
 * an error a retry could not make good (the account is not new the second
 * time).
 */
export async function inviterOf(
  caller: { userId?: string; userEmail?: string },
  getUserById: (id: string) => Promise<AuthUser | null>,
): Promise<Pick<AuthUser, 'id' | 'email' | 'name'>> {
  const requester = { id: caller.userId ?? '', email: caller.userEmail ?? '', name: '' };
  if (!caller.userId) return requester;
  const by = await getUserById(caller.userId).catch((err: unknown) => {
    log.warn('the inviter could not be read; the invite names them by address:', { err });
    return null;
  });
  return by ?? requester;
}

/**
 * A listener answers how it reached the person — a non-empty channel name,
 * `'email'` say — or null when it did not; the rule is {@link NotifyingListener}'s:
 * awaited, a throw logged and counted as null, never failing the invite.
 */
export type AccountInvitedHook = NotifyingListener<AccountInvitedEvent>;

/**
 * Core's seam for "an account was invited": a deployment (the cloud with its
 * mail, an enterprise overlay) registers how to tell the person, and core
 * says in its answer whether somebody did. Core registers nothing, so a
 * core-only deployment notifies nobody and the admin is handed the link and
 * the message to send, as before.
 */
export interface IAccountHooks {
  onAccountInvited(hook: AccountInvitedHook): void;
  /** Run every listener in registration order; the channels that reached the person, in that order. */
  runAccountInvited(event: AccountInvitedEvent): Promise<string[]>;
}

export class AccountHooks implements IAccountHooks {
  // The account exists whether or not the person was told: the admin's
  // answer says they were not, and the admin sends the link themselves.
  private readonly invited = new ListenerSeam<AccountInvitedEvent>(
    log,
    'an account-invited listener failed; the person was not notified by it:',
    // A mailer's error can quote the message it was sending, password and all.
    (event) => [event.startingPassword],
  );

  onAccountInvited(hook: AccountInvitedHook): void {
    this.invited.add(hook);
  }

  runAccountInvited(event: AccountInvitedEvent): Promise<string[]> {
    return this.invited.run(event);
  }
}
