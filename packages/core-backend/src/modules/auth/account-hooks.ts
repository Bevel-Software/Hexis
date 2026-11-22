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
   * (their email, the companion in their chat app) can put it in the
   * invitation, with the request to sign in and change it; a listener must
   * not log it or keep it. A listener that did put it in front of the
   * person says so in its answer ({@link AccountInvitedAnswer}): the inviter
   * is then not shown it.
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
  // The three fields the event promises, and nothing else the account row carries.
  return by ? { id: by.id, email: by.email, name: by.name } : requester;
}

/**
 * How a listener reached the invited person: a non-empty channel name
 * (`'email'`, `'companion'`) when it told them of the invite, or null
 * when it did not. `{ channel, deliveredStartingPassword: true }` says more:
 * what it sent them carried the event's `startingPassword`, so they have it
 * without the inviter (the credential delivery policy: a password the
 * person was sent directly is not also handed to whoever invited them). A
 * plain channel name never claims that, so a mail that only announces the
 * invite leaves the password with the inviter, as before.
 */
export type AccountInvitedAnswer = string | null | { channel: string; deliveredStartingPassword: boolean };

/**
 * A listener answers {@link AccountInvitedAnswer}; otherwise the rule is
 * {@link NotifyingListener}'s: awaited, a throw logged and counted as null,
 * never failing the invite.
 */
export type AccountInvitedHook = (event: AccountInvitedEvent) => Promise<AccountInvitedAnswer>;

/**
 * What the listeners did with an invite. `notified`: the channels that
 * reached the person, in registration order. `passwordDeliveredBy`: of
 * those, the ones that carried the starting password to them; always empty
 * for an event with no `startingPassword`.
 */
export interface AccountInvitedNotice {
  notified: string[];
  passwordDeliveredBy: string[];
}

/** One run of the invited listeners: the event, and where the delivered password went. */
interface InvitedRun {
  event: AccountInvitedEvent;
  passwordDeliveredBy: string[];
}

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
  /**
   * The same run, answering also which channels carried the starting
   * password to the person: what the invitation route reads to decide
   * whether the inviter is shown it.
   */
  deliverAccountInvited(event: AccountInvitedEvent): Promise<AccountInvitedNotice>;
  onAccountDeactivated(hook: AccountDeactivatedHook): void;
  /** Run every listener in registration order; what each cleaned up, in that order. */
  runAccountDeactivated(event: AccountDeactivatedEvent): Promise<string[]>;
}

/**
 * An admin switched an account off (or a directory told the deployment the
 * person left). The account keeps its row; what it HOLDS elsewhere — the
 * sign-ins it made to outside systems — is what listeners let go of.
 */
export interface AccountDeactivatedEvent {
  userId: string;
  email: string;
}

/**
 * A listener answers what it cleaned up — `'managed-connections'`, say — or
 * null when there was nothing; same rule as {@link AccountInvitedHook}.
 */
export type AccountDeactivatedHook = NotifyingListener<AccountDeactivatedEvent>;

export class AccountHooks implements IAccountHooks {
  // The account exists whether or not the person was told: the admin's
  // answer says they were not, and the admin sends the link themselves.
  private readonly invited = new ListenerSeam<InvitedRun>(
    log,
    'an account-invited listener failed; the person was not notified by it:',
    // A mailer's error can quote the message it was sending, password and all.
    (run) => [run.event.startingPassword],
  );
  // The account is off whether or not a listener cleaned up after it: a
  // failure here is logged, and the sign-ins it left are refused on use
  // like everything else a deactivated account holds.
  private readonly deactivated = new ListenerSeam<AccountDeactivatedEvent>(
    log,
    'an account-deactivated listener failed; what it cleans up is still there:',
  );

  onAccountInvited(hook: AccountInvitedHook): void {
    this.invited.add(async (run) => {
      const answer = await hook(run.event);
      if (answer === null || typeof answer === 'string') return answer;
      if (typeof answer !== 'object' || typeof answer.channel !== 'string' || answer.channel === '') return null;
      // Only a password the event carried can have been delivered, and only
      // `true` claims it: anything else leaves it with the inviter.
      if (answer.deliveredStartingPassword === true && run.event.startingPassword) {
        run.passwordDeliveredBy.push(answer.channel);
      }
      return answer.channel;
    });
  }

  async runAccountInvited(event: AccountInvitedEvent): Promise<string[]> {
    return (await this.deliverAccountInvited(event)).notified;
  }

  async deliverAccountInvited(event: AccountInvitedEvent): Promise<AccountInvitedNotice> {
    const run: InvitedRun = { event, passwordDeliveredBy: [] };
    const notified = await this.invited.run(run);
    return { notified, passwordDeliveredBy: run.passwordDeliveredBy };
  }

  onAccountDeactivated(hook: AccountDeactivatedHook): void {
    this.deactivated.add(hook);
  }

  runAccountDeactivated(event: AccountDeactivatedEvent): Promise<string[]> {
    return this.deactivated.run(event);
  }
}
