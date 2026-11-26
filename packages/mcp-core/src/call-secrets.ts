import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeModeUtcpClient } from '@utcp/code-mode';

/*
 * The values substituted into a manual's calls, so that whatever quotes a
 * downstream answer back can take them out of it (`downstream-tool-errors.ts`):
 * a server that echoes what it was sent must not hand a secret to the caller.
 *
 * Recorded where they are resolved, value by value, rather than read back out
 * of the filled-in text: a value can contain the literal text around it, and
 * no reading of the text alone tells every value apart. And recorded at
 * REGISTRATION: the SDK fills an `mcp` manual's `${VAR}`s in once, when it
 * registers the manual, and stores that filled-in template for its tools, so a
 * call resolves nothing of its own. A session recovery or a refreshed token
 * registers again, and its values replace the old ones.
 */

/** The values resolved while one registration runs; one store per registration, so concurrent ones stay apart. */
const resolving = new AsyncLocalStorage<Set<string>>();

/** Set on a client once its substitutor records (on the client, which nothing else wraps). */
const RECORDING = Symbol.for('bevel.mcp-core.substitutionCapture');
/** On a client: registered manual name to the values its registration resolved. */
const BY_MANUAL = Symbol.for('bevel.mcp-core.manualSecrets');

type Resolve = (this: unknown, key: string, config: unknown, namespace?: string) => Promise<unknown>;
type Marked = Record<symbol, unknown>;

/**
 * Make `client`'s substitutor record what it resolves while a
 * {@link recordingSubstitutions} store is active. The SDK's
 * `DefaultVariableSubstitutor` resolves each reference through
 * `_getVariable`, private in its types; it is wrapped on the client's own
 * substitutor, and `call-secrets.test` fails if a release renames it.
 * Idempotent per client.
 */
export function installSubstitutionCapture(client: CodeModeUtcpClient): void {
  const marked = client as unknown as Marked;
  if (marked[RECORDING] === true) return;
  marked[RECORDING] = true;
  const substitutor = (client as unknown as { variableSubstitutor?: { _getVariable?: Resolve } }).variableSubstitutor;
  const resolve = substitutor?._getVariable;
  if (!substitutor || typeof resolve !== 'function') {
    console.warn('[mcp] the UTCP substitutor has no _getVariable: substituted values are not redacted from downstream errors.');
    return;
  }
  substitutor._getVariable = async function (this: unknown, key, config, namespace) {
    const value = await resolve.call(this, key, config, namespace);
    if (typeof value === 'string') resolving.getStore()?.add(value);
    return value;
  };
}

/** Run `register` in a store of its own; answer what it returned and every value resolved meanwhile. */
export async function recordingSubstitutions<T>(register: () => Promise<T>): Promise<[T, Set<string>]> {
  const values = new Set<string>();
  return [await resolving.run(values, register), values];
}

/** Keep `values` as what the registration of `manualName` (its registered name) put into its calls. */
export function rememberManualSecrets(client: object, manualName: string, values: ReadonlySet<string>): void {
  const marked = client as Marked;
  const byManual = (marked[BY_MANUAL] ??= new Map<string, ReadonlySet<string>>()) as Map<string, ReadonlySet<string>>;
  byManual.set(manualName, values);
}

/** What the registration of `manualName` put into its calls on `client`; empty when nothing was recorded. */
export function manualSecrets(client: unknown, manualName: string): ReadonlySet<string> {
  const byManual = (client as Marked | undefined)?.[BY_MANUAL] as Map<string, ReadonlySet<string>> | undefined;
  return byManual?.get(manualName) ?? new Set<string>();
}
