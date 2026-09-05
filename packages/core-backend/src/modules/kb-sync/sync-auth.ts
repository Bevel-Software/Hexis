import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Who may call `POST /api/sync`, decided from the request's credentials.
 *
 * Framework-agnostic on purpose (the route hands in plain strings and the
 * raw body) so the rule is one function with one test, not something spread
 * across middleware.
 *
 * Four credentials are accepted, because the callers cannot all speak the
 * same one:
 *
 *   bearer            `Authorization: Bearer <secret>` — ADO Web Hooks and
 *                     any pipeline can set a header.
 *   gitlab-token      `X-Gitlab-Token: <secret>` — what GitLab sends.
 *   github-signature  `X-Hub-Signature-256: sha256=<hmac of the raw body>` —
 *                     GitHub and Gitea cannot set headers, only sign.
 *   admin-session     a browser JWT whose user is an admin, so a "Sync now"
 *                     button and a curl with your own session both work while
 *                     the hook is being wired up.
 *
 * Every comparison is constant-time. The secret never travels in the URL.
 */
export type SyncCredential =
  | { kind: 'bearer' | 'gitlab-token' | 'github-signature' }
  | { kind: 'admin-session'; email: string };

export type SyncAuthResult =
  | { ok: true; credential: SyncCredential }
  | { ok: false; status: 401 | 503; message: string };

export interface SyncAuthInput {
  /** The configured secret, or empty when none is set. */
  secret: string;
  authorization?: string;
  gitlabToken?: string;
  hubSignature?: string;
  /** The request body exactly as received — the HMAC is over these bytes. */
  rawBody?: Buffer;
}

export interface SyncSessionVerifier {
  /** Resolve a browser JWT to its email, or null when it is not one. */
  verifyJwt(token: string): { email: string } | null;
  isAdmin(email: string): Promise<boolean>;
}

const NO_SECRET =
  'No sync secret is configured. Set KB_SYNC_SECRET (or the setup screen’s sync secret), ' +
  'or call this endpoint with an administrator session.';

/**
 * Shortest secret the endpoint will honour. The setup screen enforces the
 * same floor on save; this is the boundary that also covers a secret set
 * through the environment, which no validator ever sees.
 */
export const MIN_SYNC_SECRET_LENGTH = 16;

const SECRET_TOO_SHORT =
  `The configured sync secret is shorter than ${MIN_SYNC_SECRET_LENGTH} characters and is not ` +
  'accepted. Set a longer KB_SYNC_SECRET, or call this endpoint with an administrator session.';

/** Constant-time string equality that does not leak the length either. */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function signatureMatches(secret: string, rawBody: Buffer, header: string): boolean {
  const [scheme, hex] = header.split('=', 2);
  if (scheme !== 'sha256' || !hex) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return secretEquals(expected, hex.toLowerCase());
}

export async function verifySyncCredential(
  input: SyncAuthInput,
  session: SyncSessionVerifier,
): Promise<SyncAuthResult> {
  const configured = input.secret.trim();
  // A too-short secret is treated as absent for matching purposes and named
  // as the problem below, so a one-character deployment secret can never be
  // what lets a caller in.
  const usable = configured.length >= MIN_SYNC_SECRET_LENGTH;
  const secret = usable ? configured : '';
  const bearer = input.authorization?.startsWith('Bearer ')
    ? input.authorization.slice('Bearer '.length).trim()
    : '';

  // A shared secret presented in any of its three shapes.
  if (secret) {
    if (bearer && secretEquals(bearer, secret)) {
      return { ok: true, credential: { kind: 'bearer' } };
    }
    if (input.gitlabToken && secretEquals(input.gitlabToken.trim(), secret)) {
      return { ok: true, credential: { kind: 'gitlab-token' } };
    }
    if (input.hubSignature && input.rawBody && signatureMatches(secret, input.rawBody, input.hubSignature.trim())) {
      return { ok: true, credential: { kind: 'github-signature' } };
    }
  }

  // An admin's own session, carried as the bearer. Checked after the secret
  // so a secret that happens to parse as a JWT is never mistaken for one.
  if (bearer) {
    const claim = session.verifyJwt(bearer);
    if (claim && (await session.isAdmin(claim.email))) {
      return { ok: true, credential: { kind: 'admin-session', email: claim.email } };
    }
  }

  // Nothing matched. Say WHY when the reason is the deployment's, not the
  // caller's: a hook pointed at an unconfigured endpoint should read "set
  // the secret", not "wrong secret".
  if (!secret && (bearer || input.gitlabToken || input.hubSignature)) {
    return { ok: false, status: 503, message: configured ? SECRET_TOO_SHORT : NO_SECRET };
  }
  return {
    ok: false,
    status: 401,
    message: 'A valid sync secret or an administrator session is required.',
  };
}
