export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /**
   * Has this person concluded the connect-your-agent onboarding (welcome
   * page Done, or dismissing the reminder pill). Optional so pre-existing
   * fixtures and cached user objects stay valid; the server always sends it,
   * and consumers treat only an explicit `false` as "still onboarding" — an
   * absent field must never resurrect the welcome flow.
   */
  onboardingDone?: boolean;
  /**
   * Is this the deployment admin — the account whose password is set in the
   * deployment environment (`ADMIN_EMAIL` while `ADMIN_PASSWORD` is set)
   * rather than stored as a hash? That credential is the platform's rescue
   * path into a deployment, so this account's password cannot be changed from
   * the Account page. Derived from configuration on every read rather than
   * stored, and it carries no part of the credential itself. Optional for the
   * same reason as `onboardingDone` above — pre-existing fixtures and cached
   * user objects stay valid — and only an explicit `true` means "deployment
   * admin".
   */
  isEnvAdmin?: boolean;
  /**
   * Set only on the identity a BOT acts with (`modules/bots` in the core
   * backend): the person who made the connection it acts through. What the
   * bot writes, opens and merges names them beside the bot. Never sent by
   * the server to a client.
   */
  madeBy?: { name: string; email: string };
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
