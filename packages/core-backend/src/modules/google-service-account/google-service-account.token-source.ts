import { createHash, createSign } from 'node:crypto';
import {
  ServiceAccountAuthError,
  type GoogleServiceAccountAuth,
  type IServiceAccountTokenSource,
} from './service-account-token.contract.js';

/**
 * Google's token endpoint. Fixed rather than read from the key's own
 * `token_uri`, so a key cannot point the server at another host with a signed
 * assertion in hand.
 */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** The longest assertion lifetime Google accepts. */
const ASSERTION_LIFETIME_S = 3600;
/** A token this close to expiry is replaced, so a call never leaves with one that dies on the way. */
const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Tokens kept at once. Each distinct key, scope set and subject is one entry. */
const MAX_CACHED_TOKENS = 256;

interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Mints and caches access tokens for Google service accounts: signs an RS256
 * assertion with the key's private key, exchanges it at Google's token
 * endpoint, and keeps the token until shortly before it expires. Concurrent
 * calls for the same token share one exchange. Injected with `fetch` and a
 * clock so suites answer for Google.
 */
export class GoogleServiceAccountTokenSource implements IServiceAccountTokenSource {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  async accessToken(auth: GoogleServiceAccountAuth): Promise<string> {
    const key = parseServiceAccountKey(auth.credentials);
    const scope = scopeString(auth.scopes);
    const cacheKey = tokenCacheKey(key, scope, auth.subject);

    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > this.now()) return cached.accessToken;

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const exchange = this.exchange(key, scope, auth.subject, cacheKey).finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, exchange);
    return exchange;
  }

  private async exchange(key: ServiceAccountKey, scope: string, subject: string | undefined, cacheKey: string): Promise<string> {
    const assertion = signAssertion(key, scope, subject, this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
        // Don't follow redirects: the assertion goes to Google's endpoint and nowhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ServiceAccountAuthError(`Google's token endpoint could not be reached: ${reason}`);
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Google says why in `error` and `error_description` (a revoked key, a
      // scope the account may not have, a subject without delegation); neither
      // carries the key, so both are passed on.
      const detail = [body.error, body.error_description].filter((v) => typeof v === 'string').join(': ');
      throw new ServiceAccountAuthError(
        `Google refused the service account ${key.clientEmail} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    if (!accessToken) throw new ServiceAccountAuthError("Google's token response had no access_token");
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : ASSERTION_LIFETIME_S;

    this.remember(cacheKey, { accessToken, expiresAt: this.now() + expiresIn * 1000 });
    return accessToken;
  }

  private remember(cacheKey: string, token: CachedToken): void {
    // Drop the oldest entry first: a Map iterates in insertion order, and
    // re-inserting a refreshed token moves it to the back.
    this.tokens.delete(cacheKey);
    if (this.tokens.size >= MAX_CACHED_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) this.tokens.delete(oldest);
    }
    this.tokens.set(cacheKey, token);
  }
}

/**
 * The key as an admin is likely to have stored it: the JSON file Google
 * issued, or that JSON in base64. Only the fields the assertion needs are
 * kept, and no error quotes what was stored.
 */
function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const value = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    throw new ServiceAccountAuthError(
      'The service-account credentials are not a key JSON. Store the JSON file Google issued for the service account.',
    );
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email : '';
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key : '';
  if (!clientEmail || !privateKey) {
    throw new ServiceAccountAuthError(
      'The service-account key JSON has no client_email or private_key. Store the JSON file Google issued for the service account.',
    );
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof obj.private_key_id === 'string' ? obj.private_key_id : undefined,
  };
}

function scopeString(scopes: string | string[]): string {
  const list = Array.isArray(scopes) ? scopes : scopes.split(/\s+/);
  return list.filter(Boolean).join(' ');
}

/** One entry per key, scope set and subject. The private key is hashed so the cache holds no copy of it. */
function tokenCacheKey(key: ServiceAccountKey, scope: string, subject: string | undefined): string {
  const keyHash = createHash('sha256').update(key.privateKey).digest('hex');
  return JSON.stringify([key.clientEmail, key.privateKeyId ?? '', keyHash, scope.split(' ').sort().join(' '), subject ?? '']);
}

/** The RS256 assertion Google exchanges for an access token. */
function signAssertion(key: ServiceAccountKey, scope: string, subject: string | undefined, now: number): string {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const header = { alg: 'RS256', typ: 'JWT', ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) };
  const claims = {
    iss: key.clientEmail,
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: seconds,
    exp: seconds + ASSERTION_LIFETIME_S,
    ...(subject ? { sub: subject } : {}),
  };
  const body = `${part(header)}.${part(claims)}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(body).end().sign(key.privateKey, 'base64url');
  } catch {
    // What the key was is never quoted.
    throw new ServiceAccountAuthError(
      `The private key of service account ${key.clientEmail} could not be read. It must be the PEM in the key JSON Google issued.`,
    );
  }
  return `${body}.${signature}`;
}
