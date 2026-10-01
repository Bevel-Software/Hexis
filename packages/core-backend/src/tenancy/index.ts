/**
 * Serving several knowledge bases from one process — see
 * `docs/multi-tenant.md` and `openspec/changes/multi-tenant-runtime`.
 *
 * The contract (`TenantSource`) and the mechanism (runtime, host) are core's;
 * where tenants come from is the caller's. Core ships a file-based source.
 */
export {
  assertTenantSlug,
  normalizeHost,
  TENANT_SLUG_PATTERN,
  type TenantDescriptor,
  type TenantSource,
} from './tenant-source.contract.js';
export { deriveTenantSecrets, type TenantSecrets } from './tenant-secrets.js';
export {
  StaticTenantSource,
  tenantConfigFrom,
  tenantHostEnv,
  type TenantHostEnv,
  type TenantHostSettings,
  type TenantRecord,
  type TenantsFile,
} from './static-tenant-source.js';
export { TenantRuntime, type TenantGraph, type TenantRuntimeDeps, type TenantState } from './tenant-runtime.js';
export {
  createTenantHost,
  isLoopbackAddress,
  loopbackTenantBaseUrl,
  selectTenant,
  LOOPBACK_TENANT_PREFIX,
  type TenantHost,
  type TenantHostOptions,
  type TenantSelector,
} from './tenant-host.js';
