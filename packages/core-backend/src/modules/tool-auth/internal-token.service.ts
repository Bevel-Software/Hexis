import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * What an internal token authorizes: a user identity, nothing more. Minted when
 * an agent's code-mode client is built and seeded into that client's UTCP config.
 * Deliberately identity-only — the SAME shape a `bevel_…` connection key resolves
 * to: the workspace is chosen per call from the tool's `branch` argument, and the
 * scope is always write (the middleware sets it, exactly as for connection keys).
 */
export interface InternalTokenClaim {
  userId: string;
  /**
   * The agent run / conversation id (the Mastra thread id) this token is scoped
   * to, when minted per-run. Surfaced as `ToolContext.sessionId` so the
   * ontology-session boundary can scope to one run for the in-process agent
   * (the external/MCP path carries `sessionId` on the tool body instead).
   * Absent for identity-only tokens.
   */
  sessionId?: string;
  /**
   * True when this token is the LOOPBACK identity of an external caller — the
   * MCP proxy mints one per OAuth/JWT MCP session (which has no `bevel_…`
   * connection key to pass through). The verifier resolves such tokens to
   * `source: 'external'`: the caller IS an external agent, and must be treated
   * like one everywhere — admitted to external-only surfaces (`start_session`,
   * `ask`), refused from internal-only ones (`execute_command`, …), and
   * expected to carry `sessionId` on the tool body, not in the token.
   */
  externalProxy?: boolean;
}

interface SignedPayload extends InternalTokenClaim {
  /** Expiry, epoch ms. */
  exp: number;
}

const DEFAULT_PREFIX = 'bevel-int_';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Mints + verifies stateless HMAC internal tokens. No DB: the token is
 * self-contained `(claim, exp)` signed with a process secret, so it is
 * multi-replica safe for verification within a deploy and costs nothing to
 * issue. Tokens carry only `userId` and are short-lived; the agent factory
 * mints one per code-mode client (per user).
 *
 * Distinct from connection keys (`bevel_…`, long-lived, user-wide): internal
 * tokens are the least-privilege credential for the in-process loopback surface
 * and are rejected by the external endpoints, and vice-versa.
 */
export class InternalTokenService {
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly prefix: string;

  constructor(
    opts: { secret?: string; ttlMs?: number; now?: () => number; prefix?: string } = {},
  ) {
    // A per-boot random secret is fine: tokens are minted per turn-ish and
    // re-minted after a restart. A caller may inject a stable secret (tests, or
    // a future multi-replica deploy) instead.
    this.secret = opts.secret ? Buffer.from(opts.secret, 'utf8') : randomBytes(32);
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000; // 1h
    this.now = opts.now ?? Date.now;
    // Tenant-derived prefix (default `bevel-int_`), injected from
    // AppConfig.internalTokenPrefix so internal tokens brand with the deploy's tenant.
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
  }

  /** Token lifetime in ms — so callers caching a minted token can refresh it before expiry. */
  get tokenTtlMs(): number {
    return this.ttlMs;
  }

  /** @param ttlMs Override the default lifetime — e.g. the MCP proxy mints
   *   session-loopback tokens that must outlive its 4h session idle TTL. */
  mint(claim: InternalTokenClaim, ttlMs?: number): string {
    const payload: SignedPayload = { ...claim, exp: this.now() + (ttlMs ?? this.ttlMs) };
    const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = b64url(this.sign(body));
    return `${this.prefix}${body}.${sig}`;
  }

  /** Returns the claim for a valid, unexpired token; null otherwise. */
  verify(token: string): InternalTokenClaim | null {
    if (!this.looksLikeInternalToken(token)) return null;
    const rest = token.slice(this.prefix.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return null;
    const body = rest.slice(0, dot);
    const sig = rest.slice(dot + 1);

    const expected = b64url(this.sign(body));
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    let payload: SignedPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp < this.now()) return null;
    if (typeof payload.userId !== 'string') return null;
    return {
      userId: payload.userId,
      ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
      ...(payload.externalProxy === true ? { externalProxy: true } : {}),
    };
  }

  /** True if the bearer string looks like an internal token (vs an external API key). */
  looksLikeInternalToken(token: string): boolean {
    return token.startsWith(this.prefix);
  }

  private sign(body: string): Buffer {
    return createHmac('sha256', this.secret).update(body).digest();
  }
}
