import { type VariableLoader, VariableLoaderSerializer, Serializer } from '@utcp/sdk';
import { utcpNamespacePrefix } from '@bevel-software/platform-mcp-core';
import type { HexisMcpConfig } from './config.js';
import { fetchLocalToolVariables, type LocalManualInfo, type LocalToolVariables } from './deployment.js';

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
  inFlight: Map<string, Promise<LocalToolVariables>>;
  /**
   * Collisions this binding has already reported — a shared namespace, or a
   * nested manual pair. Per binding, not per process: a host that creates
   * servers over time would otherwise grow the set forever, and a second
   * server with the same collision would stay silent because the first had
   * already spoken.
   */
  reportedCollisions: Set<string>;
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
  bindings.set(id, { config, local, cache: new Map(), inFlight: new Map(), reportedCollisions: new Set(), now });
  return id;
}

/**
 * Release one binding, or every binding when called with no id.
 *
 * MUST be called when a server shuts down, and when its construction fails
 * partway. A binding holds a deployment's configuration and its cached secret
 * VALUES; a long-lived host that creates servers over time would otherwise
 * accumulate them for the life of the process with no way to reclaim them.
 */
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
/** A manual whose namespace prefixes the key, with the variable name that implies. */
interface Candidate {
  manual: string;
  info: LocalManualInfo;
  varName: string;
  prefixLength: number;
}

/**
 * Every local manual whose namespace prefixes this key, longest prefix first.
 *
 * More than one can match. Equal-length prefixes mean two names normalized to
 * one namespace (`a-b` and `a_b` both give `a__b_`). Nested prefixes mean one
 * name extends another (`github` gives `github_`, `github_enterprise` gives
 * `github__enterprise_`, and the first prefixes the second) — realistic, and
 * fine until the shorter manual references a variable whose name starts with
 * `_`, at which point both manuals imply the same key. UTCP asks this loader
 * for the KEY alone, never for which tool is asking, so where two manuals both
 * lay claim to one key there is nothing to disambiguate with.
 */
function candidatesFor(effectiveKey: string, local: ReadonlyMap<string, LocalManualInfo>): Candidate[] {
  const out: Candidate[] = [];
  for (const [manual, info] of local) {
    const prefix = utcpNamespacePrefix(manual);
    if (effectiveKey.startsWith(prefix)) {
      out.push({ manual, info, varName: effectiveKey.slice(prefix.length), prefixLength: prefix.length });
    }
  }
  return out.sort((a, b) => b.prefixLength - a.prefixLength);
}

/**
 * Once per COLLISION, not once per lookup. A tool call substitutes several
 * variables at a time and every call repeats them; the thing an operator needs
 * to hear once is that two manuals collide, not each key that hit it.
 */
function reportOnce(state: ResolverState, collision: string, message: string): void {
  if (state.reportedCollisions.has(collision)) return;
  state.reportedCollisions.add(collision);
  console.error(`[hexis-mcp] ${message}`);
}

/** An OWN string property — never a prototype property like `constructor`. */
function ownString(values: Record<string, string>, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(values, name) && typeof values[name] === 'string' ? values[name] : null;
}

/**
 * Resolve one key against the local manuals, or null.
 *
 * Refuses whenever more than one manual could be the one asking:
 *
 * - Equal-length prefixes: two names, one namespace. Nothing distinguishes the
 *   tools, so neither resolves — regardless of what either has provisioned,
 *   because the tool that did NOT provision the name would otherwise receive
 *   the other's secret.
 * - Nested prefixes: the longer manual wins ONLY when the shorter one has not
 *   provisioned the overlapping name. If both have, both are laying claim to
 *   one key and neither resolves. The overlap itself is reported once either
 *   way, so an operator learns that `github` and `github_enterprise` can
 *   collide before a variable starting with `_` makes them.
 *
 * A candidate whose fetch failed is treated as unknown: with rivals present the
 * answer is null, because "the other manual did not claim it" cannot be known
 * from a blip, and guessing wrong hands out a secret.
 */
async function resolve(state: ResolverState, effectiveKey: string): Promise<string | null> {
  const candidates = candidatesFor(effectiveKey, state.local);
  if (candidates.length === 0) return null;

  const fetched = await Promise.all(
    candidates.map(async (c) => ({ c, ...(await variablesFor(state, c.manual, c.info)) })),
  );
  if (candidates.length > 1 && fetched.some((f) => !f.ok)) return null;

  const claims = fetched.filter((f) => ownString(f.values, f.c.varName) !== null);
  const longest = candidates[0].prefixLength;
  const equalLongest = candidates.filter((c) => c.prefixLength === longest);

  if (equalLongest.length > 1) {
    reportOnce(
      state,
      effectiveKey.slice(0, longest),
      `refusing to resolve the namespace "${effectiveKey.slice(0, longest)}": the manuals ${equalLongest.map((c) => `"${c.manual}"`).join(' and ')} ` +
        'share one variable namespace. Rename one — until then neither resolves.',
    );
    return null;
  }

  if (candidates.length > 1) {
    const names = candidates.map((c) => `"${c.manual}"`).join(' and ');
    const pair = candidates.map((c) => c.manual).join('|');
    if (claims.length > 1) {
      reportOnce(
        state,
        `${pair}|${effectiveKey}`,
        `refusing to resolve "${effectiveKey}": the manuals ${names} both provision it (one manual's namespace ` +
          'prefixes the other, and a variable name starting with `_` makes them collide). Rename one.',
      );
      return null;
    }
    reportOnce(
      state,
      pair,
      `the manuals ${names} have nested variable namespaces; keys like "${effectiveKey}" resolve to the longer one. ` +
        'A variable of the shorter manual whose name starts with `_` would collide — avoid such names.',
    );
  }

  return claims.length === 1 ? ownString(claims[0].values, claims[0].c.varName) : null;
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
async function variablesFor(s: ResolverState, manual: string, info: LocalManualInfo): Promise<LocalToolVariables> {
  const cached = s.cache.get(manual);
  if (cached && s.now() - cached.at < CACHE_TTL_MS) return { ok: true, values: cached.values };

  // A tool call substitutes several variables at once; without this every one
  // of them would open its own request for the same manual.
  const pending = s.inFlight.get(manual);
  if (pending) return pending;

  const request = fetchLocalToolVariables(s.config, info.slug)
    .then((result) => {
      if (result.ok) s.cache.set(manual, { at: s.now(), values: result.values });
      return result;
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
    try {
      return await resolve(state, effectiveKey);
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
  // Once. The registry is process-global while clients are per server, and
  // this module explicitly supports several servers in one process; the live
  // per-server state is isolated through `binding_id`, so re-registering the
  // TYPE per client does nothing but churn a global.
  if (loaderRegistered) return;
  VariableLoaderSerializer.registerVariableLoader(
    HEXIS_LOCAL_LOADER_TYPE,
    new HexisLocalVariableLoaderSerializer(),
    true,
  );
  loaderRegistered = true;
}

let loaderRegistered = false;

/** The descriptor to put in a client config's `load_variables_from`. */
export function localVariableLoaderConfig(bindingId: string): Record<string, unknown> {
  return { variable_loader_type: HEXIS_LOCAL_LOADER_TYPE, binding_id: bindingId };
}
