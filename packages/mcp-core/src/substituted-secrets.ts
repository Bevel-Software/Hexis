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

/**
 * Shorter than this, a substituted value is not redacted: `1` or `v2` in a
 * path is a version, not a credential, and replacing it everywhere would
 * garble the message the caller needs.
 */
const MIN_REDACTED_LENGTH = 4;

/** Data that could not be serialised cannot be checked, so it is not served. */
const UNCHECKABLE_DATA = '[withheld: the tool failure carried data that could not be checked for secrets]';

/**
 * Make `client` record every value its substitutor resolves into the current
 * call's scope. Idempotent. A client without a substitutor (a test double)
 * substitutes nothing, so there is nothing to record.
 *
 * Throws when the substitutor is not the one this was written against: tool
 * errors would otherwise go out unredacted without anyone noticing.
 */
export function recordSubstitutions(client: CodeModeUtcpClient): void {
  const substitutor = (client as { variableSubstitutor?: unknown }).variableSubstitutor as
    | Record<string | symbol, unknown>
    | undefined;
  if (!substitutor || substitutor[RECORDING] === true) return;
  const getVariable = substitutor._getVariable;
  if (typeof getVariable !== 'function') {
    throw new Error(
      'The UTCP variable substitutor has no `_getVariable` to record substituted values through, ' +
        'so tool errors could not be redacted. The @utcp/sdk version is not the one this platform supports.',
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

/** `text` with every recorded value of `scope` replaced by the `${NAME}` it was written as. */
export function redactSubstitutedText(text: string, scope: SubstitutionScope): string {
  let redacted = text;
  for (const [form, marker] of replacements(scope)) {
    if (redacted.includes(form)) redacted = redacted.replaceAll(form, marker);
  }
  return redacted;
}

/**
 * The failure `err`, with the values substituted in `scope` redacted from
 * everything a surface reads out of it: its message and stack, the
 * upstream's answer (`data`, `response.data`, `statusText`) and its causes.
 *
 * In place, so the error keeps its class, status and cause chain — the token
 * refresh and session recovery decide on those. When something cannot be
 * rewritten in place (a frozen error, a getter), a plain error carrying the
 * redacted message and status is returned instead: the secret never stays.
 */
export function redactSubstitutedFailure(err: unknown, scope: SubstitutionScope): unknown {
  if (scope.values.size === 0) return err;
  if (typeof err === 'string') return redactSubstitutedText(err, scope);
  if (err === null || typeof err !== 'object') return err;
  const redact = (text: string) => redactSubstitutedText(text, scope);
  rewrite(err, redact, new Set());
  if (!stillCarries(err, redact, new Set())) return err;
  const withheld = new Error(redact(messageOf(err))) as Error & { status?: unknown };
  const status = statusOf(err);
  if (status !== undefined) withheld.status = status;
  return withheld;
}

/** Every spelling a value can take once quoted — raw, percent-encoded, form-encoded, JSON-escaped — longest first. */
function replacements(scope: SubstitutionScope): [string, string][] {
  const pairs = new Map<string, string>();
  for (const [value, name] of scope.values) {
    if (value.length < MIN_REDACTED_LENGTH) continue;
    for (const form of spellings(value)) if (!pairs.has(form)) pairs.set(form, `\${${name}}`);
  }
  return [...pairs].sort((a, b) => b[0].length - a[0].length);
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
  return [...new Set(forms)].filter((form) => form.length >= MIN_REDACTED_LENGTH);
}

/** The fields of a failure that carry text a surface may serve. */
const TEXT_FIELDS = ['message', 'stack', 'statusText'] as const;
/** The fields that carry a nested failure or response, rewritten in turn. */
const NESTED_FIELDS = ['cause', 'response', 'errors'] as const;

function rewrite(target: object, redact: (text: string) => string, seen: Set<object>): void {
  if (seen.has(target)) return;
  seen.add(target);
  const record = target as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const value = read(record, field);
    if (typeof value === 'string') assign(record, field, redact(value), value);
  }
  const data = read(record, 'data');
  if (data !== undefined) assign(record, 'data', redactData(data, redact), data);
  for (const field of NESTED_FIELDS) {
    const nested = read(record, field);
    if (typeof nested === 'string') assign(record, field, redact(nested), nested);
    else if (Array.isArray(nested)) nested.forEach((item) => item && typeof item === 'object' && rewrite(item, redact, seen));
    else if (nested && typeof nested === 'object') rewrite(nested, redact, seen);
  }
}

function stillCarries(target: object, redact: (text: string) => string, seen: Set<object>): boolean {
  if (seen.has(target)) return false;
  seen.add(target);
  const record = target as Record<string, unknown>;
  for (const field of [...TEXT_FIELDS, 'data', ...NESTED_FIELDS]) {
    let value: unknown;
    try {
      value = record[field];
    } catch {
      continue; // A getter that throws serves nothing.
    }
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (redact(value) !== value) return true;
    } else if (field === 'data') {
      if (redactData(value, redact) !== value) return true;
    } else if (Array.isArray(value)) {
      if (value.some((item) => item && typeof item === 'object' && stillCarries(item, redact, seen))) return true;
    } else if (typeof value === 'object' && stillCarries(value, redact, seen)) return true;
  }
  return false;
}

/**
 * An upstream answer, redacted through its JSON text — the JSON-escaped
 * spelling of every value is one of the forms replaced, and a `${NAME}`
 * marker is JSON-safe. The SAME object when nothing in it needed redacting.
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
    return undefined;
  }
}

/** Set `field` when its value changed; a refused write is caught by {@link stillCarries}. */
function assign(record: Record<string, unknown>, field: string, next: unknown, previous: unknown): void {
  if (next === previous) return;
  try {
    Reflect.set(record, field, next);
  } catch {
    // Frozen or getter-only: the caller falls back to a fresh error.
  }
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
