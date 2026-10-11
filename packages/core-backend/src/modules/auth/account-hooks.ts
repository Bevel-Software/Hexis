import type { AuthUser } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';

const log = logger('accounts');

/**
 * An admin invited somebody: a NEW account was made for the address. Never
 * raised for an account that was already there (an invite that only set a
 * starting password, a password reset, a rename), and never for a first
 * single sign-on, which provisions by itself: the person is already in.
 */
export interface AccountInvitedEvent {
  /** The new account, as the admin's answer carries it. */
  account: Pick<AuthUser, 'id' | 'email' | 'name'>;
  /** The admin who invited them. */
  invitedBy: Pick<AuthUser, 'id' | 'email' | 'name'>;
  /**
   * Whether the account was created with a starting password the admin
   * typed. The password itself never travels: a listener that writes to the
   * person says it comes from the admin separately.
   */
  passwordSet: boolean;
}

/**
 * A listener answers how it reached the person — a non-empty channel name,
 * `'email'` say — or null when it did not (nothing configured, the send
 * failed). It is awaited: the admin's answer says who was notified,
 * truthfully, so a listener bounds its own wait. A throw is logged and
 * counts as null; it never fails the invite. An empty name is no channel and
 * counts as null too.
 */
export type AccountInvitedHook = (event: AccountInvitedEvent) => Promise<string | null>;

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
  private readonly invited: AccountInvitedHook[] = [];

  onAccountInvited(hook: AccountInvitedHook): void {
    this.invited.push(hook);
  }

  async runAccountInvited(event: AccountInvitedEvent): Promise<string[]> {
    const notified: string[] = [];
    for (const hook of this.invited) {
      try {
        const channel = await hook(event);
        if (channel !== null && channel !== '') notified.push(channel);
      } catch (err) {
        // The account exists whether or not the person was told: the admin's
        // answer says they were not, and the admin sends the link themselves.
        log.error('an account-invited listener failed; the person was not notified by it:', { err });
      }
    }
    return notified;
  }
}
