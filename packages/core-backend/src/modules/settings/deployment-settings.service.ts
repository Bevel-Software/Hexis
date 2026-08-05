import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { deploymentSettings } from '../database/core-schema.js';
import { TokenCrypto } from '../../shared/token-crypto.js';

/**
 * A setting an admin may set from the setup screen instead of the environment.
 *
 * `envVar` is the name that still wins if it is set — see
 * {@link DeploymentSettingsService}. `secret` values are sealed at rest and
 * never read back out to a client.
 */
export interface SettingDef {
  key: string;
  envVar: string;
  secret?: boolean;
  /** Applied on save; the message is shown against the field. */
  validate?(value: string): string | null;
  /**
   * True when a running server cannot pick the new value up. Everything the
   * KB remote needs is read per-operation and applies at once; anything that
   * was copied into a service at construction is not.
   */
  restartToApply?: boolean;
}

const HTTPS_URL = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full URL, e.g. https://github.com/acme/knowledge-base.git';
  }
  return parsed.protocol === 'https:' ? null : 'The URL must start with https://';
};

/**
 * The core catalogue. Order is the order the setup screen renders them in.
 */
export const CORE_SETTINGS: SettingDef[] = [
  {
    key: 'kbRepoUrl',
    envVar: 'KB_REPO_URL',
    validate: HTTPS_URL,
  },
  {
    key: 'gitToken',
    envVar: 'GIT_TOKEN',
    secret: true,
    validate: (v) => (v.trim() ? null : 'A token is required to read and write the repository.'),
  },
  {
    key: 'gitUsername',
    envVar: 'GIT_USERNAME',
    // Interpolated into the credential-helper shell snippet, so anything that
    // is not a plain token is rejected rather than escaped.
    validate: (v) =>
      /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Use only letters, digits, dot, underscore or hyphen.',
  },
  {
    key: 'kbDirName',
    envVar: 'KB_DIR_NAME',
    // Joined with workspace paths, so a separator or `..` would let it escape
    // the workspace directory.
    validate: (v) =>
      v && v !== '.' && v !== '..' && !v.includes('/') && !v.includes('\\')
        ? null
        : 'Use a single folder name — no slashes.',
    // Copied into a dozen services when they are constructed. A running server
    // keeps the name it started with.
    restartToApply: true,
  },
];

/** Where a resolved value came from, which is what the UI renders as its status. */
export type SettingSource = 'env' | 'stored' | 'unset';

export interface ResolvedSetting {
  key: string;
  envVar: string;
  source: SettingSource;
  /** Omitted entirely for secrets — `configured` is all a client ever learns. */
  value?: string;
  configured: boolean;
  secret: boolean;
  restartToApply: boolean;
}

/**
 * Deployment settings, resolved ENVIRONMENT-FIRST.
 *
 * The precedence is the whole design. A stored row is a FALLBACK for a variable
 * nobody set, never an override of one they did — so:
 *
 *  - an existing deployment adopts this table with no behaviour change at all;
 *  - a value typed once into a browser cannot quietly outrank the
 *    infrastructure config that is under review in someone's repo;
 *  - and "why is it not using my env var" never becomes a question, because
 *    the answer is always "it is".
 *
 * Values are cached in memory after {@link load}. Reads happen on every clone
 * and every git call, and a database round-trip there would be a tax on the
 * hot path for data that changes about twice in a deployment's life.
 */
export class DeploymentSettingsService {
  private readonly defs = new Map<string, SettingDef>();
  private stored = new Map<string, string>();
  private readonly crypto: TokenCrypto | null;

  constructor(
    private readonly db: Database,
    secretsEncKey: string,
    defs: SettingDef[] = CORE_SETTINGS,
  ) {
    for (const def of defs) this.defs.set(def.key, def);
    // No key configured means secrets cannot be stored — surfaced when someone
    // tries, rather than pretended away by writing plaintext.
    this.crypto = secretsEncKey ? new TokenCrypto(secretsEncKey) : null;
  }

  get definitions(): SettingDef[] {
    return [...this.defs.values()];
  }

  /** Read every stored row into memory. Call once, before services are built. */
  async load(): Promise<void> {
    const rows = await this.db.select().from(deploymentSettings);
    const next = new Map<string, string>();
    for (const row of rows) {
      if (!this.defs.has(row.key)) continue; // a setting this build no longer has
      if (row.encrypted) {
        if (!this.crypto) {
          console.warn(
            `[settings] "${row.key}" is stored encrypted but SECRETS_ENC_KEY is unset — ignoring it.`,
          );
          continue;
        }
        try {
          next.set(row.key, this.crypto.decrypt(row.value));
        } catch {
          // A rotated or mistyped key. Loud, and skipped rather than fatal:
          // one unreadable setting must not stop the server from booting into
          // the screen where it can be fixed.
          console.error(`[settings] could not decrypt "${row.key}" — is SECRETS_ENC_KEY correct?`);
        }
        continue;
      }
      next.set(row.key, row.value);
    }
    this.stored = next;
  }

  /**
   * The value in effect: the environment variable if set, else the stored row,
   * else empty. Trimmed, because both sources arrive from a human.
   */
  resolve(key: string): string {
    const def = this.defs.get(key);
    if (!def) return '';
    const fromEnv = (process.env[def.envVar] ?? '').trim();
    if (fromEnv) return fromEnv;
    return (this.stored.get(key) ?? '').trim();
  }

  /** Where {@link resolve} got its answer — what the setup screen labels the field with. */
  sourceOf(key: string): SettingSource {
    const def = this.defs.get(key);
    if (!def) return 'unset';
    if ((process.env[def.envVar] ?? '').trim()) return 'env';
    return (this.stored.get(key) ?? '').trim() ? 'stored' : 'unset';
  }

  /**
   * Every setting's status, for the setup screen. A secret's VALUE is never
   * included — the screen shows whether one is configured and offers to
   * replace it, which is all anyone needs to finish setup.
   */
  describe(): ResolvedSetting[] {
    return this.definitions.map((def) => {
      const source = this.sourceOf(def.key);
      const base = {
        key: def.key,
        envVar: def.envVar,
        source,
        configured: source !== 'unset',
        secret: def.secret === true,
        restartToApply: def.restartToApply === true,
      };
      return def.secret ? base : { ...base, value: this.resolve(def.key) };
    });
  }

  /**
   * Validate and persist. Rejects the whole batch if any field fails, so a
   * half-applied configuration is never written — a KB URL saved without the
   * token that reads it is a deployment that fails at first clone.
   *
   * A setting whose environment variable is set is REFUSED rather than silently
   * stored, because storing it would write a row that can never take effect and
   * leave the screen implying otherwise.
   */
  async save(
    entries: Record<string, string>,
    updatedBy: string | null,
  ): Promise<{ restartRequired: boolean }> {
    const problems: Record<string, string> = {};
    const toWrite: { key: string; value: string; def: SettingDef }[] = [];

    for (const [key, raw] of Object.entries(entries)) {
      const def = this.defs.get(key);
      if (!def) {
        problems[key] = 'Unknown setting.';
        continue;
      }
      if (this.sourceOf(key) === 'env') {
        problems[key] = `Set by the ${def.envVar} environment variable — change it there.`;
        continue;
      }
      const value = raw.trim();
      // An empty field means "leave it alone", not "erase it". Clearing a
      // setting is not something the setup screen offers, and treating a blank
      // input as a delete would let a stray Enter unconfigure a deployment.
      if (!value) continue;
      const problem = def.validate?.(value);
      if (problem) {
        problems[key] = problem;
        continue;
      }
      if (def.secret && !this.crypto) {
        problems[key] = 'SECRETS_ENC_KEY is not set, so secrets cannot be stored.';
        continue;
      }
      toWrite.push({ key, value, def });
    }

    if (Object.keys(problems).length > 0) throw new SettingsValidationError(problems);

    let restartRequired = false;
    for (const { key, value, def } of toWrite) {
      if (def.restartToApply && this.resolve(key) !== value) restartRequired = true;
      const encrypted = def.secret === true;
      const stored = encrypted ? this.crypto!.encrypt(value) : value;
      await this.db
        .insert(deploymentSettings)
        .values({ key, value: stored, encrypted, updatedBy })
        .onConflictDoUpdate({
          target: deploymentSettings.key,
          set: { value: stored, encrypted, updatedBy, updatedAt: new Date() },
        });
      this.stored.set(key, value);
    }

    // The git token is consumed through the environment (the credential helper
    // reads `$GITHUB_TOKEN` at call time, so it never appears in argv). Putting
    // it there is what makes a token saved here work without a restart.
    this.syncGitTokenEnv();
    return { restartRequired };
  }

  /** Drop stored rows for settings this build no longer defines. */
  async prune(): Promise<void> {
    const known = [...this.defs.keys()];
    if (known.length === 0) return;
    const rows = await this.db.select({ key: deploymentSettings.key }).from(deploymentSettings);
    const orphans = rows.map((r) => r.key).filter((k) => !known.includes(k));
    if (orphans.length > 0) {
      await this.db.delete(deploymentSettings).where(inArray(deploymentSettings.key, orphans));
    }
  }

  /**
   * Publish the resolved git token as `GITHUB_TOKEN`, the name the credential
   * helper and every redaction path already read. Only when the environment did
   * not supply one — otherwise this would overwrite the operator's value with
   * a stored fallback, inverting the precedence everything else here obeys.
   */
  syncGitTokenEnv(): void {
    if (this.sourceOf('gitToken') !== 'stored') return;
    const token = this.resolve('gitToken');
    if (token) process.env.GITHUB_TOKEN = token;
  }

  /** Remove one stored row (used by tests and by `prune`). */
  async clear(key: string): Promise<void> {
    await this.db.delete(deploymentSettings).where(eq(deploymentSettings.key, key));
    this.stored.delete(key);
  }
}

/** Field-keyed validation failures, so the screen can mark the offending input. */
export class SettingsValidationError extends Error {
  constructor(readonly problems: Record<string, string>) {
    super(`Invalid settings: ${Object.keys(problems).join(', ')}`);
    this.name = 'SettingsValidationError';
  }
}
