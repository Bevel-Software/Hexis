import { type VariableLoader, VariableLoaderSerializer, Serializer } from '@utcp/sdk';
import { logger } from '../../shared/logging.js';
import type { ISecretsVaultService } from './secrets-vault.contract.js';

const log = logger('secrets-vault');

/**
 * The `bevel-secrets` UTCP variable loader — the swappable seam that lets any
 * UTCP client resolve `${VAR}` placeholders from the Secrets Vault at tool-call
 * time (lazily, so OAuth tokens are refreshed on demand).
 *
 * UTCP resolves a variable in three tiers (see `DefaultVariableSubstitutor`):
 * `config.variables` (exact) → each `config.load_variables_from` loader's
 * async `get()` → `process.env`. We seed a per-user loader instance here so any
 * tool var not already in `config.variables` (the reserved `API_URL` /
 * `CONNECTION_KEY`) is resolved from this user's secrets.
 *
 * The `UtcpClient.create` path re-validates the whole config through the
 * serializer registry, so a loader can't be handed in as a bare live object — it
 * must round-trip through a registered serializer. We therefore put a plain
 * descriptor `{ variable_loader_type, user_id, scope }` in `load_variables_from`
 * (via {@link bevelSecretsLoaderConfig}) and let the registered serializer
 * rebuild a live loader bound to the vault registered under that scope.
 *
 * ONE VAULT PER SCOPE, NOT PER PROCESS. The serializer registry is UTCP's and
 * process-wide, but a process can host several knowledge bases, each with a
 * vault of its own, and a user id is only unique within one of them. So the
 * descriptor names the scope its vault was registered under, and a loader
 * reads through that vault alone: two knowledge bases whose users both stored
 * `weather_WEATHER_KEY` never see each other's value. A single-tenant
 * deployment registers under {@link DEFAULT_SECRETS_SCOPE} and names nothing.
 * Swapping the vault backend (e.g. to a client's external secret manager) is
 * just a different `ISecretsVaultService` passed to
 * {@link registerBevelSecretsVariableLoader}.
 */
export const BEVEL_SECRETS_LOADER_TYPE = 'bevel_secrets';

/** The scope a deployment that hosts one knowledge base registers under. */
export const DEFAULT_SECRETS_SCOPE = 'default';

/**
 * The vaults the reconstructed loaders read through, by scope. A composition
 * root registers its vault before any client is built; a graph that is torn
 * down unregisters it so a stale descriptor resolves nothing.
 */
const vaults = new Map<string, ISecretsVaultService>();

export class BevelSecretsVariableLoader implements VariableLoader {
  readonly variable_loader_type = BEVEL_SECRETS_LOADER_TYPE;
  readonly user_id: string;
  readonly scope: string;
  // VariableLoader is an open shape; allow arbitrary extra props.
  [key: string]: unknown;

  constructor(userId: string, scope: string = DEFAULT_SECRETS_SCOPE) {
    this.user_id = userId;
    this.scope = scope;
  }

  /**
   * Resolve `effectiveKey` — the UTCP-namespaced `<manual>_<VAR>` — against the
   * vault VERBATIM. Preserving the manual prefix binds a secret to exactly ONE
   * manual: another manual referencing the same bare `${VAR}` forms a different
   * key and misses. This is the per-manual isolation UTCP's namespacing gives us
   * — we intentionally do NOT strip the prefix, so a malicious `.tool` can't
   * harvest a secret the user configured for a different manual.
   */
  async get(effectiveKey: string): Promise<string | null> {
    const vault = vaults.get(this.scope);
    if (!vault || !this.user_id) return null;
    try {
      return await vault.resolve(this.user_id, effectiveKey);
    } catch (err) {
      // Log the fault so a backend failure is distinguishable from a merely
      // unset secret (resolve returning null) when troubleshooting.
      log.error(`resolve failed for user=${this.user_id} key=${effectiveKey}:`, { err });
      return null;
    }
  }
}

class BevelSecretsVariableLoaderSerializer extends Serializer<VariableLoader> {
  toDict(obj: VariableLoader): Record<string, unknown> {
    const loader = obj as BevelSecretsVariableLoader;
    return {
      variable_loader_type: BEVEL_SECRETS_LOADER_TYPE,
      user_id: loader.user_id ?? '',
      scope: loader.scope ?? DEFAULT_SECRETS_SCOPE,
    };
  }

  validateDict(obj: Record<string, unknown>): VariableLoader {
    const userId = typeof obj.user_id === 'string' ? obj.user_id : '';
    const scope = typeof obj.scope === 'string' && obj.scope ? obj.scope : DEFAULT_SECRETS_SCOPE;
    return new BevelSecretsVariableLoader(userId, scope);
  }
}

// Register the serializer on module load so a `{ variable_loader_type:
// 'bevel_secrets' }` descriptor round-trips through `UtcpClient.create` as soon
// as this module is imported — independent of whether a vault has been bound
// yet. Until `registerBevelSecretsVariableLoader` binds a vault, loaders simply
// resolve to null (no secrets available), so `create` never throws for lack of
// registration. Idempotent (safe under tsx hot-reload).
VariableLoaderSerializer.registerVariableLoader(
  BEVEL_SECRETS_LOADER_TYPE,
  new BevelSecretsVariableLoaderSerializer(),
  true,
);

/**
 * Bind the vault the loaders of `scope` read through. Called once per
 * knowledge base at composition time; before it runs, loaders of that scope
 * resolve to null.
 */
export function registerBevelSecretsVariableLoader(
  secretsVault: ISecretsVaultService,
  scope: string = DEFAULT_SECRETS_SCOPE,
): void {
  vaults.set(scope, secretsVault);
}

/** Forget a scope's vault — the last step of tearing a knowledge base's graph down. */
export function unregisterBevelSecretsVariableLoader(scope: string = DEFAULT_SECRETS_SCOPE): void {
  vaults.delete(scope);
}

/**
 * The plain descriptor to place in a `UtcpClientConfig.load_variables_from`
 * for a given user of the knowledge base registered under `scope`.
 */
export function bevelSecretsLoaderConfig(userId: string, scope: string = DEFAULT_SECRETS_SCOPE): Record<string, unknown> {
  return { variable_loader_type: BEVEL_SECRETS_LOADER_TYPE, user_id: userId, scope };
}
