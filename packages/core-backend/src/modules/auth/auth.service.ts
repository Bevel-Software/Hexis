import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import type { CoreConfig } from '../../core-config.js';
import { users } from '../database/schema.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import { hashEmail } from '../../shared/hash-email.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  onboardingDone: boolean;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? undefined,
    onboardingDone: user.onboardingDone,
  };
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly config: CoreConfig,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string; user: AuthUser }> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new Error('Invalid email');
    }
    this.assertAllowedDomain(normalizedEmail);
    if (!this.checkPassword(password ?? '')) {
      throw new Error('Invalid password');
    }

    // Derive a default display name from the local-part of the email
    const defaultName = normalizedEmail.split('@')[0] || normalizedEmail;
    const user = await this.upsertUserByEmail(normalizedEmail, defaultName);
    return { token: this.signToken(user.id, user.email), user: toAuthUser(user) };
  }

  /**
   * Establish a session for a user who authenticated via "Sign in with
   * Microsoft". Same upsert-by-email + JWT path as password login — the only
   * difference is identity came from a verified Microsoft id_token instead of
   * the shared password. Email is the idempotency key, so a user who first
   * used password login and later signs in with Microsoft (same email) keeps
   * the same account/id.
   */
  async loginWithMicrosoft(
    email: string,
    name: string,
  ): Promise<{ token: string; user: AuthUser }> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new Error('Microsoft sign-in returned an invalid email');
    }
    this.assertAllowedDomain(normalizedEmail);
    const displayName = (name ?? '').trim() || normalizedEmail.split('@')[0] || normalizedEmail;
    const user = await this.upsertUserByEmail(normalizedEmail, displayName);
    return { token: this.signToken(user.id, user.email), user: toAuthUser(user) };
  }

  private signToken(userId: string, email: string): string {
    return jwt.sign({ userId, email }, this.config.jwtSecret, { expiresIn: '7d' });
  }

  /**
   * Get-or-create a user record by email, without issuing a session token.
   * Used by the embed surface: an Atlassian (Forge) editor whose identity was
   * verified server-side needs a real user row so file-lock commits attribute
   * to them — but they never get a Bevel browser session. Same email-keyed
   * upsert as the login paths, so an embed editor who later logs in keeps the
   * same account/id. Returns `null` for a malformed email.
   */
  async getOrCreateByEmail(
    email: string,
    name?: string,
  ): Promise<{ id: string; email: string; name: string } | null> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) return null;
    const displayName = (name ?? '').trim() || normalizedEmail.split('@')[0] || normalizedEmail;
    const user = await this.upsertUserByEmail(normalizedEmail, displayName);
    return { id: user.id, email: user.email, name: user.name };
  }

  private async upsertUserByEmail(email: string, name: string) {
    const [user] = await this.db
      .insert(users)
      .values({ email, name })
      .onConflictDoUpdate({ target: users.email, set: { updatedAt: new Date() } })
      .returning();
    return user;
  }

  verifyToken(token: string): { userId: string; email: string } {
    const decoded = jwt.verify(token, this.config.jwtSecret) as {
      userId: string;
      email: string;
    };
    return { userId: decoded.userId, email: decoded.email };
  }

  /**
   * Resolve a set of `authorId` hashes back to the app users that produced
   * them. Used by the PR list to display the human who triggered each PR
   * instead of the shared GitHub service account.
   *
   * Loads all users and hashes them in-process rather than indexing on a
   * stored hash column — the user table is small (one row per team member)
   * and refreshes are infrequent (PR list polls at 60s), so the cost is
   * negligible and we avoid carrying a denormalised hash column.
   */
  async findUsersByEmailHash(
    hashes: Set<string>,
  ): Promise<Map<string, { id: string; email: string; name: string }>> {
    const result = new Map<string, { id: string; email: string; name: string }>();
    if (hashes.size === 0) return result;
    const rows = await this.db.select().from(users);
    for (const row of rows) {
      const h = hashEmail(row.email);
      if (!hashes.has(h)) continue;
      result.set(h, { id: row.id, email: row.email, name: row.name });
    }
    return result;
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    return toAuthUser(user);
  }

  /**
   * Conclude the connect-your-agent onboarding for `userId`. Idempotent by
   * construction (an UPDATE to the value it already has), so the welcome
   * page's Done and the reminder pill's dismiss can both call it without
   * coordinating. There is deliberately no way back to false over the API:
   * "not onboarded again" is not a state a user can be put in.
   */
  async markOnboardingDone(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ onboardingDone: true, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /**
   * Whether `email` passes the optional `ALLOWED_EMAIL_DOMAINS` guard. Returns
   * true when no guard is configured (the default). Matches the email's domain
   * exactly or as a subdomain, so `bevel.software` admits `a@bevel.software`
   * and `a@eu.bevel.software` but not `a@notbevel.software`. When a guard IS
   * configured, a missing/blank email fails closed. Exposed so non-login
   * surfaces (the embed panel) can apply the same gate.
   */
  isEmailDomainAllowed(email: string): boolean {
    const allowed = this.config.allowedEmailDomains;
    if (allowed.length === 0) return true;
    const domain = (email ?? '').trim().toLowerCase().split('@')[1] ?? '';
    if (!domain) return false;
    return allowed.some((d) => domain === d || domain.endsWith(`.${d}`));
  }

  /**
   * Enforce {@link isEmailDomainAllowed} at the login paths. No-op when the
   * guard is unset. Expects an already-normalized (trimmed, lower-cased,
   * regex-validated) email.
   */
  private assertAllowedDomain(normalizedEmail: string): void {
    if (!this.isEmailDomainAllowed(normalizedEmail)) {
      throw new Error('Email domain is not allowed');
    }
  }

  private checkPassword(provided: string): boolean {
    const expected = this.config.testPassword;
    // Reject if no password is configured on the server
    if (!expected) return false;

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Pad both buffers to the same length so timingSafeEqual runs unconditionally —
    // returning early on length mismatch would leak the expected password's length via timing.
    const len = Math.max(a.length, b.length);
    const aPadded = Buffer.alloc(len);
    const bPadded = Buffer.alloc(len);
    a.copy(aPadded);
    b.copy(bPadded);
    const equal = timingSafeEqual(aPadded, bPadded);
    return equal && a.length === b.length;
  }
}
