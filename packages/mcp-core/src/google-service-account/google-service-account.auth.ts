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
 * The other call template types an author is likely to have reached for, which
 * the answer below may name. A type outside this list is the file's own text,
 * and is described rather than quoted back.
 */
const NAMEABLE_CALL_TEMPLATE_TYPES = ['sse', 'streamable_http', 'mcp', 'cli'];

/**
 * Where in `doc` a `google_service_account` auth block sits that nothing will
 * act on, as a phrase for a refusal, or null when every block is the `auth` of
 * one of `toolCallTemplates` and that template is an `http` one.
 *
 * `toolCallTemplates` are the templates tools are really called through, which
 * only the caller knows: the document's shape is its business. A block
 * anywhere else is read by nothing, whatever the object around it looks like:
 * a template the document never registers, an `auth_tools`, a block at the
 * root of a file that discovers its tools from a url.
 *
 * UTCP validates an auth type on any call template that takes an `auth`, but
 * only the `http` protocol mints the token. Every other protocol sends an auth
 * type it does not know as no credentials at all, so such a tool would save
 * cleanly and then call Google unauthenticated.
 *
 * Every block in the document is found, at any depth. The walk keeps its own
 * stack, so a deeply nested document cannot overflow the call stack, and it
 * does not re-enter an object it has seen: a YAML anchor aliased inside itself
 * parses to a cyclic object.
 */
export function findUnservedGoogleServiceAccountAuth(doc: unknown, toolCallTemplates: readonly unknown[]): string | null {
  const served = new Set<unknown>(toolCallTemplates);
  const seen = new WeakSet<object>();
  const pending: { node: unknown; parent?: Record<string, unknown>; key?: string }[] = [{ node: doc }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { node, parent, key } = next;
    if (!node || typeof node !== 'object') continue;
    if (isGoogleServiceAccountAuth(node)) {
      // Judged by where it sits, so once per place it appears: an aliased
      // block can be served in one place and ignored in another.
      const where = unservedPlacement(parent, key, served);
      if (where) return where;
      continue;
    }
    if (seen.has(node)) continue;
    seen.add(node);
    // Pushed in reverse, so the first block in document order is the one named.
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) pending.push({ node: node[i] });
    } else {
      const obj = node as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (let i = keys.length - 1; i >= 0; i--) pending.push({ node: obj[keys[i]!], parent: obj, key: keys[i] });
    }
  }
  return null;
}

/** Why a block under `parent[key]` is acted on by nothing, or null when it is. */
function unservedPlacement(parent: Record<string, unknown> | undefined, key: string | undefined, served: Set<unknown>): string | null {
  if (!parent || key !== 'auth' || typeof parent.call_template_type !== 'string') {
    return "somewhere that is not a call template's `auth`";
  }
  const type = parent.call_template_type.toLowerCase().trim();
  if (type !== SERVED_CALL_TEMPLATE_TYPE) {
    return NAMEABLE_CALL_TEMPLATE_TYPES.includes(type) ? `a \`${type}\` call template` : 'a call template that is not an `http` one';
  }
  return served.has(parent) ? null : 'an `http` call template that no tool is called through';
}

// Register the auth type on module load, so a `.tool` naming it validates
// wherever UTCP parses a call template: the inline manual route, the preview,
// and the client re-validating a template after substituting its variables.
// UTCP's registry is process-wide and the type carries no state, so one
// registration serves every knowledge base. Idempotent (safe under hot-reload).
AuthSerializer.registerAuth(GOOGLE_SERVICE_ACCOUNT_AUTH_TYPE, new GoogleServiceAccountAuthSerializer(), true);
