/** The `auth_type` a `.tool` call template names to call a Google API as a service account. */
export const GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE = 'google_service_account';

/**
 * A call template's `auth` block for a Google service account, as it reaches
 * the protocol: variables already substituted, so `credentials` holds the key
 * itself rather than the `${VAR}` that named it.
 */
export interface GoogleServiceAccountAuth {
  auth_type: typeof GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE;
  /** The service-account key JSON Google issued, or that JSON in base64. Normally `${VAR}`, filled from the Secrets Vault. */
  credentials: string;
  /** The OAuth scopes the token is for: one scope, a space-separated list, or an array. */
  scopes: string | string[];
  /** The user to act as under domain-wide delegation. Absent, the token is the service account's own. */
  subject?: string;
}

/**
 * Answers the one question a tool call has of a service account: which bearer
 * token to send right now. How the token is minted and how long it is kept is
 * the implementation's business.
 */
export interface IServiceAccountTokenSource {
  accessToken(auth: GoogleServiceAccountAuth): Promise<string>;
}

/** A service-account token could not be had. The message never carries the key. */
export class ServiceAccountAuthError extends Error {
  constructor(
    message: string,
    /** How long the same token should not be asked for again. */
    readonly retryAfterMs: number = 5_000,
  ) {
    super(message);
    this.name = 'ServiceAccountAuthError';
  }
}
