import { AuthSerializer, Serializer, type Auth } from '@utcp/sdk';
import { z } from 'zod';
import { GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE, type GoogleServiceAccountAuth } from './service-account-token.contract.js';

const GoogleServiceAccountAuthSchema = z.object({
  auth_type: z.literal(GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE),
  credentials: z
    .string()
    .min(1)
    .describe('The service-account key JSON. Recommended to use a vault variable like "${GOOGLE_SA_KEY}".'),
  // Trimmed before the length check, so a blank scope is refused here rather
  // than reaching Google as an empty one.
  scopes: z
    .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
    .describe('OAuth scopes for the token, e.g. "https://www.googleapis.com/auth/adwords".'),
  subject: z.string().trim().min(1).optional().describe('User to impersonate under domain-wide delegation.'),
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

/** The one call template type whose protocol turns the key into a token. */
const SERVED_CALL_TEMPLATE_TYPE = 'http';

/**
 * Where in `doc` a `google_service_account` auth block sits on something that
 * will not act on it, or null when every one is on an `http` call template.
 *
 * UTCP validates an auth type on any call template that takes an `auth`, but
 * only the `http` protocol mints the token. Every other protocol sends an auth
 * type it does not know as no credentials at all, so such a tool would save
 * cleanly and then call Google unauthenticated. The answer names what the
 * block was found on (`sse`, `mcp`, …), or `no call template` for a block that
 * is not on a call template at all.
 *
 * A deep, cycle-safe walk, for the reasons `containsCliCallTemplate` in the
 * platform gives: templates nest inside templates, and a YAML anchor aliased
 * inside itself parses to a cyclic object.
 */
export function findUnservedGoogleServiceAccountAuth(doc: unknown): string | null {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    if (isGoogleServiceAccountAuth(obj.auth)) {
      const type = typeof obj.call_template_type === 'string' ? obj.call_template_type.toLowerCase().trim() : '';
      if (type !== SERVED_CALL_TEMPLATE_TYPE) return type || 'no call template';
    }
    for (const value of Object.values(obj)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(doc);
}

// Register the auth type on module load, so a `.tool` naming it validates
// wherever UTCP parses a call template: the inline manual route, the preview,
// and the client re-validating a template after substituting its variables.
// UTCP's registry is process-wide and the type carries no state, so one
// registration serves every knowledge base. Idempotent (safe under hot-reload).
AuthSerializer.registerAuth(GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE, new GoogleServiceAccountAuthSerializer(), true);
