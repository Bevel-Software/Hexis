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
 * The mirror of {@link BODY_AT_TOP_LEVEL_LINE}: the same mistake the other way
 * round, by an agent that learned the flat shape and used it on a tool whose
 * arguments ride a `body` envelope. The platform's route-hosted tools take that
 * envelope, and the arguments of a flat call reach their route as query
 * parameters instead of a body — which is how the route tells this apart from a
 * call that simply left everything out, and can say which it was.
 */
export const ARGS_UNDER_BODY_LINE = 'This tool takes its arguments under "body", not at the top level.';

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
  // A value the schema fixes is shown as that value: `"..."` would be a call
  // the check refuses.
  if (schema.const !== undefined) return schema.const;
  // The first member the rest of the schema admits, so a sibling constraint
  // (`minLength`, a range) cannot make the example one the check refuses.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.find((option) => valueMismatch('', schema, option) === null) ?? schema.enum[0];
  }
  const type = declaredTypes(schema)?.[0];
  if (type === 'number' || type === 'integer') return numberPlaceholder(schema, type === 'integer');
  if (type === 'boolean') return true;
  if (type === 'array') {
    // An array that must not be empty is shown with one element, so the
    // example satisfies its own schema (`tools_info` takes `tool_names`
    // with at least one name). Otherwise empty, the shortest array that works.
    const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
    if (minItems < 1) return [];
    const items = isDict(schema.items) ? schema.items : {};
    return Array.from({ length: minItems }, () => placeholder(items, depth));
  }
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
 * A number the schema's range admits: `0`, unless a bound rules it out —
 * then the nearest value at the lower bound, the upper bound, or between the
 * two, whichever satisfies EVERY bound (`exclusiveMinimum: 1, maximum: 1.5`
 * gives `1.5` and `exclusiveMaximum: 1.5` in its place
 * gives `1.25`, not a `2` the check would refuse). A range nothing satisfies
 * keeps `0`: the schema is at fault, and no example can fix it.
 */
function numberPlaceholder(schema: Dict, integer: boolean): number {
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const minimum = num(schema.minimum);
  const maximum = num(schema.maximum);
  const exclusiveMinimum = num(schema.exclusiveMinimum);
  const exclusiveMaximum = num(schema.exclusiveMaximum);
  const lows = [minimum, exclusiveMinimum].filter((v): v is number => v !== undefined);
  const highs = [maximum, exclusiveMaximum].filter((v): v is number => v !== undefined);
  const low = lows.length > 0 ? Math.max(...lows) : undefined;
  const high = highs.length > 0 ? Math.min(...highs) : undefined;
  const candidates = [
    0,
    minimum,
    exclusiveMinimum === undefined ? undefined : exclusiveMinimum + 1,
    maximum,
    exclusiveMaximum === undefined ? undefined : exclusiveMaximum - 1,
    low !== undefined && high !== undefined ? (low + high) / 2 : undefined,
  ].flatMap((c) => (c === undefined ? [] : integer ? [Math.ceil(c), Math.floor(c)] : [c]));
  return candidates.find((c) => numericBoundBroken(schema, c) === null) ?? 0;
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

/** A key as JavaScript source: bare when it is an identifier, quoted (and escaped) when it is not, e.g. `"odd-key"`. */
function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/**
 * The placeholder tree as source an agent can paste: object keys bare, strings
 * double-quoted, one space inside the braces. Every value here was produced by
 * {@link placeholder}; strings and keys that are not identifiers are quoted as
 * JSON, so a value taken from an `enum` is escaped like any other.
 */
function render(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${value.map(render).join(', ')}]`;
  if (isDict(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${renderKey(k)}: ${render(v)}`);
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
  options: {
    /**
     * The schema the CALL EXAMPLE is generated from, when that is not the
     * schema the arguments were checked against. A route-hosted tool is checked
     * against its FLAT arguments — the ones its handler receives, and so the
     * ones the mismatch lines and the interface name — while the example still
     * has to show the `{ body: { … } }` envelope an agent actually types.
     * Default: one schema for both.
     */
    exampleInputs?: unknown;
  } = {},
): string {
  const interfaceLines = describeInterface(inputs);
  return [
    `The arguments do not match the "${toolName}" tool.`,
    ...mismatches,
    `Interface of "${toolName}":`,
    ...(interfaceLines.length > 0 ? interfaceLines : ['(this tool takes no arguments)']),
    callLine(utcpName, options.exampleInputs ?? inputs),
  ].join('\n');
}

/**
 * A compiled check for one input schema: either the rules to check a call
 * against, or the reason this schema cannot be used for checking.
 *
 * Compiled once per distinct schema and kept (see {@link checkFor}), so the
 * check costs a walk of the arguments and nothing else per call.
 */
export type CompiledCheck =
  | { checkable: false; reason: string }
  | { checkable: true; check: (args: Dict) => string[] };

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
      const wrong = valueMismatch(name, prop, value);
      if (wrong) {
        mismatches.push(wrong);
        continue; // a wrong value cannot also be walked for its own arguments
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

/**
 * What is wrong with one argument's VALUE, or `null`: its type first, then
 * the constraints the schema puts on a value of that type — `enum`/`const`,
 * a string's length and `pattern`, a number's range, an array's length and
 * each of its `items`. A call that breaks a declared constraint does not match
 * the schema any more than one of the wrong type does, and is refused the same
 * way rather than reaching the tool.
 *
 * `format` is an annotation (JSON Schema does not require it to be asserted)
 * and is not checked; neither is a keyword this module does not know. A
 * subschema using a combinator is not ours to judge and passes as it is.
 */
function valueMismatch(name: string, schema: Dict, value: unknown): string | null {
  if (unsupportedKeyword(schema)) return null;
  const expected = declaredTypes(schema);
  if (expected && !typeMatches(expected, value)) {
    return `"${name}" must be ${expected.join(' or ')}, but ${jsonTypeOf(value)} was given.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameJson(option, value))) {
    return `"${name}" must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}, but ${shortJson(value)} was given.`;
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    return `"${name}" must be ${JSON.stringify(schema.const)}, but ${shortJson(value)} was given.`;
  }
  if (typeof value === 'string') {
    // Length in code points, as JSON Schema counts it, not UTF-16 units.
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      return `"${name}" must be at least ${schema.minLength} character(s) long, but ${length} was given.`;
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      return `"${name}" must be at most ${schema.maxLength} character(s) long, but ${length} was given.`;
    }
    const pattern = typeof schema.pattern === 'string' ? compiledPattern(schema.pattern) : null;
    if (pattern && !pattern.test(value)) {
      return `"${name}" must match the pattern ${schema.pattern as string}, but ${shortJson(value)} was given.`;
    }
  }
  if (typeof value === 'number') {
    const bound = numericBoundBroken(schema, value);
    if (bound) return `"${name}" must be ${bound}, but ${value} was given.`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `"${name}" must hold at least ${schema.minItems} item(s), but ${value.length} was given.`;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `"${name}" must hold at most ${schema.maxItems} item(s), but ${value.length} was given.`;
    }
    if (isDict(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const wrong = valueMismatch(`${name}[${i}]`, schema.items, value[i]);
        if (wrong) return wrong; // the first bad item is enough to correct the call
      }
    }
  }
  return null;
}

/** The numeric bound `value` breaks, phrased for a refusal, or `null`. */
function numericBoundBroken(schema: Dict, value: number): string | null {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
  if (typeof minimum === 'number' && value < minimum) return `at least ${minimum}`;
  if (typeof maximum === 'number' && value > maximum) return `at most ${maximum}`;
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) return `greater than ${exclusiveMinimum}`;
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) return `less than ${exclusiveMaximum}`;
  return null;
}

/**
 * Equality as JSON sees it, for `enum` and `const`: arrays in order, objects
 * by their properties whatever order their keys were written in.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]))
    );
  }
  if (!isDict(a) || !isDict(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]))
  );
}

/** A value as it appears in a refusal: JSON, cut short so one long argument cannot fill the message. */
function shortJson(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

/**
 * Could this pattern backtrack catastrophically? True for a group that repeats
 * (`*`, `+`, `{…}`) and itself contains a quantifier or an
 * alternation — `(a+)+`, `(a|a)*`, `(\w+\s?)*` — and for a backreference.
 *
 * JavaScript's matcher backtracks, so such a pattern, which comes from a
 * schema someone else wrote, could hold the event loop for seconds on one
 * caller's string. The test is a conservative over-approximation (it flags
 * some patterns that would in fact be fast); a flagged pattern is simply not
 * asserted, which is what this module does with any keyword it cannot judge
 * safely.
 */
export function patternMayBacktrack(source: string): boolean {
  if (/\\[1-9]|\\k</.test(source)) return true;
  // One frame per open group: did anything inside it repeat or branch?
  const stack: boolean[] = [];
  let risky = false; // what the group that just closed held
  let previousClosedGroup = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const afterGroup = previousClosedGroup;
    previousClosedGroup = false;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') {
      // A character class is one atom: skip to its closing bracket.
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      if (source[i + 1] === '?') i++; // `(?:`, `(?=`, `(?<name>`: the `?` is syntax, not a quantifier
      continue;
    }
    if (ch === ')') {
      risky = stack.pop() ?? false;
      // What a group holds, the group around it holds too.
      if (risky && stack.length > 0) stack[stack.length - 1] = true;
      previousClosedGroup = true;
      continue;
    }
    const quantifier = ch === '*' || ch === '+' || ch === '?' || ch === '{';
    if (quantifier || ch === '|') {
      if (stack.length > 0) stack[stack.length - 1] = true;
      // `?` repeats nothing; any `{…}` count is treated as a repeat, a long
      // fixed count compounding the backtracking just as `+` does.
      const repeats = ch === '*' || ch === '+' || ch === '{';
      if (afterGroup && repeats && risky) return true;
    }
    if (ch === '{') {
      const close = source.indexOf('}', i);
      if (close > i) i = close;
    }
  }
  return false;
}

/**
 * A `pattern` compiled once. One this runtime cannot compile, or one that may
 * backtrack catastrophically (see {@link patternMayBacktrack}), is not checked
 * rather than refused.
 */
const patterns = new Map<string, RegExp | null>();
function compiledPattern(source: string): RegExp | null {
  if (!patterns.has(source)) {
    let re: RegExp | null = null;
    if (patternMayBacktrack(source)) {
      patterns.set(source, null);
      return null;
    }
    try {
      re = new RegExp(source, 'u');
    } catch {
      try {
        re = new RegExp(source);
      } catch {
        re = null;
      }
    }
    patterns.set(source, re);
  }
  return patterns.get(source) ?? null;
}

/** A nested mismatch, named by its path (`"body.path" is required…`). */
function qualify(parent: string, mismatch: string): string {
  return mismatch.replace(/^"([^"]+)"/, (_m, name: string) => `"${parent}.${name}"`);
}

/**
 * One compiled check per distinct input schema, kept for as long as the schema
 * object lives. Both surfaces that check a call hand in the SAME schema object
 * every time — the tool repository hands out tools whose `inputs` is the stored
 * object, and a route's schema is the one its `toolDef` was given — so the
 * check is compiled once per tool rather than once per call, and a call pays
 * for a walk of its arguments and nothing else.
 */
const compiled = new WeakMap<object, CompiledCheck>();

/** The compiled check for one input schema, compiled at most once per schema. */
export function checkFor(inputs: unknown): CompiledCheck {
  if (typeof inputs !== 'object' || inputs === null) return compileCheck(inputs);
  const hit = compiled.get(inputs);
  if (hit) return hit;
  const built = compileCheck(inputs);
  compiled.set(inputs, built);
  return built;
}
