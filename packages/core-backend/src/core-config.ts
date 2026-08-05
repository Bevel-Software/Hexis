import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultKbTemplateDir } from './assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Configuration for the CORE platform: the git-backed workspace/workflow,
 * skills, tools, secrets vault, access control, and the MCP surface. Contains
 * NO LLM, connector, or SSO-provider settings — those live on the enterprise
 * `AppConfig` (config.ts), which extends this class. A core-only deployment
 * boots from exactly these env vars.
 */
export class CoreConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly nodeEnv: string;
  /**
   * Tenant slug injected into every credential prefix so a deploy can brand its
   * keys (`<tenant>_…` external API keys, `<tenant>-int_…` internal tokens,
   * `<tenant>-up_…` upload tokens). Defaults to `bevel`. Changing it on an
   * existing deployment invalidates previously minted keys/tokens (their
   * prefix no longer matches), so pick it once. Lowercase alphanumeric only —
   * `_` and `-` are reserved as prefix separators.
   */
  readonly tenantId: string;
  readonly workspacesRoot: string;
  /**
   * Sibling-to-`workspacesRoot` location for the diff-review backup ledger.
   * Layout mirrors `workspacesRoot` one-to-one: each user's repo lives at
   * `<workspacesRoot>/<userId>/<repo>/...` and its backup at
   * `<backupsRoot>/<userId>/<repo>/...`. Default sits next to workspaces so
   * the two move together when ops point them at a different volume.
   */
  readonly backupsRoot: string;
  /**
   * Sibling-to-`workspacesRoot` location for `call_tool_chain` spill files —
   * oversized tool-chain results parked outside any workspace so any agent (in-
   * process or external over MCP) can read them back via `read_file`. Ephemeral,
   * never committed, best-effort GC'd on write.
   */
  readonly spillRoot: string;
  readonly jwtSecret: string;
  /**
   * The deployment's owner. REQUIRED — three separate jobs rest on it, and a
   * deployment without one has no way to be administered:
   *
   *  - always recognized as an admin (see AdminAccessService), whatever the
   *    sign-in method, so a KB whose `roles.yaml` does not list them yet is
   *    still administrable;
   *  - written as the sole Admin into the `roles.yaml` generated when an EMPTY
   *    KB remote is seeded (this replaced `SEED_ADMIN_EMAILS`, which asked for
   *    the same answer a second time);
   *  - half of the bootstrap password credential below.
   */
  readonly adminEmail: string;
  /**
   * Password half of the bootstrap credential, checked directly against the
   * environment at login time (never stored) so a fresh deployment can sign in
   * before any account exists. Unset it and the credential stops working
   * immediately; accounts in the database are unaffected.
   *
   * Required only when password login is ENABLED. An SSO-only deployment
   * (`LOGIN_PASSWORD=false`) would otherwise have to mint a shared password
   * the server is configured to reject — an unused credential someone still
   * has to store and rotate. The admin identity above is required either way,
   * so "there is always an identifiable admin" holds regardless.
   */
  readonly adminPassword: string;
  /**
   * Generic OIDC single sign-on (any spec-compliant provider: Entra, Okta,
   * Auth0, Keycloak, Google, …). Enabled when issuer URL + client id + client
   * secret are ALL set; the issuer's `/.well-known/openid-configuration` is
   * discovered at first use. The redirect URI to register with the provider is
   * `<PUBLIC_BACKEND_URL>/api/auth/oidc/callback`.
   */
  readonly oidcIssuerUrl: string;
  readonly oidcClientId: string;
  readonly oidcClientSecret: string;
  /** Space-separated scopes requested (default `openid profile email`). */
  readonly oidcScopes: string;
  /** Login-button label (default "Single sign-on"). */
  readonly oidcProviderLabel: string;
  /** Clone/push URL for the KB repo. Any https git host (GitHub, GitLab, Bitbucket, Azure DevOps, self-hosted). */
  readonly kbRepoUrl: string;
  /** Directory name the KB lives under inside each user's workspace dir. */
  readonly kbDirName: string;
  /**
   * Username sent in the git-over-HTTPS Basic credential (password = the git
   * token). All major hosts accept a token as the password but differ on the
   * username: GitHub `x-access-token` (default), GitLab `oauth2`, Bitbucket
   * `x-token-auth`, Azure DevOps any non-empty value. Set `GIT_USERNAME` per
   * host. Restricted to a safe charset because it's interpolated into the
   * credential-helper shell snippet.
   */
  readonly gitUsername: string;
  /**
   * Filesystem path to the KB seed template (the `kb-template/` folder shipped
   * inside this package — see `defaultKbTemplateDir()`). The seeder reads this
   * to initialise an empty KB remote, and to top-up missing scaffolding on an
   * existing one. Override with `KB_TEMPLATE_DIR`.
   */
  readonly kbTemplateDir: string;
  /**
   * Ontology-session boundary kill-switch. When true (default), an agent run
   * that has read across more than one ontology can no longer write. A no-op on
   * a single-ontology KB. Set `ONTOLOGY_SESSION_BLOCK=false` to disable.
   *
   * Stays on CORE config (not `AppConfig`) even though the write BLOCK itself
   * is an enterprise-registered hook: the flag also switches off the core-owned
   * touch TRACKING (the gate skips entirely when false — see
   * `session-ontology.gate.ts`), so it must exist wherever the tracking runs.
   */
  readonly ontologySessionBlock: boolean;
  /**
   * Password-login toggle for the login screen. Default enabled; set
   * `LOGIN_PASSWORD=false` to hide the method AND reject `/auth/login`
   * server-side. SSO methods are separate `AuthProviderPlugin`s wired by the
   * composition root — their toggles live with their configuration.
   */
  readonly loginPasswordEnabled: boolean;
  /**
   * Optional allow-list of email domains for SSO — part of the OIDC
   * configuration, and only meaningful alongside it.
   *
   * SSO AUTO-PROVISIONS: `loginWithSso` upserts the account on first sign-in,
   * with no admin approval step. Against a single-tenant issuer the issuer is
   * already the boundary and this is belt-and-braces; against a multi-tenant
   * one (Google, the Entra `common` endpoint, Auth0 with social connections)
   * it is the ONLY boundary — without it, anyone the issuer will authenticate
   * provisions themselves into the deployment.
   *
   * Deliberately NOT applied to the other two entry points. An account an
   * admin created is vetted by the act of creating it, and password login can
   * only reach an account that already exists — so a check there would gate
   * nothing while being able to lock out a bootstrap admin whose own address
   * sits outside the list.
   *
   * Comma/whitespace-separated; empty (default) allows any email. Matches the
   * domain exactly or as a subdomain, and a leading `@` or `.` is tolerated:
   * `ALLOWED_EMAIL_DOMAINS=bevel.software, example.com` works as expected.
   */
  readonly allowedEmailDomains: string[];
  /**
   * 32-byte key (hex or base64) for AES-256-GCM encryption of core at-rest
   * secrets: the secrets-vault values and the MCP OAuth client secrets/tokens.
   * Read from `SECRETS_ENC_KEY`, falling back to the legacy
   * `CONNECTOR_CONFIG_ENC_KEY` → `SHAREPOINT_TOKEN_ENC_KEY` chain so existing
   * deploys keep decrypting without re-keying. Empty = secret values can't be
   * saved (a clear error surfaces only when a secret is actually written/read).
   */
  readonly secretsEncKey: string;
  /**
   * Optional dedicated HMAC key for internal (loopback) tokens. Unset
   * (default) → the composition root derives a domain-separated key from
   * `JWT_SECRET`, so every process sharing the deployment env (the server,
   * a routine CLI, a second replica) mints tokens the server verifies. Set
   * `INTERNAL_TOKEN_SECRET` to rotate the internal tool surface's credential
   * independently of user sessions.
   */
  readonly internalTokenSecret: string;
  /**
   * Express `trust proxy` setting, from `TRUST_PROXY`: the number of reverse
   * proxy hops in front of this backend (e.g. `1`), or an address/CIDR list
   * (`loopback`, `10.0.0.0/8`). Unset (default) → forwarded headers are
   * IGNORED and `req.ip` is the socket peer — correct for direct exposure,
   * but behind a proxy it makes every client share the proxy's IP (so the
   * per-IP login rate limit would pool all users). Set it to the actual hop
   * count — never a blanket trust — so clients can't spoof X-Forwarded-For.
   */
  readonly trustProxy: string;
  /**
   * Public base URL of THIS backend, used to build OAuth redirect URIs.
   * Must match a redirect URI registered with the OAuth provider(s).
   */
  readonly publicBackendUrl: string;
  /** Public base URL of the frontend, where callbacks redirect post-login. */
  readonly publicFrontendUrl: string;

  constructor() {
    this.port = parseInt(process.env.PORT || '3001', 10);
    this.databaseUrl = process.env.DATABASE_URL || 'postgresql://bevel:bevel@localhost:5432/bevel';
    this.nodeEnv = process.env.NODE_ENV || 'development';
    this.tenantId = (process.env.TENANT_ID || 'bevel').trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(this.tenantId)) {
      throw new Error(
        `TENANT_ID must be lowercase alphanumeric (no separators); got "${this.tenantId}"`,
      );
    }
    this.workspacesRoot = process.env.WORKSPACES_ROOT || path.resolve(process.cwd(), 'workspaces');
    this.backupsRoot = process.env.BACKUPS_ROOT || path.resolve(this.workspacesRoot, '..', 'backups');
    this.spillRoot = process.env.SPILL_ROOT || path.resolve(this.workspacesRoot, '..', 'tool-chain-spills');
    this.jwtSecret = process.env.JWT_SECRET || '';
    // Parsed here rather than beside the other toggles below: whether the
    // bootstrap PASSWORD is required depends on it.
    this.loginPasswordEnabled =
      (process.env.LOGIN_PASSWORD ?? 'true').trim().toLowerCase() !== 'false';
    this.adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    this.adminPassword = process.env.ADMIN_PASSWORD || '';
    if (!this.adminEmail) {
      throw new Error(
        'ADMIN_EMAIL is required — the address that owns this deployment. It is ' +
          'always treated as an admin (whatever the sign-in method) and is written ' +
          'as the initial Admin when an empty knowledge-base repo is seeded.',
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.adminEmail)) {
      throw new Error(`ADMIN_EMAIL is not a valid email: "${this.adminEmail}"`);
    }
    // Only when password login can actually be used. An SSO-only deployment
    // has no use for this value and should not have to hold one.
    if (this.loginPasswordEnabled && !this.adminPassword) {
      throw new Error(
        'ADMIN_PASSWORD is required while password login is enabled — it is the ' +
          'credential that signs in before any account exists. Set it, or set ' +
          'LOGIN_PASSWORD=false if this deployment signs in through SSO only.',
      );
    }
    this.oidcIssuerUrl = (process.env.OIDC_ISSUER_URL || '').trim().replace(/\/+$/, '');
    this.oidcClientId = (process.env.OIDC_CLIENT_ID || '').trim();
    this.oidcClientSecret = (process.env.OIDC_CLIENT_SECRET || '').trim();
    this.oidcScopes = (process.env.OIDC_SCOPES || 'openid profile email').trim();
    this.oidcProviderLabel = (process.env.OIDC_PROVIDER_LABEL || 'Single sign-on').trim();
    if (this.oidcIssuerUrl) {
      // Parse-validate so a typo'd issuer fails at boot, not at first login.
      try {
        new URL(this.oidcIssuerUrl);
      } catch {
        throw new Error(`OIDC_ISSUER_URL is not a valid URL: "${this.oidcIssuerUrl}"`);
      }
    }
    // No default, and no longer fatal when absent: an unconfigured deployment
    // boots into the setup screen, where an admin supplies it (and where the
    // value can be verified against the real remote before it is saved). What
    // stays fatal is a value that is present and WRONG — see
    // `validateKbIdentity` — because that surfaces later as a confusing clone
    // failure instead of a clear one now.
    this.kbRepoUrl = (process.env.KB_REPO_URL || '').trim();
    this.kbDirName = (process.env.KB_DIR_NAME || '').trim();
    // Provider-neutral git token: operators can set GIT_TOKEN (or the legacy
    // GITHUB_TOKEN / GH_TOKEN). Normalize onto GITHUB_TOKEN — the name the
    // credential helper and every `$GITHUB_TOKEN` read + redaction use — so all
    // three work unchanged. GIT_TOKEN takes PRECEDENCE: it's the provider-neutral
    // name, so setting it must override a stale legacy GITHUB_TOKEN (e.g. when
    // switching the KB from GitHub to GitLab), not be shadowed by it.
    const gitToken = process.env.GIT_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (gitToken) process.env.GITHUB_TOKEN = gitToken;
    this.gitUsername = (process.env.GIT_USERNAME || 'x-access-token').trim();
    // Interpolated into the credential-helper shell snippet, so reject anything
    // that isn't a plain token — no quotes, spaces, or shell metacharacters.
    if (!/^[A-Za-z0-9._-]+$/.test(this.gitUsername)) {
      throw new Error(
        `GIT_USERNAME must match [A-Za-z0-9._-]+ (a plain auth username); got "${this.gitUsername}"`,
      );
    }
    // Default: the `kb-template/` folder shipped inside this package (works
    // both from src/ and compiled dist/ — see assets.ts).
    this.kbTemplateDir = process.env.KB_TEMPLATE_DIR || defaultKbTemplateDir();
    this.ontologySessionBlock =
      (process.env.ONTOLOGY_SESSION_BLOCK ?? 'true').trim().toLowerCase() !== 'false';
    this.allowedEmailDomains = (process.env.ALLOWED_EMAIL_DOMAINS || '')
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^[@.]+/, ''))
      .filter((d) => d.length > 0);
    this.secretsEncKey = (
      process.env.SECRETS_ENC_KEY ||
      process.env.CONNECTOR_CONFIG_ENC_KEY ||
      process.env.SHAREPOINT_TOKEN_ENC_KEY ||
      ''
    ).trim();
    this.internalTokenSecret = (process.env.INTERNAL_TOKEN_SECRET || '').trim();
    this.trustProxy = (process.env.TRUST_PROXY || '').trim();
    this.publicBackendUrl = (process.env.PUBLIC_BACKEND_URL || `http://localhost:${this.port}`)
      .trim()
      .replace(/\/+$/, '');
    this.publicFrontendUrl = (process.env.PUBLIC_FRONTEND_URL || 'http://localhost:5173')
      .trim()
      .replace(/\/+$/, '');
    // Parse-validate so a malformed URL fails at boot rather than producing a
    // broken OAuth redirect later. (We intentionally don't force https / reject
    // localhost in production: local Docker runs prod mode over http://localhost.)
    for (const [name, value] of [
      ['PUBLIC_BACKEND_URL', this.publicBackendUrl],
      ['PUBLIC_FRONTEND_URL', this.publicFrontendUrl],
    ] as const) {
      try {
        new URL(value);
      } catch {
        throw new Error(`${name} is not a valid URL: "${value}"`);
      }
    }

    this.validateKbIdentity();
  }

  /** Prefix for external API keys (connection keys): `<tenant>_`. */
  get externalApiKeyPrefix(): string {
    return `${this.tenantId}_`;
  }

  /** Prefix for in-process internal HMAC tokens: `<tenant>-int_`. */
  get internalTokenPrefix(): string {
    return `${this.tenantId}-int_`;
  }

  /** Prefix for scoped single-use bulk-upload tokens: `<tenant>-up_`. */
  get uploadTokenPrefix(): string {
    return `${this.tenantId}-up_`;
  }

  /** Prefix for MCP OAuth access tokens: `<tenant>-mcp_`. */
  get mcpOAuthTokenPrefix(): string {
    return `${this.tenantId}-mcp_`;
  }

  /**
   * Validate the KB-identity inputs THAT WERE SUPPLIED. Absent is fine — the
   * setup screen collects them — but a present-and-malformed value fails at
   * boot rather than later, as a clone error nobody can read.
   */
  private validateKbIdentity(): void {
    if (this.kbRepoUrl) {
      let parsed: URL;
      try {
        parsed = new URL(this.kbRepoUrl);
      } catch {
        throw new Error(`KB_REPO_URL is not a valid URL: ${this.kbRepoUrl}`);
      }
      if (parsed.protocol !== 'https:') {
        throw new Error(`KB_REPO_URL must use https://: ${this.kbRepoUrl}`);
      }
    }

    // Joined with workspace paths via path.join — separators or ".." would let it
    // escape the workspace dir.
    if (!this.kbDirName) return;
    if (
      this.kbDirName === '.' ||
      this.kbDirName === '..' ||
      this.kbDirName.includes('/') ||
      this.kbDirName.includes('\\') ||
      path.isAbsolute(this.kbDirName)
    ) {
      throw new Error(`KB_DIR_NAME must be a single path segment: ${this.kbDirName}`);
    }
  }
}
