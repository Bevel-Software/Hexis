import type { TenantConfig } from '../core-config.js';
import type { CorePorts } from '../core/core-ports.js';
import type { ServerExtensions } from '../core/create-core-server.js';

/**
 * A tenant, as the host needs to know it: which host names reach it, what
 * its service graph is built from, and what a distribution adds to that
 * graph. One of these is one `createCoreServices` + `createCoreServer`, run
 * on demand and stopped again when idle — see `tenant-runtime.ts`.
 *
 * `ports` and `extensions` are per tenant on purpose: everything the
 * enterprise overlay does per deployment (its SSO plugin, session sink,
 * erasure participants, extra startup steps) it does per tenant here, through
 * the same two seams, with nothing below the front door knowing the
 * difference.
 */
export interface TenantDescriptor {
  /** The tenant's stable name: lowercase, `[a-z][a-z0-9-]*`, at most 40 characters. */
  readonly slug: string;
  /** Host names (no port) whose requests belong to this tenant, lowercase. */
  readonly hosts: readonly string[];
  readonly config: TenantConfig;
  readonly ports?: CorePorts;
  readonly extensions?: ServerExtensions;
}

/**
 * Where tenants come from. Core ships {@link StaticTenantSource}, which
 * reads a file, for development and tests; the cloud app implements this
 * over its own registry, where subdomains are provisioned and plans live.
 * A source answers `null` for a host or slug it does not know, and the host
 * turns that into a 404 without building anything.
 */
export interface TenantSource {
  resolveByHost(host: string): Promise<TenantDescriptor | null>;
  describe(slug: string): Promise<TenantDescriptor | null>;
}

/** What a slug may look like: it names a schema, a folder and a loopback path. */
export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function assertTenantSlug(slug: string): string {
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(`Tenant slug must match ${TENANT_SLUG_PATTERN} (lowercase, digits, hyphens); got "${slug}"`);
  }
  return slug;
}

/**
 * A host name the way the host compares it: lowercase, without a port or a
 * trailing dot. `Host` headers and `X-Forwarded-Host` values arrive in every
 * spelling a client or proxy chooses.
 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  // `[::1]:3001` keeps its brackets; `example.test:3001` loses its port.
  if (trimmed.startsWith('[')) return trimmed.replace(/\]:\d+$/, ']');
  return trimmed.replace(/:\d+$/, '');
}
