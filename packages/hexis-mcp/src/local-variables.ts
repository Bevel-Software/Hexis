import { type VariableLoader, VariableLoaderSerializer, Serializer } from '@utcp/sdk';
import { utcpNamespacePrefix } from '@bevel-software/platform-mcp-core';
import type { HexisMcpConfig } from './config.js';
import { fetchLocalToolVariables, type LocalManualInfo } from './deployment.js';

/**
 * Resolving a LOCAL tool's `${VAR}`s from the deployment's Secrets Vault.
 *
 * A local-only `.tool` executes here, on the user's machine, so its credentials
 * have to be here too. Until now they could only come from `process.env` — the
 * MCP client config that launched this process — which meant every person
 * running a local tool hand-placed its credentials on their own laptop, and a
 * rotation had to be repeated everywhere.
 *
 * This closes that gap without widening what a caller can ask for. The request
 * names a MANUAL, never a variable; the deployment re-reads the `.tool` file
 * and resolves exactly what it declares, so the knowledge base is the allowlist
 * and this process cannot extend it. What comes back is bound to that manual's
 * UTCP namespace, which is what keeps one local tool from resolving another's
 * secret — the same per-manual isolation the hosted client relies on.
 *
 * Two limits are deliberate:
 *
 * - **Local manuals only.** A remote manual's tools still execute on the
 *   deployment and resolve their credentials there; asking for them here would
 *   move a secret onto a laptop for no benefit at all.
 * - **Values are never returned to a caller.** They are expanded into a tool
 *   invocation by UTCP's substitutor and go no further. An agent talking to
 *   this server calls `git.push(...)`; it never sees the token that made the
 *   push work.
 *
 * `process.env` remains the last tier underneath this one, so an existing
 * setup that provisions a local tool from the client config keeps working —
 * the vault answer simply arrives first when there is one.
 */

export const HEXIS_LOCAL_LOADER_TYPE = 'hexis_local_tool_variables';

/**
 * How long one manual's resolved variables are held before the deployment is
 * asked again. A tool call must not pay an HTTP round-trip for every `${VAR}`
 * substitution, and a rotated secret must not stay wrong forever; a few minutes
 * is the compromise. Nothing here is persisted — the cache dies with the
 * process.
 */
const CACHE_TTL_MS = 5 * 60_000;

interface ResolverState {
  config: HexisMcpConfig;
  /** UTCP manual name → how the deployment addresses it. Local manuals only. */
  local: ReadonlyMap<string, LocalManualInfo>;
  cache: Map<string, { at: number; values: Record<string, string> }>;
  inFlight: Map<string, Promise<Record<string, string>>>;
  now: () => number;
}

/**
 * Process-wide, for the same reason the platform's vault loader is: a loader is
 * rebuilt from a plain descriptor by the serializer registry, which has nothing
 * to bind it to. Set once, before any client is created.
 */
let state: ResolverState | null = null;

/**
 * Point the loader at a deployment and the set of manuals that resolve through
 * it. Call before building the UTCP client; calling again replaces the binding
 * (and drops the cache, which is what a re-registration after a credential
 * renewal wants).
 */
export function bindLocalVariableResolver(
  config: HexisMcpConfig,
  local: ReadonlyMap<string, LocalManualInfo>,
  now: () => number = Date.now,
): void {
  state = { config, local, cache: new Map(), inFlight: new Map(), now };
}

/** Drop every cached value — used by tests and by a re-bind. */
export function resetLocalVariableResolver(): void {
  state = null;
}

/**
 * Which local manual, if any, owns this UTCP-namespaced key.
 *
 * Matched on the LONGEST prefix so a manual `a` cannot shadow `a_b` when both
 * exist — the same rule the platform's scope resolver uses, and for the same
 * reason: a first-underscore split mis-parses every snake_case manual name.
 */
function ownerOf(
  effectiveKey: string,
  local: ReadonlyMap<string, LocalManualInfo>,
): { manual: string; info: LocalManualInfo; varName: string } | null {
  let best: { manual: string; info: LocalManualInfo; varName: string; len: number } | null = null;
  for (const [manual, info] of local) {
    const prefix = utcpNamespacePrefix(manual);
    if (effectiveKey.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { manual, info, varName: effectiveKey.slice(prefix.length), len: prefix.length };
    }
  }
  return best ? { manual: best.manual, info: best.info, varName: best.varName } : null;
}

/** One manual's variables, cached, with concurrent asks sharing a single fetch. */
async function variablesFor(s: ResolverState, manual: string, info: LocalManualInfo): Promise<Record<string, string>> {
  const cached = s.cache.get(manual);
  if (cached && s.now() - cached.at < CACHE_TTL_MS) return cached.values;

  // A tool call substitutes several variables at once; without this every one
  // of them would open its own request for the same manual.
  const pending = s.inFlight.get(manual);
  if (pending) return pending;

  const request = fetchLocalToolVariables(s.config, info.slug)
    .then((values) => {
      s.cache.set(manual, { at: s.now(), values });
      return values;
    })
    .finally(() => s.inFlight.delete(manual));
  s.inFlight.set(manual, request);
  return request;
}

export class HexisLocalVariableLoader implements VariableLoader {
  readonly variable_loader_type = HEXIS_LOCAL_LOADER_TYPE;
  // VariableLoader is an open shape; allow arbitrary extra props.
  [key: string]: unknown;

  /**
   * Resolve one UTCP-namespaced key, or null to fall through to `process.env`.
   *
   * Null is returned for anything that is not a local manual's variable —
   * including every remote-manual key — so this loader can never become a path
   * by which a server-side credential is pulled onto the machine.
   */
  async get(effectiveKey: string): Promise<string | null> {
    if (!state) return null;
    const owner = ownerOf(effectiveKey, state.local);
    if (!owner) return null;
    try {
      const values = await variablesFor(state, owner.manual, owner.info);
      return values[owner.varName] ?? null;
    } catch {
      // `fetchLocalToolVariables` already logs; an unresolved variable falls
      // through to `process.env` rather than failing the call outright.
      return null;
    }
  }
}

class HexisLocalVariableLoaderSerializer extends Serializer<VariableLoader> {
  toDict(): Record<string, unknown> {
    return { variable_loader_type: HEXIS_LOCAL_LOADER_TYPE };
  }

  validateDict(): VariableLoader {
    return new HexisLocalVariableLoader();
  }
}

/**
 * Register the loader type. `UtcpClient.create` re-validates its whole config
 * through the serializer registry, so a live loader object cannot be handed in
 * directly — it has to be rebuilt from a plain descriptor.
 */
export function registerLocalVariableLoader(): void {
  VariableLoaderSerializer.registerVariableLoader(
    HEXIS_LOCAL_LOADER_TYPE,
    new HexisLocalVariableLoaderSerializer(),
    true,
  );
}

/** The descriptor to put in a client config's `load_variables_from`. */
export function localVariableLoaderConfig(): Record<string, unknown> {
  return { variable_loader_type: HEXIS_LOCAL_LOADER_TYPE };
}
