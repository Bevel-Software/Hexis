import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveDatabaseUrl, type TenantConfig } from '../core-config.js';
import { DEFAULT_DB_SCHEMA, assertSchemaName } from '../modules/database/connection.js';
import { DEFAULT_GIT_TIMEOUT_MS } from '../modules/workflow/git/node-git-runner.js';
import { defaultKbTemplateDir } from '../assets.js';
import { DEFAULT_GIT_USERNAME } from '../shared/git.contract.js';
import { deriveTenantSecrets } from './tenant-secrets.js';
import { loopbackTenantBaseUrl } from './tenant-host.js';
import { assertTenantSlug, normalizeHost, type TenantDescriptor, type TenantSource } from './tenant-source.contract.js';

/**
 * What every tenant of one process shares: the process's own facts, the one
 * database, the roots its folders hang off, and the master key its secrets
 * derive from. A tenant's own record ({@link TenantRecord}) adds what differs.
 */
export interface TenantHostSettings {
  readonly databaseUrl: string;
  readonly port: number;
  readonly nodeEnv: string;
  readonly trustProxy: string;
  /** Each tenant's workspaces live under `<workspacesRoot>/<slug>`; its backups, spills and caches beside them. */
  readonly workspacesRoot: string;
  readonly kbTemplateDir: string;
  readonly gitTimeoutMs: number;
  readonly ontologySessionBlock: boolean;
  readonly updateCheckEnabled: boolean;
  /** See `tenant-secrets.ts`. */
  readonly masterKey: string;
}

/** One entry of the tenants file. Everything optional has the single-tenant default. */
export interface TenantRecord {
  slug: string;
  /** Host names (a port is tolerated and ignored) that reach this tenant. At least one. */
  hosts: string[];
  adminEmail: string;
  /** The bootstrap password; omitted, password login is off for this tenant. */
  adminPassword?: string;
  /** Force password login on or off; default: on exactly when `adminPassword` is set. */
  loginPassword?: boolean;
  kbRepoUrl?: string;
  gitToken?: string;
  gitUsername?: string;
  kbDirName?: string;
  /** The branch model; absent, the tenant's admin enters it on the setup screen. */
  defaultBranch?: string;
  protectedBranches?: string | string[];
  /** The bearer a git host's webhook presents to `POST /api/sync`. */
  kbSyncSecret?: string;
  /** Default `t_<slug>` with hyphens as underscores. */
  dbSchema?: string;
  /** The credential-prefix brand; default: the slug without hyphens. */
  tenantId?: string;
  /** Default `https://<first host>`. */
  publicBackendUrl?: string;
  /** Default: the backend URL (the backend serves the SPA). */
  publicFrontendUrl?: string;
  allowedEmailDomains?: string[];
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    scopes?: string;
    providerLabel?: string;
  };
}

/** The file's shape: a list of records. */
export interface TenantsFile {
  tenants: TenantRecord[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * A tenant's {@link TenantConfig} from its record and the host's settings:
 * the same values `CoreConfig` reads from the environment, resolved the same
 * way, with the folders and the schema named after the slug so two tenants
 * can never share a path or a table.
 */
export function tenantConfigFrom(record: TenantRecord, settings: TenantHostSettings): TenantConfig {
  const slug = assertTenantSlug(record.slug);
  if (!Array.isArray(record.hosts) || record.hosts.length === 0) {
    throw new Error(`Tenant "${slug}" names no host`);
  }
  const hosts = record.hosts.map(normalizeHost);
  const adminEmail = (record.adminEmail ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(adminEmail)) {
    throw new Error(`Tenant "${slug}": adminEmail is not a valid email: "${record.adminEmail ?? ''}"`);
  }
  const gitUsername = (record.gitUsername ?? DEFAULT_GIT_USERNAME).trim();
  if (!USERNAME_PATTERN.test(gitUsername)) {
    throw new Error(`Tenant "${slug}": gitUsername must match [A-Za-z0-9._-]+; got "${gitUsername}"`);
  }
  const tenantId = (record.tenantId ?? slug.replace(/-/g, '')).trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(tenantId)) {
    throw new Error(`Tenant "${slug}": tenantId must be lowercase alphanumeric; got "${tenantId}"`);
  }
  const dbSchema = assertSchemaName(record.dbSchema ?? `t_${slug.replace(/-/g, '_')}`);
  // The default schema is where a single-tenant deployment on the same
  // database keeps its tables and, in drizzle's own schema beside it, its
  // migration ledger; a tenant there would be no tenant at all.
  if (dbSchema === DEFAULT_DB_SCHEMA) {
    throw new Error(`Tenant "${slug}": dbSchema must not be "${DEFAULT_DB_SCHEMA}"; a tenant needs a schema of its own`);
  }
  const adminPassword = record.adminPassword ?? '';
  const loginPasswordEnabled = record.loginPassword ?? adminPassword !== '';
  if (loginPasswordEnabled && !adminPassword) {
    throw new Error(`Tenant "${slug}": loginPassword is on but no adminPassword is set`);
  }
  const publicBackendUrl = (record.publicBackendUrl ?? `https://${hosts[0]}`).trim().replace(/\/+$/, '');
  const publicFrontendUrl = (record.publicFrontendUrl ?? publicBackendUrl).trim().replace(/\/+$/, '');
  for (const [name, value] of [
    ['publicBackendUrl', publicBackendUrl],
    ['publicFrontendUrl', publicFrontendUrl],
  ] as const) {
    try {
      new URL(value);
    } catch {
      throw new Error(`Tenant "${slug}": ${name} is not a valid URL: "${value}"`);
    }
  }
  const secrets = deriveTenantSecrets(settings.masterKey, slug);
  const besideWorkspaces = (name: string) => path.resolve(settings.workspacesRoot, '..', name, slug);
  const allowedEmailDomains = (record.allowedEmailDomains ?? [])
    .map((d) => d.trim().toLowerCase().replace(/^[@.]+/, ''))
    .filter((d) => d.length > 0);
  const protectedBranches = Array.isArray(record.protectedBranches)
    ? record.protectedBranches.join(',')
    : (record.protectedBranches ?? '');
  // The record's settings, as the environment a single-tenant deployment
  // would pin them in: only what the record names, so the setup screen
  // still collects the rest. Nothing of the host process's environment.
  const settingsEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of [
    ['KB_REPO_URL', record.kbRepoUrl],
    ['GIT_TOKEN', record.gitToken],
    ['GIT_USERNAME', record.gitUsername],
    ['KB_DIR_NAME', record.kbDirName],
    ['DEFAULT_BRANCH', record.defaultBranch],
    ['PROTECTED_BRANCHES', protectedBranches],
    ['KB_SYNC_SECRET', record.kbSyncSecret],
    ['OIDC_ISSUER_URL', record.oidc?.issuerUrl],
    ['OIDC_CLIENT_ID', record.oidc?.clientId],
    ['OIDC_CLIENT_SECRET', record.oidc?.clientSecret],
    ['OIDC_SCOPES', record.oidc?.scopes],
    ['OIDC_PROVIDER_LABEL', record.oidc?.providerLabel],
    ['ALLOWED_EMAIL_DOMAINS', allowedEmailDomains.join(',')],
  ] as const) {
    const trimmed = (value ?? '').trim();
    if (trimmed) settingsEnv[name] = trimmed;
  }
  return {
    port: settings.port,
    databaseUrl: settings.databaseUrl,
    dbSchema,
    nodeEnv: settings.nodeEnv,
    tenantId,
    externalApiKeyPrefix: `${tenantId}_`,
    internalTokenPrefix: `${tenantId}-int_`,
    uploadTokenPrefix: `${tenantId}-up_`,
    mcpOAuthTokenPrefix: `${tenantId}-mcp_`,
    workspacesRoot: path.resolve(settings.workspacesRoot, slug),
    backupsRoot: besideWorkspaces('backups'),
    spillRoot: besideWorkspaces('tool-chain-spills'),
    docExtractCacheRoot: besideWorkspaces('doc-extract-cache'),
    jwtSecret: secrets.jwtSecret,
    secretsEncKey: secrets.secretsEncKey,
    internalTokenSecret: secrets.internalTokenSecret,
    adminEmail,
    adminPassword,
    loginPasswordEnabled,
    oidcIssuerUrl: (record.oidc?.issuerUrl ?? '').trim().replace(/\/+$/, ''),
    oidcClientId: (record.oidc?.clientId ?? '').trim(),
    oidcClientSecret: (record.oidc?.clientSecret ?? '').trim(),
    oidcScopes: (record.oidc?.scopes ?? 'openid profile email').trim(),
    oidcProviderLabel: (record.oidc?.providerLabel ?? 'Single sign-on').trim(),
    kbRepoUrl: (record.kbRepoUrl ?? '').trim(),
    kbDirName: (record.kbDirName ?? '').trim(),
    gitUsername,
    gitToken: (record.gitToken ?? '').trim(),
    kbTemplateDir: settings.kbTemplateDir,
    ontologySessionBlock: settings.ontologySessionBlock,
    updateCheckEnabled: settings.updateCheckEnabled,
    allowedEmailDomains,
    trustProxy: settings.trustProxy,
    gitTimeoutMs: settings.gitTimeoutMs,
    publicBackendUrl,
    publicFrontendUrl,
    configuredPublicFrontendUrl: publicFrontendUrl,
    loopbackBaseUrl: loopbackTenantBaseUrl(settings.port, slug),
    settingsEnv,
  };
}

/**
 * The reference {@link TenantSource}: every tenant known up front, from a
 * JSON file (`TENANTS_FILE`). Enough for development, tests and a small
 * self-hosted fleet; the cloud app brings its own source over its registry.
 */
export class StaticTenantSource implements TenantSource {
  private readonly bySlug = new Map<string, TenantDescriptor>();
  private readonly byHost = new Map<string, TenantDescriptor>();

  constructor(records: readonly TenantRecord[], settings: TenantHostSettings) {
    for (const record of records) {
      const config = tenantConfigFrom(record, settings);
      const descriptor: TenantDescriptor = {
        slug: record.slug,
        hosts: record.hosts.map(normalizeHost),
        config,
      };
      if (this.bySlug.has(descriptor.slug)) throw new Error(`Tenant "${descriptor.slug}" is listed twice`);
      this.bySlug.set(descriptor.slug, descriptor);
      for (const host of descriptor.hosts) {
        const taken = this.byHost.get(host);
        if (taken) throw new Error(`Host "${host}" is claimed by both "${taken.slug}" and "${descriptor.slug}"`);
        this.byHost.set(host, descriptor);
      }
    }
  }

  static async fromFile(file: string, settings: TenantHostSettings): Promise<StaticTenantSource> {
    const text = await fs.readFile(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tenants = (parsed as Partial<TenantsFile> | null)?.tenants;
    if (!Array.isArray(tenants)) throw new Error(`${file} must be an object with a "tenants" array`);
    return new StaticTenantSource(tenants as TenantRecord[], settings);
  }

  get slugs(): readonly string[] {
    return [...this.bySlug.keys()];
  }

  async resolveByHost(host: string): Promise<TenantDescriptor | null> {
    return this.byHost.get(normalizeHost(host)) ?? null;
  }

  async describe(slug: string): Promise<TenantDescriptor | null> {
    return this.bySlug.get(slug) ?? null;
  }
}

/** The process facts a tenant host reads from its environment — see `docs/multi-tenant.md`. */
export interface TenantHostEnv extends TenantHostSettings {
  /** The tenants file, when the process runs as a host at all. */
  readonly tenantsFile: string | null;
  /** Minutes without a request after which a tenant's graph is stopped. */
  readonly idleMinutes: number;
}

const MAX_TIMER_MS = 2_147_483_647;

/**
 * The host's settings from the environment: the same variables a
 * single-tenant deployment reads for these facts (`DATABASE_URL` and the
 * `POSTGRES_*` parts, `PORT`, `TRUST_PROXY`, `WORKSPACES_ROOT`,
 * `KB_TEMPLATE_DIR`, `GIT_TIMEOUT_MS`, …), plus the three that only a host
 * has: `TENANTS_FILE`, `TENANT_MASTER_KEY` and `TENANT_IDLE_MINUTES`.
 */
export function tenantHostEnv(env: NodeJS.ProcessEnv = process.env): TenantHostEnv {
  const tenantsFile = (env.TENANTS_FILE || '').trim() || null;
  const masterKey = (env.TENANT_MASTER_KEY || '').trim();
  if (tenantsFile && !masterKey) {
    throw new Error(
      'TENANT_MASTER_KEY is required with TENANTS_FILE — every tenant\'s secrets derive from it. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  const gitTimeout = Number(env.GIT_TIMEOUT_MS);
  const idle = Number(env.TENANT_IDLE_MINUTES);
  const domain = (env.DOMAIN || '').trim();
  const workspacesRoot = env.WORKSPACES_ROOT || path.resolve(process.cwd(), 'workspaces');
  return {
    tenantsFile,
    masterKey,
    databaseUrl: resolveDatabaseUrl(env),
    port: parseInt(env.PORT || '3001', 10),
    nodeEnv: env.NODE_ENV || 'development',
    trustProxy: (env.TRUST_PROXY || (domain ? '1' : '')).trim(),
    workspacesRoot,
    kbTemplateDir: env.KB_TEMPLATE_DIR || defaultKbTemplateDir(),
    gitTimeoutMs:
      Number.isFinite(gitTimeout) && gitTimeout > 0 && gitTimeout <= MAX_TIMER_MS ? gitTimeout : DEFAULT_GIT_TIMEOUT_MS,
    ontologySessionBlock: (env.ONTOLOGY_SESSION_BLOCK ?? 'true').trim().toLowerCase() !== 'false',
    updateCheckEnabled: (env.UPDATE_CHECK ?? 'true').trim().toLowerCase() !== 'false',
    idleMinutes: Number.isFinite(idle) && idle > 0 ? idle : 30,
  };
}
