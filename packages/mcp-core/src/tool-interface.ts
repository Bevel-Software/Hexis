import { utcpNameToTsInterfaceName } from './code-mode-names.js';

/**
 * A tool's INTERFACE, in the two forms an agent needs it: the one-line call
 * example that opens every description, and the argument list a refusal shows
 * when a call did not match.
 *
 * Both are derived from the tool's own input schema and nothing else. A
 * hand-written example drifts from the schema the moment either changes, and a
 * connected server's tools would have none at all — so there is one generator
 * here, used by the platform's own tools, by a deployment's, and by every
 * connected server's alike.
 *
 * Pure: no IO, no clock, no client. The surfaces that list tools call
 * {@link withCallExample}; the argument check beside it (`call-guards.ts`)
 * calls {@link argumentsDoNotMatchMessage}.
 */

/** What every tool description starts with, on a line of its own. */
export const CALL_LINE_PREFIX = 'Call: ';

/** The `kind` an arguments-do-not-match refusal carries, for a client that branches on it. */
export const ARGUMENTS_DO_NOT_MATCH_KIND = 'arguments-do-not-match';

/**
 * The sentence that leads the mismatches when every argument was wrapped in a
 * `body` the tool does not have — the single most common wrong call, because
 * the platform's own tools DO take their arguments that way and a connector
 * tool's arguments are flat.
 */
export const BODY_AT_TOP_LEVEL_LINE = 'This tool takes its arguments at the top level, not under "body".';

/**
 * How deep the interface and the check go: the top level and one level below
 * it. That is exactly far enough for the `{ body: { ... } }` envelope every
 * platform tool wears, and keeps a refusal readable for a connected server's
 * deeply nested schema instead of printing its whole tree.
 */
const MAX_DEPTH = 2;

/** An argument description is cut to this, so one verbose argument can't crowd out the rest. */
const DESCRIPTION_MAX = 160;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON-Schema keywords this module cannot reason about; their presence switches checking off. */
const UNSUPPORTED_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'not', '$ref', 'if', 'then', 'else'] as const;

function unsupportedKeyword(schema: Dict): string | undefined {
  return UNSUPPORTED_KEYWORDS.find((k) => schema[k] !== undefined);
}

/** The declared types of a (sub)schema as a list, or undefined when it declares none we know. */
function declaredTypes(schema: Dict): string[] | undefined {
  const raw = schema.type;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((t) => typeof t === 'string') : [];
  const known = (list as string[]).filter((t) =>
    ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'].includes(t),
  );
  return known.length > 0 ? known : undefined;
}

/** The placeholder value a type takes in the call example. */
function placeholder(schema: Dict, depth: number): unknown {
  const type = declaredTypes(schema)?.[0];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') {
    // An object whose own required arguments are known is shown with them, so
    // the `{ body: { branch, path } }` envelope is spelled out rather than
    // handed over as an empty `{}` the agent has to guess the inside of.
    return depth < MAX_DEPTH ? exampleArguments(schema, depth + 1) : {};
  }
  // No declared type (or `null`) is shown as a string placeholder: the
  // overwhelming majority of such arguments are strings, and a `"..."` reads
  // as "put a value here" in a way `null` does not.
  return '...';
}

/**
 * The arguments the call example passes: one placeholder per REQUIRED
 * argument, in the order the schema requires them, and nothing else.
 *
 * This is the example as a VALUE, which is what makes the example testable —
 * every tool the platform declares is checked with it against its own schema,
 * so an example an agent copies is one the check accepts.
 */
export function exampleArguments(inputs: unknown, depth = 1): Dict {
  const schema = isDict(inputs) ? inputs : {};
  const properties = isDict(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [];
  const args: Dict = {};
  for (const name of required as string[]) {
    const prop = properties[name];
    args[name] = placeholder(isDict(prop) ? prop : {}, depth);
  }
  return args;
}

/**
 * The placeholder tree as source an agent can paste: object keys bare, strings
 * double-quoted, one space inside the braces. Every value here was produced by
 * {@link placeholder}, so there is nothing to escape.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return '[]';
  if (isDict(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${render(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  return String(value);
}

/**
 * The call example for one tool: the namespace this connection exposes, the
 * tool's name, and its required arguments with a placeholder each, in the shape
 * the tool really takes.
 *
 * `utcpName` is the tool's registered UTCP name (`<manual>.<tool>`); the
 * namespace and name come from the same mapping the chain runtime uses, so the
 * example is literally callable inside `call_tool_chain`. Optional arguments
 * are left out — the example is the shortest call that can work, not a catalog.
 */
export function callExample(utcpName: string, inputs: unknown): string {
  return `${utcpNameToTsInterfaceName(utcpName)}(${render(exampleArguments(inputs))})`;
}

/** The `Call:` line as it appears at the top of a description. */
export function callLine(utcpName: string, inputs: unknown): string {
  return `${CALL_LINE_PREFIX}${callExample(utcpName, inputs)}`;
}

/**
 * A description with its call example ahead of it. Idempotent: a description
 * that already opens with a `Call:` line keeps the one it has, so a surface
 * that lists the same tool through two layers cannot stack two examples.
 */
export function withCallExample(description: string | undefined, utcpName: string, inputs: unknown): string {
  const body = description ?? '';
  if (body.startsWith(CALL_LINE_PREFIX)) return body;
  return body === '' ? callLine(utcpName, inputs) : `${callLine(utcpName, inputs)}\n\n${body}`;
}

/**
 * Split a description into its `Call:` line and the rest, so a caller that
 * prepends text of its own (the knowledge-base tools' purpose prefix) can keep
 * the example first — the line only does its job if it is the first thing read.
 */
export function splitCallLine(description: string): { call: string | null; rest: string } {
  if (!description.startsWith(CALL_LINE_PREFIX)) return { call: null, rest: description };
  const end = description.indexOf('\n');
  if (end < 0) return { call: description, rest: '' };
  return { call: description.slice(0, end), rest: description.slice(end + 1).replace(/^\n+/, '') };
}

function shortDescription(schema: Dict): string {
  const raw = typeof schema.description === 'string' ? schema.description.replace(/\s+/g, ' ').trim() : '';
  if (raw.length <= DESCRIPTION_MAX) return raw;
  return `${raw.slice(0, DESCRIPTION_MAX - 1)}…`;
}

function typeLabel(schema: Dict): string {
  return declaredTypes(schema)?.join(' or ') ?? 'any';
}

/**
 * The tool's interface as lines: every argument with its type, whether it is
 * required, and its description — the top level, then one level below it,
 * indented. This is what an agent needs in order to correct its call, and it
 * is the schema's own content, never prose about it.
 */
export function describeInterface(inputs: unknown, depth = 1, indent = ''): string[] {
  const schema = isDict(inputs) ? inputs : {};
  const properties = isDict(schema.properties) ? schema.properties : {};
  const required = new Set(
    (Array.isArray(schema.required) ? schema.required : []).filter((r): r is string => typeof r === 'string'),
  );
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const prop = isDict(raw) ? raw : {};
    const description = shortDescription(prop);
    lines.push(
      `${indent}${name} (${typeLabel(prop)}, ${required.has(name) ? 'required' : 'optional'})` +
        (description === '' ? '' : ` — ${description}`),
    );
    if (depth < MAX_DEPTH && declaredTypes(prop)?.includes('object') && isDict(prop.properties)) {
      lines.push(...describeInterface(prop, depth + 1, `${indent}  `));
    }
  }
  return lines;
}

/**
 * The whole refusal: one sentence that the arguments do not match, the
 * mismatches one per line, the interface, and the call example last — the order
 * an agent reads it in, ending with the line it can copy.
 */
export function argumentsDoNotMatchMessage(
  toolName: string,
  utcpName: string,
  inputs: unknown,
  mismatches: string[],
): string {
  const interfaceLines = describeInterface(inputs);
  return [
    `The arguments do not match the "${toolName}" tool.`,
    ...mismatches,
    `Interface of "${toolName}":`,
    ...(interfaceLines.length > 0 ? interfaceLines : ['(this tool takes no arguments)']),
    callLine(utcpName, inputs),
  ].join('\n');
}

/**
 * A compiled check for one input schema: either the rules to check a call
 * against, or the reason this schema cannot be used for checking.
 *
 * Compiled once per distinct schema and kept (see `call-guards.ts`), so the
 * check costs a walk of the arguments and nothing else per call.
 */
export type CompiledCheck =
  | { checkable: false; reason: string }
  | { checkable: true; check: (args: Dict) => string[] };

/**
 * The one argument whose absence is NOT reported here: `branch` has its own
 * named refusal at the boundary (`branch-required`, which also catches the
 * `"undefined"` a client interpolates), and that refusal says more than a
 * generic mismatch would. A call missing only `branch` therefore goes through
 * and is refused there, with its existing wording.
 */
const DEFERRED_REQUIRED = new Set(['branch']);

/** A value's JSON type, as the schema's vocabulary names it. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function typeMatches(types: string[], value: unknown): boolean {
  const actual = jsonTypeOf(value);
  // An integer satisfies `number`, and any number satisfies `integer` only
  // when it has no fractional part — which `jsonTypeOf` has already decided.
  return types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

/**
 * Compile one input schema into a check, or decide it cannot be checked.
 *
 * Deliberately conservative: anything this module cannot reason about with
 * certainty — a combinator, a `$ref`, a schema that is not an object — switches
 * the check OFF rather than guessing. A checker that refuses valid calls would
 * take tools away from every agent at once, so every rule here is one a call
 * cannot satisfy by any reading of the schema.
 */
export function compileCheck(inputs: unknown): CompiledCheck {
  if (!isDict(inputs)) return { checkable: false, reason: 'the input schema is not an object' };
  const unsupported = unsupportedKeyword(inputs);
  if (unsupported) return { checkable: false, reason: `the input schema uses "${unsupported}"` };
  const types = declaredTypes(inputs);
  if (types && !types.includes('object')) {
    return { checkable: false, reason: `the input schema declares type "${types.join(' or ')}", not an object` };
  }
  if (inputs.properties !== undefined && !isDict(inputs.properties)) {
    return { checkable: false, reason: 'the input schema\'s "properties" is not an object' };
  }
  const properties = isDict(inputs.properties) ? inputs.properties : {};
  const required = (Array.isArray(inputs.required) ? inputs.required : []).filter(
    (r): r is string => typeof r === 'string',
  );
  const closed = inputs.additionalProperties === false;
  const hasBodyProperty = Object.prototype.hasOwnProperty.call(properties, 'body');

  // Sub-checks for the one level below the top: compiled here, with the rest,
  // so a call pays nothing for them.
  const nested = new Map<string, CompiledCheck>();
  for (const [name, raw] of Object.entries(properties)) {
    if (!isDict(raw) || !declaredTypes(raw)?.includes('object') || !isDict(raw.properties)) continue;
    const inner = compileCheck(raw);
    if (inner.checkable) nested.set(name, inner);
  }

  const check = (args: Dict): string[] => {
    const mismatches: string[] = [];
    // The `body` wrapper first: when every argument sits under a `body` key the
    // tool does not have, THAT is what went wrong, and the lines below (a
    // missing required argument, an argument the tool lacks) are its symptoms.
    const keys = Object.keys(args);
    if (!hasBodyProperty && keys.length === 1 && keys[0] === 'body' && isDict(args.body)) {
      mismatches.push(BODY_AT_TOP_LEVEL_LINE);
    }
    for (const name of required) {
      if (DEFERRED_REQUIRED.has(name)) continue;
      if (args[name] === undefined) mismatches.push(`"${name}" is required, and was not given.`);
    }
    if (closed) {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          mismatches.push(`"${key}" is not an argument of this tool.`);
        }
      }
    }
    for (const [name, raw] of Object.entries(properties)) {
      const value = args[name];
      if (value === undefined) continue;
      const prop = isDict(raw) ? raw : {};
      if (unsupportedKeyword(prop)) continue; // not ours to judge
      const expected = declaredTypes(prop);
      if (expected && !typeMatches(expected, value)) {
        mismatches.push(
          `"${name}" must be ${expected.join(' or ')}, but ${jsonTypeOf(value)} was given.`,
        );
        continue; // a wrong type cannot also be walked for its own arguments
      }
      const inner = nested.get(name);
      if (inner?.checkable && isDict(value)) {
        mismatches.push(...inner.check(value).map((m) => qualify(name, m)));
      }
    }
    return mismatches;
  };
  return { checkable: true, check };
}

/** A nested mismatch, named by its path (`"body.path" is required…`). */
function qualify(parent: string, mismatch: string): string {
  return mismatch.replace(/^"([^"]+)"/, (_m, name: string) => `"${parent}.${name}"`);
}
