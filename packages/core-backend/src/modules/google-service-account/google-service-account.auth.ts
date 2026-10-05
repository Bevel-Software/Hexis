import { AuthSerializer, Serializer, type Auth } from '@utcp/sdk';
import { z } from 'zod';
import { GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE, type GoogleServiceAccountAuth } from './service-account-token.contract.js';

const GoogleServiceAccountAuthSchema = z.object({
  auth_type: z.literal(GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE),
  credentials: z
    .string()
    .min(1)
    .describe('The service-account key JSON. Recommended to use a vault variable like "${GOOGLE_SA_KEY}".'),
  scopes: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe('OAuth scopes for the token, e.g. "https://www.googleapis.com/auth/adwords".'),
  subject: z.string().min(1).optional().describe('User to impersonate under domain-wide delegation.'),
});

class GoogleServiceAccountAuthSerializer extends Serializer<Auth> {
  toDict(obj: Auth): Record<string, unknown> {
    return { ...obj };
  }

  validateDict(obj: Record<string, unknown>): Auth {
    return GoogleServiceAccountAuthSchema.parse(obj) as Auth;
  }
}

/** Whether a call template's `auth` asks for a Google service-account token. */
export function isGoogleServiceAccountAuth(auth: unknown): auth is GoogleServiceAccountAuth {
  return (
    typeof auth === 'object' &&
    auth !== null &&
    (auth as { auth_type?: unknown }).auth_type === GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE
  );
}

// Register the auth type on module load, so a `.tool` naming it validates
// wherever UTCP parses a call template: the inline manual route, the preview,
// and the client re-validating a template after substituting its variables.
// UTCP's registry is process-wide and the type carries no state, so one
// registration serves every knowledge base. Idempotent (safe under hot-reload).
AuthSerializer.registerAuth(GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE, new GoogleServiceAccountAuthSerializer(), true);
