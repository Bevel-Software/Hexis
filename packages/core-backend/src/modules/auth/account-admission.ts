/**
 * Whether a NEW account may be provisioned on this deployment, asked before
 * the row is inserted. The one seam a host that sells seats needs: core
 * admits everyone, and a cloud overlay answers from its plan without
 * forking any sign-in path.
 *
 * Asked only for an address with no account yet. An existing user's sign-in
 * is never a provisioning, so a refusal can never lock out someone who is
 * already in.
 */
export type AccountProvisionReason =
  /** A first sign-in through single sign-on, which provisions on its own. */
  | 'sso'
  /** An admin creating an account from the app. */
  | 'admin-create'
  /** The deployment owner's first password sign-in, which creates their row. */
  | 'bootstrap'
  /** A verified identity from an embedding surface that needs a row without a session. */
  | 'embed';

export type AccountAdmissionVerdict = { ok: true } | { ok: false; message: string };

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

  constructor(message: string) {
    super(message);
    this.name = 'AccountAdmissionRefusedError';
  }
}
