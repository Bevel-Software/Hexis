import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { CallTemplate } from '@utcp/sdk';
import { SecretRedactor, rememberCallCredentials } from './secret-redactor.js';

/*
 * The values substituted into a manual's calls, so that whatever quotes a
 * downstream answer back can take them out of it (`downstream-tool-errors.ts`):
 * a server that echoes what it was sent must not hand a secret to the caller.
 *
 * Recorded where they are resolved, value by value, rather than read back out
 * of the filled-in text: a value can contain the literal text around it, and
 * no reading of the text alone tells every value apart. And recorded at
 * REGISTRATION: the SDK fills an `mcp` manual's `${VAR}`s in when it registers
 * the manual, and stores that filled-in template for its tools. A call runs
 * the substitutor over the stored template again, and it finds nothing to
 * resolve there unless a value itself reads as a reference, which
 * {@link valuesReadOnEveryCall} catches at registration. A session recovery or
 * a refreshed token registers again, and its values replace the old ones.
 */

/** Each variable's name and every value it resolved to while one registration ran. */
export type Substitutions = ReadonlyMap<string, ReadonlySet<string>>;

/** What one registration resolves while it runs; one store per registration, so concurrent ones stay apart. */
const resolving = new AsyncLocalStorage<Map<string, Set<string>>>();

/** Set on a client once its substitutor records (on the client, which nothing else wraps). */
const RECORDING = Symbol.for('bevel.mcp-core.substitutionCapture');
/** On a client: registered manual name to what its registration resolved. */
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
    // By name, since whether a value is a credential can depend on it; every
    // value, since a vault read again mid-registration can answer a new one.
    const store = resolving.getStore();
    if (store && typeof value === 'string') store.set(key, (store.get(key) ?? new Set<string>()).add(value));
    return value;
  };
}

/** Run `register` with everything it resolves recorded into `resolved`, which keeps it even when `register` throws. */
export function recordingSubstitutions<T>(resolved: Map<string, Set<string>>, register: () => Promise<T>): Promise<T> {
  return resolving.run(resolved, register);
}

/** Keep `resolved` as what the registration of `manualName` (its registered name) put into its calls. */
export function rememberManualSecrets(client: object, manualName: string, resolved: Substitutions): void {
  const marked = client as Marked;
  const byManual = (marked[BY_MANUAL] ??= new Map<string, Substitutions>()) as Map<string, Substitutions>;
  byManual.set(manualName, resolved);
}

/** What the registration of `manualName` put into its calls on `client`; empty when nothing was recorded. */
export function manualSecrets(client: unknown, manualName: string): Substitutions {
  const byManual = (client as Marked | undefined)?.[BY_MANUAL] as Map<string, Substitutions> | undefined;
  return byManual?.get(manualName) ?? new Map<string, ReadonlySet<string>>();
}

/**
 * A redactor holding every secret a call through `template` carries: the
 * values substituted into it and the credentials it spells out. In a
 * filled-in template the credentials include whatever was substituted into a
 * credential-named field; for an unfilled one (registration's), name those
 * fields' variables in `credentialNames` ({@link credentialVariables}).
 */
export function callRedactor(
  resolved: Substitutions,
  template: CallTemplate,
  credentialNames: ReadonlySet<string> = new Set(),
): SecretRedactor {
  const redactor = new SecretRedactor();
  for (const [name, values] of resolved) {
    for (const value of values) {
      if (credentialNames.has(name)) redactor.remember(value);
      else redactor.rememberSubstituted(name, value);
    }
  }
  rememberCallCredentials(redactor, template);
  return redactor;
}

/**
 * The variables an unfilled `template` sends in a credential-named field (a
 * header, query parameter, environment variable or auth field), read with the
 * client's own substitutor: their values are credentials wherever they appear.
 */
export function credentialVariables(client: CodeModeUtcpClient, template: CallTemplate): Set<string> {
  const fields: string[] = [];
  rememberCallCredentials({ remember: (text) => fields.push(text) }, template);
  return new Set(fields.flatMap((text) => client.variableSubstitutor.findRequiredVariables(text)));
}

/**
 * The variables of `resolved` whose value the client will read as another
 * reference (`$NAME`, `${NAME}`) every time a tool of manual `manualName` is
 * called, because the value went into a template the client stores filled in.
 * Such a call reads a different variable than the one meant, or fails naming
 * part of the value. Asked of the client's own substitutor over the tools'
 * stored templates, as those calls run it.
 */
export async function valuesReadOnEveryCall(
  client: CodeModeUtcpClient,
  manualName: string,
  resolved: Substitutions,
): Promise<string[]> {
  // Only a value that reads as a reference can be read again: most
  // registrations have none, and need not look at the stored tools at all.
  const suspects = [...resolved].flatMap(([name, values]) => {
    const refs = [...values].flatMap((value) => client.variableSubstitutor.findRequiredVariables(value, manualName));
    return refs.length > 0 ? [{ name, refs }] : [];
  });
  if (suspects.length === 0) return [];
  const tools = (await client.config.tool_repository.getToolsByManual(manualName)) ?? [];
  const stillReferenced = new Set(
    tools.flatMap((tool) => client.variableSubstitutor.findRequiredVariables(tool.tool_call_template, manualName)),
  );
  return suspects.filter(({ refs }) => refs.some((ref) => stillReferenced.has(ref))).map(({ name }) => name);
}
