import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeModeUtcpClient } from '@utcp/code-mode';

/**
 * Redact, from a failing tool call's error, every value the UTCP client
 * substituted into that call's template — a vault secret in a URL's query,
 * a header, a body — so no surface quotes it back to the caller.
 *
 * The client substitutes a tool's `${NAME}`s just before its protocol runs,
 * and every check after that point (the URL scheme check, the upstream's own
 * answer, the transport) sees and may quote the substituted text. So the
 * values are not guessed from the error: they are RECORDED as the client
 * resolves them, into the scope of the call that resolved them, and each
 * occurrence in the error is replaced by the `${NAME}` it was written as.
 *
 * A scope nests: a call routed to a pooled client runs inside the outer call's
 * scope, and a value recorded in the inner one is recorded in every enclosing
 * one too, so whichever guard sees the error last can still redact it.
 */

interface SubstitutionScope {
  /** Substituted value → the variable name it was written as. */
  readonly values: Map<string, string>;
  readonly parent: SubstitutionScope | undefined;
}

const scopes = new AsyncLocalStorage<SubstitutionScope>();

const RECORDING = Symbol.for('bevel.mcp-core.recordsSubstitutions');

/** Data that could not be serialised cannot be checked, so it is not served. */
const UNCHECKABLE_DATA = '[withheld: the tool failure carried data that could not be checked for secrets]';

/**
 * Make `client` record every value its substitutor resolves into the current
 * call's scope. Idempotent. A client that does not substitute templates (it
 * has no `substituteCallTemplateVariables`, as a test double may not) has
 * nothing to record.
 *
 * Throws when the client substitutes, but not through the substitutor this
 * was written against: tool errors would otherwise go out unredacted without
 * anyone noticing.
 */
export function recordSubstitutions(client: CodeModeUtcpClient): void {
  const subject = client as unknown as { substituteCallTemplateVariables?: unknown; variableSubstitutor?: unknown };
  if (typeof subject.substituteCallTemplateVariables !== 'function') return;
  const substitutor = subject.variableSubstitutor as Record<string | symbol, unknown> | null | undefined;
  if (substitutor?.[RECORDING] === true) return;
  const getVariable = substitutor?._getVariable;
  if (!substitutor || typeof getVariable !== 'function') {
    throw new Error(
      'The UTCP client substitutes templates without a `variableSubstitutor._getVariable` to record ' +
        'substituted values through, so tool errors could not be redacted. ' +
        'The @utcp/sdk version is not the one this platform supports.',
    );
  }
  substitutor._getVariable = async function recordingGetVariable(this: unknown, key: string, ...rest: unknown[]) {
    const value: unknown = await (getVariable as (...a: unknown[]) => Promise<unknown>).call(this, key, ...rest);
    if (typeof value === 'string') {
      for (let scope = scopes.getStore(); scope; scope = scope.parent) scope.values.set(value, key);
    }
    return value;
  };
  substitutor[RECORDING] = true;
}

/** A new scope for one call (or one registration), inside whatever scope is current. */
export function openSubstitutionScope(): SubstitutionScope {
  return { values: new Map(), parent: scopes.getStore() };
}

/** Run `fn` with `scope` as the current one: what the substitutor resolves meanwhile is recorded into it. */
export function inSubstitutionScope<T>(scope: SubstitutionScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/**
 * Run `fn` in `scope`, and redact the values substituted in `scope` from what
 * it rejects with: the one way a guarded call runs each of its steps.
 */
export async function runRedacted<T>(scope: SubstitutionScope, fn: () => Promise<T>): Promise<T> {
  try {
    return await inSubstitutionScope(scope, fn);
  } catch (err) {
    throw redactSubstitutedFailure(err, scope);
  }
}

/** `text` with every recorded value of `scope` replaced by the `${NAME}` it was written as. */
export function redactSubstitutedText(text: string, scope: SubstitutionScope): string {
  return redactorFor(scope)(text);
}

/**
 * The failure `err`, with the values substituted in `scope` redacted from
 * everything a surface reads out of it: its message and stack, the
 * upstream's answer (`data`, `response.data`, `statusText`) and its causes.
 *
 * In place, so the error keeps its class, status and cause chain — the token
 * refresh and session recovery decide on those. When a rewrite does not take
 * (a frozen error, a getter), a plain error carrying the redacted message and
 * status is returned instead: the secret never stays.
 */
export function redactSubstitutedFailure(err: unknown, scope: SubstitutionScope): unknown {
  if (scope.values.size === 0) return err;
  const redact = redactorFor(scope);
  if (typeof err === 'string') return redact(err);
  if (err === null || typeof err !== 'object') return err;
  if (rewrite(err, redact, new Set())) return err;
  const withheld = new Error(redact(messageOf(err))) as Error & { status?: unknown };
  const status = statusOf(err);
  if (status !== undefined) withheld.status = status;
  return withheld;
}

/**
 * One pass over the text replacing every spelling a recorded value can take
 * once quoted (raw, percent-encoded, form-encoded, JSON-escaped), longest
 * first at each position. One pass, so a marker already put in is never
 * searched again: a short value that occurs inside `${NAME}` cannot garble it.
 */
function redactorFor(scope: SubstitutionScope): (text: string) => string {
  const markers = new Map<string, string>();
  for (const [value, name] of scope.values) {
    // Every value is redacted, however short: length does not tell a secret
    // from a version. Only '' is skipped, since it cannot be quoted and
    // replacing it would mark every gap in the text.
    if (value.length === 0) continue;
    for (const form of spellings(value)) if (!markers.has(form)) markers.set(form, `\${${name}}`);
  }
  if (markers.size === 0) return (text) => text;
  const forms = [...markers.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (text) => text.replace(pattern, (form) => markers.get(form)!);
}

function spellings(value: string): string[] {
  const forms = [value, JSON.stringify(value).slice(1, -1), new URLSearchParams([['', value]]).toString().slice(1)];
  for (const encode of [encodeURIComponent, encodeURI]) {
    try {
      forms.push(encode(value));
    } catch {
      // A lone surrogate cannot be percent-encoded, so it cannot be quoted that way either.
    }
  }
  return [...new Set(forms)];
}

/** The fields of a failure that carry text a surface may serve. */
const TEXT_FIELDS = ['message', 'stack', 'statusText'] as const;
/** The fields that carry a nested failure or response, rewritten in turn. */
const NESTED_FIELDS = ['cause', 'response', 'errors'] as const;

/** Redact `target` in place; false when some rewrite did not take, so the caller must not serve it. */
function rewrite(target: object, redact: (text: string) => string, seen: Set<object>): boolean {
  if (seen.has(target)) return true;
  seen.add(target);
  const record = target as Record<string, unknown>;
  let took = true;
  for (const field of TEXT_FIELDS) {
    const value = read(record, field);
    if (typeof value === 'string') took = assign(record, field, redact(value), value) && took;
  }
  const data = read(record, 'data');
  if (data !== undefined) took = assign(record, 'data', redactData(data, redact), data) && took;
  for (const field of NESTED_FIELDS) {
    const nested = read(record, field);
    if (typeof nested === 'string') took = assign(record, field, redact(nested), nested) && took;
    else if (nested && typeof nested === 'object') {
      const items = Array.isArray(nested) ? nested : [nested];
      for (const item of items) if (item && typeof item === 'object') took = rewrite(item, redact, seen) && took;
      // A getter that hands out a fresh object each time was not rewritten by the above.
      took = read(record, field) === nested && took;
    }
  }
  return took;
}

/**
 * An upstream answer, redacted through its JSON text — the JSON-escaped
 * spelling of every value is one of the forms replaced, and a `${NAME}`
 * marker is JSON-safe. The SAME object when nothing in it needed redacting;
 * text that no longer parses (a value matched JSON's own punctuation) is
 * withheld like data that cannot be serialised.
 */
function redactData(data: unknown, redact: (text: string) => string): unknown {
  if (typeof data === 'string') return redact(data);
  if (data === null || typeof data !== 'object') return data;
  try {
    const json = JSON.stringify(data);
    if (json === undefined) return data;
    const redacted = redact(json);
    return redacted === json ? data : JSON.parse(redacted);
  } catch {
    return UNCHECKABLE_DATA;
  }
}

function read(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined; // A getter that throws serves nothing.
  }
}

/** Set `field` when its value changed; false when the write did not take (frozen, getter-only). */
function assign(record: Record<string, unknown>, field: string, next: unknown, previous: unknown): boolean {
  if (next === previous) return true;
  try {
    Reflect.set(record, field, next);
  } catch {
    return false;
  }
  return read(record, field) === next;
}

function messageOf(err: object): string {
  try {
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' ? message : String(err);
  } catch {
    return 'The tool call failed.';
  }
}

function statusOf(err: object): unknown {
  try {
    const e = err as { status?: unknown; response?: { status?: unknown } };
    return e.status ?? e.response?.status;
  } catch {
    return undefined;
  }
}
