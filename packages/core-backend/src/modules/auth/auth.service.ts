import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import type { CoreConfig } from '../../core-config.js';
import { users } from '../database/schema.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import { hashEmail } from '../../shared/hash-email.js';
import {
  hashPassword,
  verifyPassword,
  timingSafeStringEqual,
  MIN_PASSWORD_LENGTH,
} from './password-hash.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Decoy hash verified when the email is unknown or has no password set, so
 * those paths cost the same scrypt work as a real wrong-password attempt —
 * without it, response timing would reveal which emails have accounts.
 * Lazily computed once; the compared password never matches it (verification
 * result is discarded — those paths always refuse).
 */
let decoyHashPromise: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword('bevel-decoy-password-never-matches');
  return decoyHashPromise;
}

function toAuthUser(user: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? undefined,
  };
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly config: CoreConfig,
  ) {}

  /**
   * Password login. Two credential sources, in order:
   *
   *  1. The env bootstrap admin (`ADMIN_EMAIL` + `ADMIN_PASSWORD`), checked
   *     directly against the environment — never stored, so unsetting either
   *     variable disables it immediately. Lets a fresh deployment sign in
   *     before any account exists.
   *  2. A per-user account: the `users` row's scrypt `password_hash`
   *     (created by an admin from Roles & Members, or set by the user on
   *     their Account page). Accounts that only ever signed in via SSO have
   *     no hash and are refused here.
   *
   * A generic "Invalid credentials" error for every failure mode — never
   * reveal whether the email exists or has a password.
   */
  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string; user: AuthUser }> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();

    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new Error('Invalid credentials');
    }
    this.assertAllowedDomain(normalizedEmail);

    const provided = password ?? '';
    const isEnvAdmin =
      this.config.adminEmail.length > 0 &&
      this.config.adminPassword.length > 0 &&
      normalizedEmail === this.config.adminEmail &&
      timingSafeStringEqual(provided, this.config.adminPassword);

    if (isEnvAdmin) {
      const defaultName = normalizedEmail.split('@')[0] || normalizedEmail;
      const user = await this.upsertUserByEmail(normalizedEmail, defaultName);
      return { token: this.signToken(user.id, user.email), user: toAuthUser(user) };
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    // Always run one scrypt verification — against the stored hash when there
    // is one, against the decoy otherwise — so unknown emails and
    // password-less (SSO-only) accounts take the same time as a wrong
    // password and can't be enumerated via response timing.
    const stored = user?.passwordHash ?? (await decoyHash());
    const matches = await verifyPassword(provided, stored);
    if (!user?.passwordHash || !matches) {
      throw new Error('Invalid credentials');
    }
    return { token: this.signToken(user.id, user.email), user: toAuthUser(user) };
  }

  /**
   * Establish a session for a user whose identity an SSO provider (the
   * generic OIDC plugin, or the enterprise "Sign in with Microsoft") already
   * verified. Same upsert-by-email + JWT path as password login. Email is the
   * idempotency key, so a user who first used password login and later signs
   * in via SSO (same email) keeps the same account/id.
   */
  async loginWithSso(
    email: string,
    name: string,
  ): Promise<{ token: string; user: AuthUser }> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new Error('Sign-in returned an invalid email');
    }
    this.assertAllowedDomain(normalizedEmail);
    const displayName = (name ?? '').trim() || normalizedEmail.split('@')[0] || normalizedEmail;
    const user = await this.upsertUserByEmail(normalizedEmail, displayName);
    return { token: this.signToken(user.id, user.email), user: toAuthUser(user) };
  }

  /**
   * Admin-driven account provisioning (Roles & Members → Accounts). Upserts
   * the user by email and sets their password — re-provisioning an existing
   * account (e.g. one that first arrived via SSO, or a reset for a locked-out
   * user) is deliberate admin behavior, not an error.
   */
  async createAccount(
    email: string,
    name: string | undefined,
    password: string,
  ): Promise<AuthUser> {
    const normalizedEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new Error('Invalid email');
    }
    this.assertAllowedDomain(normalizedEmail);
    this.assertPasswordPolicy(password);
    const suppliedName = (name ?? '').trim();
    const displayName = suppliedName || normalizedEmail.split('@')[0] || normalizedEmail;
    const user = await this.upsertUserByEmail(normalizedEmail, displayName);
    const passwordHash = await hashPassword(password);
    // Persist an EXPLICITLY supplied name on re-provisioning too (the upsert
    // keeps the existing row's name); when the admin left it blank, keep the
    // existing name rather than clobbering it with the local-part fallback.
    await this.db
      .update(users)
      .set(
        suppliedName
          ? { passwordHash, name: suppliedName, updatedAt: new Date() }
          : { passwordHash, updatedAt: new Date() },
      )
      .where(eq(users.id, user.id));
    return toAuthUser({ ...user, name: suppliedName || user.name });
  }

  /**
   * Self-service password change (the Account page). The current password is
   * required whenever one is set; an SSO-only account (no hash yet) may set
   * its first password without one. The env bootstrap-admin credential is not
   * affected — it lives in the environment, not in this row.
   */
  async changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
  ): Promise<void> {
    this.assertPasswordPolicy(newPassword);
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error('User not found');
    if (user.passwordHash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
        throw new Error('Current password is incorrect');
      }
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /** Accounts overview for the admin management screen (never exposes hashes). */
  async listAccounts(): Promise<
    Array<{ id: string; email: string; name: string; hasPassword: boolean; createdAt: Date }>
  > {
    const rows = await this.db.select().from(users).orderBy(users.email);
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      hasPassword: row.passwordHash != null,
      createdAt: row.createdAt,
    }));
  }

  private assertPasswordPolicy(password: string): void {
    if ((password ?? '').length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
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

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl ?? undefined,
    };
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

}
