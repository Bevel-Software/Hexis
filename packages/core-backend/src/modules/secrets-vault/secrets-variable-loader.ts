import { type VariableLoader, VariableLoaderSerializer, Serializer } from '@utcp/sdk';
import type { ISecretsVaultService } from './secrets-vault.contract.js';

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
 * descriptor `{ variable_loader_type, user_id }` in `load_variables_from` (via
 * {@link bevelSecretsLoaderConfig}) and let the registered serializer rebuild a
 * live loader bound to the process-wide vault. Swapping the vault backend (e.g.
 * to a client's external secret manager) is just a different
 * `ISecretsVaultService` passed to {@link registerBevelSecretsVariableLoader}.
 */
export const BEVEL_SECRETS_LOADER_TYPE = 'bevel_secrets';

/**
 * Process-wide vault the reconstructed loaders read through. Set once at
 * composition time (before any client is built) so the serializer — which only
 * receives a plain dict — can bind live loaders to it.
 */
let sharedSecretsVault: ISecretsVaultService | null = null;

export class BevelSecretsVariableLoader implements VariableLoader {
  readonly variable_loader_type = BEVEL_SECRETS_LOADER_TYPE;
  readonly user_id: string;
  // VariableLoader is an open shape; allow arbitrary extra props.
  [key: string]: unknown;

  constructor(userId: string) {
    this.user_id = userId;
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
    if (!sharedSecretsVault || !this.user_id) return null;
    try {
      return await sharedSecretsVault.resolve(this.user_id, effectiveKey);
    } catch (err) {
      // Log the fault so a backend failure is distinguishable from a merely
      // unset secret (resolve returning null) when troubleshooting.
      console.error(
        `[secrets-vault] resolve failed for user=${this.user_id} key=${effectiveKey}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}

class BevelSecretsVariableLoaderSerializer extends Serializer<VariableLoader> {
  toDict(obj: VariableLoader): Record<string, unknown> {
    return {
      variable_loader_type: BEVEL_SECRETS_LOADER_TYPE,
      user_id: (obj as BevelSecretsVariableLoader).user_id ?? '',
    };
  }

  validateDict(obj: Record<string, unknown>): VariableLoader {
    const userId = typeof obj.user_id === 'string' ? obj.user_id : '';
    return new BevelSecretsVariableLoader(userId);
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
 * Bind the process-wide vault the reconstructed loaders read through. Called
 * once at composition time; before it runs, loaders resolve to null.
 */
export function registerBevelSecretsVariableLoader(secretsVault: ISecretsVaultService): void {
  sharedSecretsVault = secretsVault;
}

/** The plain descriptor to place in a `UtcpClientConfig.load_variables_from` for a given user. */
export function bevelSecretsLoaderConfig(userId: string): Record<string, unknown> {
  return { variable_loader_type: BEVEL_SECRETS_LOADER_TYPE, user_id: userId };
}
