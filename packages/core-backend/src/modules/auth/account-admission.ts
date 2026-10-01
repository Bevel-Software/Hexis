/**
 * Whether a NEW account may be provisioned on this deployment, asked before
 * the row is inserted — and whether a deactivated one may be switched back
 * on, which takes up the same place. The one seam a host that sells seats
 * needs: core admits everyone, and a cloud overlay answers from its plan
 * without forking any sign-in path.
 *
 * Never asked for an account that is already on. An existing user's sign-in
 * is not a provisioning, so a refusal can never lock out someone who is
 * already in; taking someone out is the admin's act (deactivation), not the
 * port's.
 */
export type AccountProvisionReason =
  /** A first sign-in through single sign-on, which provisions on its own. */
  | 'sso'
  /** An admin creating an account from the app. */
  | 'admin-create'
  /** The deployment owner's first password sign-in, which creates their row. */
  | 'bootstrap'
  /** A verified identity from an embedding surface that needs a row without a session. */
  | 'embed'
  /** An admin switching a deactivated account back on. */
  | 'reactivate';

export type AccountAdmissionVerdict =
  | { ok: true }
  | {
      ok: false;
      message: string;
      /**
       * Keep the person on file instead of turning them away: the account is
       * created DEACTIVATED, the sign-in is still refused with `message`, and
       * an admin finds them on the accounts list, ready to be switched on.
       * For a host whose rule is "whoever is on our domain may join while
       * there is room" — the one past the room waits instead of bouncing.
       *
       * Honoured only for a sign-in through single sign-on, the one
       * provisioning nobody asked for. Everywhere else a verdict carrying it
       * is a plain refusal: an admin creating an account would be told no,
       * and a deactivated account is never reactivated into one.
       */
      waitForAdmin?: boolean;
    };

export interface IAccountAdmission {
  canProvision(email: string, reason: AccountProvisionReason): Promise<AccountAdmissionVerdict>;
}

/** Core's default: every account is admitted. */
export const admitEveryone: IAccountAdmission = {
  canProvision: async () => ({ ok: true }),
};

/**
 * The port said no. Carries the port's own words, which the routes surface
 * to the person or admin who asked, and a 403: the identity was fine, the
 * deployment has no place for it.
 */
export class AccountAdmissionRefusedError extends Error {
  readonly status = 403;
  /** The person was put on file, switched off, for an admin to switch on (see `waitForAdmin`). */
  readonly waitingForAdmin: boolean;

  constructor(message: string, opts: { waitingForAdmin?: boolean } = {}) {
    super(message);
    this.name = 'AccountAdmissionRefusedError';
    this.waitingForAdmin = opts.waitingForAdmin ?? false;
  }
}

/**
 * The account exists and an admin switched it off — at sign-in, or for a
 * credential it still holds. A 403 like a refusal: the identity is fine,
 * the deployment no longer lets it in.
 */
export class AccountDeactivatedError extends Error {
  readonly status = 403;

  constructor(message = ACCOUNT_DEACTIVATED_MESSAGE) {
    super(message);
    this.name = 'AccountDeactivatedError';
  }
}

/** What a person with a deactivated account is told, wherever they knock. */
export const ACCOUNT_DEACTIVATED_MESSAGE = 'Your account on this workspace is switched off. Ask its admin to turn it back on.';
