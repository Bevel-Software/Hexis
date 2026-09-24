import { eq, inArray } from 'drizzle-orm';
import { logger } from '../../shared/logging.js';

const log = logger('settings');
import type { Database } from '../database/connection.js';
import { deploymentSettings } from '../database/core-schema.js';
import {
  DEFAULT_KB_LAYOUT,
  type KbLayout,
  validateAgentsFileName,
  validateBranchModel,
  validateKbLayout,
  validateKbRootName,
} from '@bevel-software/platform-shared';
import { createHmac } from 'node:crypto';
import { TokenCrypto } from '../../shared/token-crypto.js';
import { assertKbDirNameFree } from '../kb-fs/repo-path.js';
import { parseRetentionWindow } from '../audit/audit.contract.js';
import { normalizeIssuerUrl } from './oidc-check.js';

/**
 * A setting an admin may set from the setup screen instead of the environment.
 *
 * `envVar` is the name that still wins if it is set — see
 * {@link DeploymentSettingsService}. `secret` values are sealed at rest and
 * never read back out to a client.
 */
export interface SettingDef {
  key: string;
  /**
   * The environment variable that still WINS over a stored row, when there is
   * one — see {@link DeploymentSettingsService}.
   *
   * Absent for the knowledge-base layout (the three root folders and the agent
   * guide's file name): those are entered in the app and nowhere else. They had
   * variables once; a deployment that still sets one gets its value imported
   * into the saved setting on the first boot after the upgrade, and the
   * variable ignored from then on (see
   * {@link DeploymentSettingsService.importLegacyLayoutEnv}).
   */
  envVar?: string;
  /** Which block of the setup screen it belongs to. */
  section: 'knowledge-base' | 'sign-in' | 'audit';
  secret?: boolean;
  /** Applied on save; the message is shown against the field. */
  validate?(value: string): string | null;
  /**
   * True when a running server cannot pick the new value up. Everything the
   * KB remote needs is read per-operation and applies at once; anything that
   * was copied into a service at construction is not.
   */
  restartToApply?: boolean;
  /**
   * A blank field on save CLEARS the stored value, putting the default back.
   * The rule everywhere else is that blank means "leave it alone" — a stray
   * Enter must not unconfigure a repository — and that stays the rule; this
   * is for a setting whose readers already treat "unset" as its default, so
   * clearing it is the one way back to that default and never a loss.
   */
  blankMeansDefault?: boolean;
  /**
   * What an UNSET setting already means to the code that reads it — the
   * layout's defaults, the pointer consent's "on unless turned off".
   *
   * Only `restartToApply` settings need it, and only for one question: saving
   * a value the deployment is ALREADY running on changes nothing, so it owes
   * no restart. Without it, ticking a box that was ticked all along, or typing
   * `AGENTS.md` into a field that was showing `AGENTS.md`, tells the admin to
   * restart for a change that never happened.
   */
  unsetMeans?: string;
}

/**
 * The one rule for what a KB remote may look like, shared by the setting below
 * and the connection test — which must apply it BEFORE handing the value to
 * git. An unvalidated string reaching `git ls-remote` is argument injection:
 * `--upload-pack=…` runs a command of the caller's choosing, and git's `ext::`
 * transport is a shell escape by design.
 */
export const validateHttpsRemote = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full URL, e.g. https://github.com/acme/knowledge-base.git';
  }
  if (parsed.protocol !== 'https:') return 'The URL must start with https://';
  // Userinfo would ride into git's argv on every call, visible in process
  // listings — the KB startup refuses such a URL, so saving one only defers the
  // failure to the next boot.
  if (parsed.username || parsed.password) {
    return 'Remove the username and token from the URL — enter the token in its own field.';
  }
  return null;
};

/**
 * The core catalogue. Order is the order the setup screen renders them in.
 */
export const CORE_SETTINGS: SettingDef[] = [
  {
    key: 'kbRepoUrl',
    envVar: 'KB_REPO_URL',
    section: 'knowledge-base',
    validate: validateHttpsRemote,
  },
  {
    key: 'gitToken',
    envVar: 'GIT_TOKEN',
    section: 'knowledge-base',
    secret: true,
    validate: (v) => (v.trim() ? null : 'A token is required to read and write the repository.'),
  },
  {
    key: 'gitUsername',
    envVar: 'GIT_USERNAME',
    section: 'knowledge-base',
    // Interpolated into the credential-helper shell snippet, so anything that
    // is not a plain token is rejected rather than escaped.
    validate: (v) =>
      /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Use only letters, digits, dot, underscore or hyphen.',
  },
  {
    key: 'kbDirName',
    envVar: 'KB_DIR_NAME',
    section: 'knowledge-base',
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

  /**
   * The KB layout: the three root folders a deployment may rename so hexis can
   * read a repository laid out by someone else (`skills/` and `plugins/` in
   * lowercase, say), and the file name of the managed agent guide.
   * Restart-to-apply like the branch model — the names are applied once at boot
   * through `configureKbLayout` and served to the browser once by
   * `/api/config`. Each has a default, so an unset field means the default, not
   * an unconfigured deployment. Checked as a QUARTET in `save`: the four must
   * differ, and one field alone cannot see the other three.
   *
   * NO `envVar`, on any of the four. Layout is deployment configuration that is
   * entered once in the app; the three that used to be environment-driven are
   * imported into their saved setting on the first boot after the upgrade
   * ({@link DeploymentSettingsService.importLegacyLayoutEnv}) so nothing
   * silently reverts to the defaults.
   */
  {
    key: 'knowledgeBaseDir',
    section: 'knowledge-base',
    validate: validateKbRootName,
    restartToApply: true,
    unsetMeans: DEFAULT_KB_LAYOUT.knowledgeBaseDir,
  },
  {
    key: 'skillsDir',
    section: 'knowledge-base',
    validate: validateKbRootName,
    restartToApply: true,
    unsetMeans: DEFAULT_KB_LAYOUT.skillsDir,
  },
  {
    key: 'pluginsDir',
    section: 'knowledge-base',
    validate: validateKbRootName,
    restartToApply: true,
    unsetMeans: DEFAULT_KB_LAYOUT.pluginsDir,
  },
  {
    /**
     * The managed agent guide's file name. Its own validator says what a guide
     * may be called; the quartet check in `plan` is what keeps it clear of the
     * three folder names it is saved beside.
     */
    key: 'agentsFile',
    section: 'knowledge-base',
    validate: (v) => validateAgentsFileName(v),
    restartToApply: true,
    unsetMeans: DEFAULT_KB_LAYOUT.agentsFile,
  },
  {
    /**
     * Whether to keep the platform's one-sentence pointer in a customer's own
     * `AGENTS.md` — the admin's consent to the only text the platform ever adds
     * to a file it does not own. On unless it is explicitly turned off, because
     * a renamed guide nothing points at is a guide no coding agent will find.
     *
     * Restart-to-apply like the name it belongs to: the check runs once per
     * start, in the KB startup phase.
     */
    key: 'agentsFileLink',
    section: 'knowledge-base',
    validate: (v) => (v === 'true' || v === 'false' ? null : 'Use "true" or "false".'),
    restartToApply: true,
    // On unless explicitly turned off — the reading `resolveAgentsFileLink` applies.
    unsetMeans: 'true',
  },


  /**
   * The branch model. Both are restart-to-apply and could not be otherwise:
   * the backend hands `DEFAULT_BRANCH` to services at construction, and the
   * browser is served the pair once at boot — a live swap would leave half the
   * app on the old model and half on the new one.
   *
   * The pair is ALSO checked together in `save`, because neither field is
   * valid or invalid on its own: the default branch must appear in the
   * protected list, and a per-field rule cannot see the other side.
   */
  {
    key: 'defaultBranch',
    envVar: 'DEFAULT_BRANCH',
    section: 'knowledge-base',
    validate: (v) => (v.includes(',') ? 'One branch name, not a list.' : null),
    restartToApply: true,
  },
  {
    key: 'protectedBranches',
    envVar: 'PROTECTED_BRANCHES',
    section: 'knowledge-base',
    restartToApply: true,
  },

  {
    /**
     * The credential a git host's webhook or a pipeline presents to
     * `POST /api/sync` (see `modules/kb-sync/`). Deployment-level on purpose:
     * a person's connection key would stop the pipeline the day they leave.
     * Optional — without it the endpoint only admits an admin's own session.
     * Read per request, so it applies without a restart.
     */
    key: 'kbSyncSecret',
    envVar: 'KB_SYNC_SECRET',
    section: 'knowledge-base',
    secret: true,
    // The same floor `sync-auth.ts` enforces at request time (which is what
    // covers a secret set through the environment); this one just says so
    // before the save.
    validate: (v) =>
      v.trim().length >= 16 ? null : 'Use at least 16 characters — a random string is best.',
  },

  /**
   * Single sign-on. Applies without a restart: the OIDC provider is mounted
   * once at boot but reads these on every probe and sign-in, advertising
   * itself only while issuer, client id and secret are all set.
   */
  {
    key: 'oidcIssuerUrl',
    envVar: 'OIDC_ISSUER_URL',
    section: 'sign-in',
    validate: (v) => {
      try {
        return new URL(v).protocol === 'https:' ? null : 'The issuer URL must start with https://';
      } catch {
        return 'Enter the issuer URL, e.g. https://login.microsoftonline.com/<tenant>/v2.0';
      }
    },
  },
  {
    key: 'oidcClientId',
    envVar: 'OIDC_CLIENT_ID',
    section: 'sign-in',
  },
  {
    key: 'oidcClientSecret',
    envVar: 'OIDC_CLIENT_SECRET',
    section: 'sign-in',
    secret: true,
  },
  {
    key: 'oidcScopes',
    envVar: 'OIDC_SCOPES',
    section: 'sign-in',
  },
  {
    key: 'oidcProviderLabel',
    envVar: 'OIDC_PROVIDER_LABEL',
    section: 'sign-in',
  },
  {
    // Belongs with SSO because SSO is what makes it load-bearing: sign-in
    // auto-provisions, so against a multi-tenant issuer this list is the only
    // thing between "has an account somewhere" and "has an account here".
    key: 'allowedEmailDomains',
    envVar: 'ALLOWED_EMAIL_DOMAINS',
    section: 'sign-in',
    restartToApply: true,
  },

  {
    /**
     * How long the Audit log keeps an agent's events: a number of days, or
     * — blank, zero, negative — forever. Read at every prune, so it applies
     * without a restart. The window's rule lives with the audit service and
     * is applied here on save and there on every read, so the environment
     * variable is held to exactly what the Deployment page is. A blanked
     * field clears the stored value, which is how "forever" is chosen back.
     */
    key: 'auditRetentionDays',
    envVar: 'AUDIT_RETENTION_DAYS',
    section: 'audit',
    blankMeansDefault: true,
    validate: (v) =>
      parseRetentionWindow(v) === null ? 'Enter a whole number of days, or 0 to keep events forever.' : null,
  },
];

/**
 * The environment variables the KB layout USED to be read from, and the
 * settings they now live in. Referenced only by
 * {@link DeploymentSettingsService.importLegacyLayoutEnv} — nothing else may
 * read them, or they would be back to being a second source of truth. The
 * guide's file name is deliberately absent: it never had a variable, so there
 * is nothing to import.
 */
export const LEGACY_LAYOUT_ENV_VARS: Readonly<Record<string, string>> = Object.freeze({
  knowledgeBaseDir: 'KB_KNOWLEDGE_BASE_DIR',
  skillsDir: 'KB_SKILLS_DIR',
  pluginsDir: 'KB_PLUGINS_DIR',
});

/**
 * Whether the single sign-on configuration in effect is known to work:
 * `verified` (the provider accepted its credentials, or someone signed in with
 * it), `unverified` (configured, never proven — sign in once to confirm), or
 * `not-configured` (no issuer, application id and secret to prove), or
 * `unrecordable` (configured, but SECRETS_ENC_KEY is unset — see
 * {@link DeploymentSettingsService.oidcVerification}).
 */
export type OidcVerificationState = 'verified' | 'unverified' | 'not-configured' | 'unrecordable';

/** What a record can say about one set of values. */
export type OidcRecordState = 'verified' | 'unverified';

/** The three values a verification is about. Scopes, label and domains are not among them. */
export interface OidcCredentials {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * The rows holding verification records: ONE PER SET OF VALUES, keyed
 * `oidcVerification:<fingerprint>`. Not settings — nobody types them — so they
 * have no catalogue entry, are never described or loaded, and `prune` leaves
 * them be.
 *
 * A row per fingerprint rather than one shared row is what makes concurrent
 * writers safe without a lock: a sign-in finishing through a provider built
 * from OLD values records those old values under their own key, and can never
 * overwrite what a save (or another replica) recorded about the new ones.
 */
const OIDC_VERIFICATION_PREFIX = 'oidcVerification:';

/** Where a resolved value came from, which is what the UI renders as its status. */
export type SettingSource = 'env' | 'stored' | 'unset';

export interface ResolvedSetting {
  key: string;
  /** Omitted for a setting no environment variable can override. */
  envVar?: string;
  section: SettingDef['section'];
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
 * ONE EXCEPTION, and it is a setting-by-setting one rather than a hole in the
 * rule: a definition with no {@link SettingDef.envVar} has no variable to be
 * outranked by. That is the knowledge-base layout — the three root folders and
 * the agent guide's file name — which is deployment configuration entered once
 * in the app. The three variables it used to read are imported into their saved
 * settings on the first boot after the upgrade ({@link
 * DeploymentSettingsService.importLegacyLayoutEnv}) and ignored after that.
 *
 * Values are cached in memory after {@link load}. Reads happen on every clone
 * and every git call, and a database round-trip there would be a tax on the
 * hot path for data that changes about twice in a deployment's life.
 *
 * WHICH MAKES THE CACHE PER-PROCESS, and that is a real constraint rather than
 * an oversight: a second replica keeps serving what it read at boot until it
 * restarts. It is acceptable here only because of what these settings are —
 * the knowledge-base connection, written once during first-run setup, on a
 * deployment that has nothing to serve until it is. Nobody is mid-session on a
 * second replica at that moment.
 *
 * The single sign-on settings are the first to bend that: they apply live, so
 * on a multi-replica deployment an OIDC change reaches only the replica that
 * served the save until the others restart.
 *
 * It stops being acceptable the moment a setting is something an operator
 * changes on a live multi-replica deployment. Adding one means adding
 * invalidation with it — the event bus already carries user-scoped and
 * broadcast messages, so a `settings-changed` event that triggers `load()` is
 * the natural shape.
 */
export class DeploymentSettingsService {
  private readonly defs = new Map<string, SettingDef>();
  private stored = new Map<string, string>();
  private readonly crypto: TokenCrypto | null;

  constructor(
    private readonly db: Database,
    private readonly secretsEncKey: string,
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
          log.warn(`"${row.key}" is stored encrypted but SECRETS_ENC_KEY is unset — ignoring it.`);
          continue;
        }
        try {
          next.set(row.key, this.crypto.decrypt(row.value));
        } catch {
          // A rotated or mistyped key. Loud, and skipped rather than fatal:
          // one unreadable setting must not stop the server from booting into
          // the screen where it can be fixed.
          log.error(`could not decrypt "${row.key}" — is SECRETS_ENC_KEY correct?`);
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
    const fromEnv = def.envVar ? (process.env[def.envVar] ?? '').trim() : '';
    if (fromEnv) return fromEnv;
    return (this.stored.get(key) ?? '').trim();
  }

  /**
   * The KB layout in effect: each root from the environment, else the stored
   * row, else its default. The composition root applies this once at boot.
   */
  resolveKbLayout(): Required<KbLayout> {
    return {
      knowledgeBaseDir: this.resolve('knowledgeBaseDir') || DEFAULT_KB_LAYOUT.knowledgeBaseDir,
      skillsDir: this.resolve('skillsDir') || DEFAULT_KB_LAYOUT.skillsDir,
      pluginsDir: this.resolve('pluginsDir') || DEFAULT_KB_LAYOUT.pluginsDir,
      agentsFile: this.resolve('agentsFile') || DEFAULT_KB_LAYOUT.agentsFile,
    };
  }

  /**
   * Whether the platform should keep its pointer sentence in a customer-owned
   * `AGENTS.md`. On unless the admin turned it off — an unset setting is a
   * deployment that never saw the checkbox, and the sentence is what makes a
   * renamed guide findable at all.
   */
  resolveAgentsFileLink(): boolean {
    return this.resolve('agentsFileLink') !== 'false';
  }

  /**
   * Import the retired layout environment variables into their saved settings,
   * ONCE, on a deployment that still sets them.
   *
   * The three roots were environment-first until this release. Simply dropping
   * the variables would put such a deployment back on `KnowledgeBase/`,
   * `Skills/` and `Plugins/` at its next boot — against a repository laid out
   * under other names, which is a knowledge base that scaffolds three empty
   * folders and imports nothing. So on the first boot after the upgrade each
   * still-set variable's value becomes the saved setting, and the log says the
   * variable can be removed.
   *
   * Only where nothing is saved. A saved value is the admin's own answer,
   * entered in the app, and it wins — with a warning, because a variable that
   * no longer does anything is exactly the kind of thing someone later reads
   * as the reason for a name. Equal values say nothing: there is nothing to
   * tell anyone about.
   *
   * Called before `configureKbLayout`, so the boot that imports also RUNS on
   * the imported names rather than on the defaults.
   */
  async importLegacyLayoutEnv(): Promise<void> {
    for (const [key, envVar] of Object.entries(LEGACY_LAYOUT_ENV_VARS)) {
      const fromEnv = (process.env[envVar] ?? '').trim();
      if (!fromEnv) continue;
      const saved = (this.stored.get(key) ?? '').trim();
      if (saved) {
        if (saved !== fromEnv) {
          log.warn(
            `${envVar} is ignored — the saved setting ("${saved}") wins. Remove the variable.`,
          );
        }
        continue;
      }
      // Validated like any save: a variable holding something no folder may be
      // called is a misconfiguration, and importing it would move the failure
      // to the first write into a folder nobody can name.
      const problem = validateKbRootName(fromEnv);
      if (problem) {
        log.warn(`${envVar} ("${fromEnv}") is not a usable folder name (${problem}) — not imported.`);
        continue;
      }
      await this.db
        .insert(deploymentSettings)
        .values({ key, value: fromEnv, encrypted: false, updatedBy: null })
        .onConflictDoUpdate({
          target: deploymentSettings.key,
          set: { value: fromEnv, encrypted: false, updatedBy: null, updatedAt: new Date() },
        });
      this.stored.set(key, fromEnv);
      log.info(`Imported ${envVar} ("${fromEnv}") into the saved setting — the variable can be removed.`);
    }
  }

  /** Where {@link resolve} got its answer — what the setup screen labels the field with. */
  sourceOf(key: string): SettingSource {
    const def = this.defs.get(key);
    if (!def) return 'unset';
    // A setting with no variable can never read `env`, whatever the process
    // environment happens to hold — which is what makes the layout fields
    // editable in the app on a deployment that still sets the old variables.
    if (def.envVar && (process.env[def.envVar] ?? '').trim()) return 'env';
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
        ...(def.envVar ? { envVar: def.envVar } : {}),
        section: def.section,
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
   *
   * `restartRequired` is this service's view: some restart-to-apply setting
   * changed. It cannot know what the caller then applies to the running
   * process, so `restartKeys` names the settings behind it — the setup route
   * leaves out the folder names and the branch model when the save that
   * completes setup has just applied them, and reports only what remains.
   */
  async save(
    entries: Record<string, string>,
    updatedBy: string | null,
  ): Promise<{ restartRequired: boolean; restartKeys: string[] }> {
    const { toWrite, toClear } = this.plan(entries);

    /** The settings this save changed that a running server cannot pick up. */
    const restartKeys: string[] = [];
    // A blanked blank-means-default setting: its row goes, and its readers
    // are back on the default from the next read.
    for (const key of toClear) await this.clear(key);
    for (const { key, value, def } of toWrite) {
      // Compared against the EFFECTIVE value: a setting that was unset was
      // already running on whatever its readers make of "unset" — the layout
      // roots on their defaults, the pointer consent on — so saving that same
      // answer changes nothing a restart would pick up.
      const effective = this.resolve(key) || def.unsetMeans || '';
      if (def.restartToApply && effective !== value) restartKeys.push(key);
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
    return { restartRequired: restartKeys.length > 0, restartKeys };
  }

  /**
   * What {@link resolve} would answer for each key AFTER saving `entries` —
   * validated by exactly the rules `save` applies, and throwing the same
   * {@link SettingsValidationError}, but writing nothing. It is how a caller
   * checks the values a save would put in effect (the repository connection)
   * before letting the save happen.
   */
  resolveAfter(entries: Record<string, string>): (key: string) => string {
    const { toWrite, toClear } = this.plan(entries);
    return (key) =>
      toClear.includes(key) ? '' : (toWrite.find((w) => w.key === key)?.value ?? this.resolve(key));
  }

  /** Validate a batch and return the writes (and the clears) it amounts to; throws on any problem. */
  private plan(entries: Record<string, string>): {
    toWrite: { key: string; value: string; def: SettingDef }[];
    toClear: string[];
  } {
    const problems: Record<string, string> = {};
    const toWrite: { key: string; value: string; def: SettingDef }[] = [];
    const toClear: string[] = [];

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
      // The one exception is a setting that SAYS a blank is its default (see
      // `SettingDef.blankMeansDefault`): for it a blank clears the stored row.
      if (!value) {
        if (def.blankMeansDefault) toClear.push(key);
        continue;
      }
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

    // The branch pair is the one cross-field rule: neither name is valid or
    // invalid alone, since the default must appear in the protected list. Check
    // the model this save WOULD produce — the written value where there is one,
    // the value already in effect where there is not — so setting one half
    // against an existing other half is judged on the result, not the input.
    const branchKeys = ['defaultBranch', 'protectedBranches'];
    if (toWrite.some((w) => branchKeys.includes(w.key))) {
      const effective = (key: string) =>
        toWrite.find((w) => w.key === key)?.value ?? this.resolve(key);
      const problem = validateBranchModel({
        defaultBranch: effective('defaultBranch'),
        protectedBranches: effective('protectedBranches'),
      });
      // Reported against the protected list: it is the field with room to hold
      // the answer, and "add it to this list" is the usual fix.
      if (problem) problems.protectedBranches = problem;
    }

    // The layout quartet is the other cross-field rule: three folder names and
    // a guide file name that must all differ. Judged on the layout this save
    // WOULD produce, with the default standing in for anything neither written
    // nor stored — so renaming the plugins folder to what the guide is already
    // called is refused whichever of the two the save names.
    const layoutKeys = ['knowledgeBaseDir', 'skillsDir', 'pluginsDir', 'agentsFile'] as const;
    if (toWrite.some((w) => (layoutKeys as readonly string[]).includes(w.key))) {
      const effective = (key: (typeof layoutKeys)[number]) =>
        toWrite.find((w) => w.key === key)?.value || this.resolve(key) || DEFAULT_KB_LAYOUT[key];
      const problem = validateKbLayout({
        knowledgeBaseDir: effective('knowledgeBaseDir'),
        skillsDir: effective('skillsDir'),
        pluginsDir: effective('pluginsDir'),
        agentsFile: effective('agentsFile'),
      });
      // Against the field being written — the first one in the batch — since
      // any of the three could be the one that collides.
      if (problem) {
        const first = toWrite.find((w) => (layoutKeys as readonly string[]).includes(w.key))!;
        problems[first.key] = problem;
      }
    }

    // The checkout folder and the layout are the third cross-field rule: the
    // folder the repository is cloned into may not share a name with any of
    // the repository's own roots, or every path under that root would be read
    // as the checkout itself (see `assertKbDirNameFree`). Judged on what this
    // save would put in effect, like the two rules above, and here rather than
    // only at boot because setup applies a saved layout to the running process
    // without a restart — a save that gets through would take effect at once.
    const collisionKeys = ['kbDirName', ...layoutKeys] as const;
    if (toWrite.some((w) => (collisionKeys as readonly string[]).includes(w.key))) {
      const effective = (key: (typeof collisionKeys)[number]) =>
        toWrite.find((w) => w.key === key)?.value ||
        this.resolve(key) ||
        (key === 'kbDirName' ? 'knowledge-base' : DEFAULT_KB_LAYOUT[key]);
      try {
        assertKbDirNameFree(effective('kbDirName'), {
          knowledgeBaseDir: effective('knowledgeBaseDir'),
          skillsDir: effective('skillsDir'),
          pluginsDir: effective('pluginsDir'),
          agentsFile: effective('agentsFile'),
        });
      } catch (err) {
        // Against the field this save is writing — the checkout name when that
        // is what moved, else the first layout field in the batch — since
        // either side of the collision could be the one the operator typed.
        const first = toWrite.find((w) => (collisionKeys as readonly string[]).includes(w.key))!;
        problems[first.key] = err instanceof Error ? err.message : String(err);
      }
    }

    if (Object.keys(problems).length > 0) throw new SettingsValidationError(problems);
    return { toWrite, toClear };
  }

  /** Drop stored rows for settings this build no longer defines. */
  async prune(): Promise<void> {
    const known = [...this.defs.keys()];
    if (known.length === 0) return;
    const rows = await this.db.select({ key: deploymentSettings.key }).from(deploymentSettings);
    const orphans = rows
      .map((r) => r.key)
      .filter((k) => !known.includes(k) && !k.startsWith(OIDC_VERIFICATION_PREFIX));
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

  /** The single sign-on values in effect, issuer normalized the way the provider uses it. */
  resolveOidcCredentials(): OidcCredentials {
    return {
      issuerUrl: normalizeIssuerUrl(this.resolve('oidcIssuerUrl')),
      clientId: this.resolve('oidcClientId'),
      clientSecret: this.resolve('oidcClientSecret'),
    };
  }

  /**
   * Whether the single sign-on configuration IN EFFECT is verified.
   *
   * The record names the values it was made about by a keyed digest, so it
   * speaks only for those: a changed issuer, application id or secret —
   * through a save or through the environment — reads as unverified until it
   * is proven again, with nothing to remember to reset. The secret itself is
   * never stored here, and a digest keyed with the secrets key cannot be
   * checked against a guess without that key.
   *
   * WHICH IS WHY THERE IS NO RECORD WITHOUT THAT KEY: keyed with a public
   * constant, the digest of a public issuer and application id would let
   * anyone who can read `deployment_settings` (a backup, a replica, a dump)
   * confirm guesses of the secret offline. A salt stored beside it would be
   * read along with it. So with SECRETS_ENC_KEY unset nothing is recorded and
   * a configured deployment reads `unrecordable`.
   *
   * Read from the database, not the in-memory cache: unlike the settings, this
   * changes on a live deployment (every first sign-in), and a sign-in on one
   * replica must show as Verified on the others.
   */
  async oidcVerification(): Promise<OidcVerificationState> {
    const current = this.resolveOidcCredentials();
    if (!current.issuerUrl || !current.clientId || !current.clientSecret) return 'not-configured';
    if (!this.secretsEncKey) return 'unrecordable';
    return this.oidcVerificationOf(current);
  }

  /** What is recorded about one set of single sign-on values — `unverified` when nothing is. */
  async oidcVerificationOf(credentials: OidcCredentials): Promise<OidcRecordState> {
    if (!this.secretsEncKey) return 'unverified';
    const key = this.oidcVerificationKey(credentials);
    const rows = await this.db
      .select({ key: deploymentSettings.key, value: deploymentSettings.value })
      .from(deploymentSettings)
      .where(eq(deploymentSettings.key, key));
    return rows.some((row) => row.key === key && row.value === 'verified') ? 'verified' : 'unverified';
  }

  /**
   * Record what is known about one set of single sign-on values.
   *
   * ONLY EVER UPGRADES, atomically: `verified` overwrites, `unverified` only
   * fills an empty slot. The same values cannot stop being proven by an
   * inconclusive answer — an overlapping check that could not reach the token
   * endpoint says nothing against the sign-in that worked.
   *
   * Records about values no longer in effect are left in place rather than
   * swept: they are inert (nothing reads a key the current values do not hash
   * to), and a sweep racing a save on another replica could delete the record
   * of the values that end up in effect.
   */
  async recordOidcVerification(state: OidcRecordState, credentials: OidcCredentials): Promise<void> {
    // No secrets key, no record: see oidcVerification().
    if (!this.secretsEncKey) return;
    const key = this.oidcVerificationKey(credentials);
    const insert = this.db
      .insert(deploymentSettings)
      .values({ key, value: state, encrypted: false, updatedBy: null });
    if (state === 'unverified') {
      await insert.onConflictDoNothing({ target: deploymentSettings.key });
      return;
    }
    await insert.onConflictDoUpdate({
      target: deploymentSettings.key,
      set: { value: state, encrypted: false, updatedBy: null, updatedAt: new Date() },
    });
  }

  private oidcVerificationKey(credentials: OidcCredentials): string {
    // JSON-encoded, so no issuer, id or secret containing the separator can
    // make two different tuples hash alike.
    const tuple = JSON.stringify([
      normalizeIssuerUrl(credentials.issuerUrl),
      credentials.clientId,
      credentials.clientSecret,
    ]);
    const fingerprint = createHmac('sha256', `hexis-oidc-verification:${this.secretsEncKey}`)
      .update(tuple)
      .digest('hex');
    return `${OIDC_VERIFICATION_PREFIX}${fingerprint}`;
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
