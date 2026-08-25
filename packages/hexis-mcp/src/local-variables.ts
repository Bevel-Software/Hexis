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
 * Bindings by id, NOT one process-wide binding.
 *
 * A loader is rebuilt from a plain descriptor by the serializer registry, which
 * has nothing to bind it to — so the descriptor carries an id and the live
 * state is looked up here. A single global would mean two servers in one
 * process (embedded callers, and the tests that build several) sharing one
 * deployment's configuration: the second `bind` would silently retarget the
 * first server's tools, and one deployment's manuals would resolve against the
 * other's vault.
 */
const bindings = new Map<string, ResolverState>();
let nextBindingId = 0;

/**
 * Point a loader at a deployment and the set of manuals that resolve through
 * it. Returns the id to put in the client config's loader descriptor.
 *
 * Call before building the UTCP client. Each call is a NEW binding with its own
 * cache; re-binding after a credential renewal therefore drops the old cached
 * values, which is what that case wants.
 */
export function bindLocalVariableResolver(
  config: HexisMcpConfig,
  local: ReadonlyMap<string, LocalManualInfo>,
  now: () => number = Date.now,
): string {
  const id = `binding-${nextBindingId++}`;
  bindings.set(id, { config, local, cache: new Map(), inFlight: new Map(), now });
  return id;
}

/** Release one binding, or every binding when called with no id. */
export function resetLocalVariableResolver(id?: string): void {
  if (id === undefined) bindings.clear();
  else bindings.delete(id);
}

/**
 * Which local manual, if any, owns this UTCP-namespaced key.
 *
 * Matched on the LONGEST prefix so a manual `a` cannot shadow `a_b` when both
 * exist — the same rule the platform's scope resolver uses, and for the same
 * reason: a first-underscore split mis-parses every snake_case manual name.
 *
 * AMBIGUITY RESOLVES TO NOTHING. Namespacing maps every non-word character to
 * `_` and then doubles it, so two different names can share one prefix (`a-b`
 * and `a_b` both give `a__b_`) — and with it, one set of vault keys.
 *
 * The deployment refuses such a pair at scan time, which is where it belongs.
 * This check is here because this process cannot verify that it did: the manual
 * list arrives over HTTP from a deployment whose version it does not control,
 * and one that predates that fix would serve a colliding pair happily. Getting
 * it wrong means handing one manual's secret to another, silently, so a tie
 * returns null and falls through to `process.env` instead.
 */
function ownerOf(
  effectiveKey: string,
  local: ReadonlyMap<string, LocalManualInfo>,
): { manual: string; info: LocalManualInfo; varName: string } | null {
  let best: { manual: string; info: LocalManualInfo; varName: string; len: number } | null = null;
  let ambiguous: string[] = [];
  for (const [manual, info] of local) {
    const prefix = utcpNamespacePrefix(manual);
    if (!effectiveKey.startsWith(prefix)) continue;
    if (!best || prefix.length > best.len) {
      best = { manual, info, varName: effectiveKey.slice(prefix.length), len: prefix.length };
      ambiguous = [manual];
    } else if (prefix.length === best.len) {
      ambiguous.push(manual);
    }
  }
  if (!best) return null;
  if (ambiguous.length > 1) {
    console.error(
      `[hexis-mcp] refusing to resolve "${effectiveKey}": the manuals ${ambiguous
        .map((m) => `"${m}"`)
        .join(' and ')} share one variable namespace. Rename one — until then neither resolves.`,
    );
    return null;
  }
  return { manual: best.manual, info: best.info, varName: best.varName };
}

/**
 * One manual's variables, cached, with concurrent asks sharing a single fetch.
 *
 * A FAILED resolution is never cached. `fetchLocalToolVariables` degrades to an
 * empty map on a network blip or a deployment that predates the route, and
 * caching that would disable the manual's credentials for the whole TTL — with
 * the tool silently running without them rather than retrying on the next
 * substitution. So only a successful fetch is stored; a failure is retried.
 */
async function variablesFor(s: ResolverState, manual: string, info: LocalManualInfo): Promise<Record<string, string>> {
  const cached = s.cache.get(manual);
  if (cached && s.now() - cached.at < CACHE_TTL_MS) return cached.values;

  // A tool call substitutes several variables at once; without this every one
  // of them would open its own request for the same manual.
  const pending = s.inFlight.get(manual);
  if (pending) return pending;

  const request = fetchLocalToolVariables(s.config, info.slug)
    .then((result) => {
      if (result.ok) s.cache.set(manual, { at: s.now(), values: result.values });
      return result.values;
    })
    .finally(() => s.inFlight.delete(manual));
  s.inFlight.set(manual, request);
  return request;
}

export class HexisLocalVariableLoader implements VariableLoader {
  readonly variable_loader_type = HEXIS_LOCAL_LOADER_TYPE;
  readonly binding_id: string;
  // VariableLoader is an open shape; allow arbitrary extra props.
  [key: string]: unknown;

  constructor(bindingId: string) {
    this.binding_id = bindingId;
  }

  /**
   * Resolve one UTCP-namespaced key, or null to fall through to `process.env`.
   *
   * Null is returned for anything that is not a local manual's variable —
   * including every remote-manual key — so this loader can never become a path
   * by which a server-side credential is pulled onto the machine.
   */
  async get(effectiveKey: string): Promise<string | null> {
    const state = bindings.get(this.binding_id);
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
  toDict(obj: VariableLoader): Record<string, unknown> {
    return {
      variable_loader_type: HEXIS_LOCAL_LOADER_TYPE,
      binding_id: (obj as HexisLocalVariableLoader).binding_id ?? '',
    };
  }

  validateDict(obj: Record<string, unknown>): VariableLoader {
    return new HexisLocalVariableLoader(typeof obj.binding_id === 'string' ? obj.binding_id : '');
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
export function localVariableLoaderConfig(bindingId: string): Record<string, unknown> {
  return { variable_loader_type: HEXIS_LOCAL_LOADER_TYPE, binding_id: bindingId };
}
