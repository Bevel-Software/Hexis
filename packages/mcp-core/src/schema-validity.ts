/**
 * Is a connected tool's input schema valid JSON Schema?
 *
 * AI clients ask this question themselves, and when the answer is no they drop
 * the tool WITHOUT SAYING SO: the tool is simply missing for the agent, with
 * nothing in Hexis to look at. So Hexis asks it first, when a server's tools
 * are loaded, and keeps such a tool off every agent surface with a marker the
 * server's owner can read.
 *
 * The check is the JSON Schema META-SCHEMA (2020-12, the draft the MCP
 * specification names), run by `ajv` — the same validator the MCP SDK and the
 * clients use, so a tool is hidden on exactly the violations a client would
 * also refuse, and the reason is quoted in the words the client reports. The
 * three refusals this started from reproduce to the character:
 *
 *   /properties/…/socialLinks/items/anyOf  must be an array
 *   /properties/…/value/anyOf/0/required/0 must be a string
 *   /properties/…/value/properties/table/type  must be equal to one of the allowed values
 *
 * One thing the meta-schema does not cover is checked beside it: a `pattern`
 * (or a `patternProperties` key) that is not a compilable regular expression.
 * The meta-schema says only that it is a string, while a client COMPILES it and
 * drops the tool when that throws — see {@link regexDefect}.
 *
 * NOT a repair. Nothing here rewrites a schema — the proxy passes a connected
 * server's schema through as sent, and an invalid one is reported, never fixed.
 */

import Ajv2020 from 'ajv/dist/2020.js';

/** Where a schema is not valid JSON Schema, and why. */
export interface SchemaDefect {
  /** JSON Pointer into the schema, e.g. `/properties/value/required/0`. */
  path: string;
  /** The violation in the validator's own words, e.g. `must be a string`. */
  reason: string;
}

/**
 * One validator for the process. `strict: false` keeps this to the
 * meta-schema: ajv's strict mode objects to things no client refuses (an
 * unknown keyword, a `required` naming an undeclared property), and hiding a
 * tool that works is worse than listing one whose schema is merely unusual.
 *
 * `validateFormats: false` is the same rule applied to the META-schema's own
 * `format` annotations (`$id` and `$ref` as `uri-reference`, `pattern` as
 * `regex`). Switching them on is INERT, which is worth knowing before anyone
 * reaches for it: `validateSchema` does not assert the meta-schema's formats
 * at all, so every schema gets the same verdict with `validateFormats: true`
 * as with it off — including `pattern: "["`, which ajv-formats' own `regex`
 * function rejects when called directly. The switch changes configuration,
 * not behaviour; `__tests__/schema-validity.test.ts` pins that.
 *
 * It would be the wrong thing to want in any case. An AI client never
 * meta-validates the schema document: the MCP SDK's validator runs
 * `{ strict: false, validateFormats: true, validateSchema: false }`
 * (`validation/ajv-provider.js`) — formats on the INSTANCE, the schema
 * document itself never checked against the meta-schema — so a malformed
 * `$id` or `$ref` compiles there without complaint, and flagging one here
 * would hide a tool every client accepts. The one URI-valued construct a
 * client really refuses is a `$ref` it cannot RESOLVE (`can't resolve
 * reference …` out of `compile`), and no format assertion catches that one
 * either; none is ever offered, because `sanitizeInputSchema` replaces an
 * unresolvable or non-local `$ref` with `{}` before the listing goes out.
 * Each half is pinned where it belongs: what this check does NOT flag in
 * `__tests__/schema-validity.test.ts`, and what the proxy offers in place of
 * such a `$ref` in `__tests__/schema-pass-through.test.ts`.
 *
 * So the one format that does decide a client's verdict is `regex` — a client
 * COMPILES a `pattern` — and because the meta-check misses it under either
 * setting, it is checked directly, below.
 */
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

/**
 * The first place `schema` is not valid JSON Schema, or `null` when it is.
 *
 * FAIL-OPEN: a schema the validator itself cannot process (an unknown
 * `$schema` dialect, say) is reported as having no defect. A validator fault
 * is not evidence against the tool, and the cost of being wrong here is one
 * tool hidden from every agent.
 */
export function inputSchemaDefect(schema: unknown): SchemaDefect | null {
  // MCP requires an OBJECT input schema. `true`/`false` are legal JSON Schema
  // but not legal here, and an array or a string is neither. Only `undefined`
  // is ABSENT: a server that advertises `"inputSchema": null` has declared one
  // and declared it wrong, which is a thing its owner wants to hear about.
  if (schema === undefined) return null; // absent: `toListedTool` supplies `{}`
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { path: '/', reason: 'must be an object' };
  }
  let valid: boolean;
  try {
    valid = ajv.validateSchema(schema) as boolean;
  } catch {
    return null;
  }
  if (!valid) {
    const first = ajv.errors?.[0];
    if (!first) return null;
    return {
      path: first.instancePath || '/',
      reason: withArticle(first.message ?? 'is not valid JSON Schema'),
    };
  }
  return regexDefect(schema as Record<string, unknown>);
}

/** JSON Schema keywords whose value is a schema, or a list of schemas. */
const SCHEMA_VALUED_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

/**
 * Keywords whose value is a MAP of schemas: the keys are names, the values
 * schemas. `$defs`/`definitions` are NOT walked as such: an entry there is a
 * schema only once a reference reaches it (ajv compiles nothing else, and the
 * listing the proxy serves drops the block and inlines only what a `$ref`
 * reaches), so the walk follows the references instead — see
 * {@link regexDefect}.
 */
const SCHEMA_MAP_KEYWORDS = ['dependentSchemas', 'patternProperties', 'properties'] as const;

/**
 * A bound on the walk below, for a schema whose shape is the sender's choice.
 * It caps the QUEUE, so neither depth nor breadth can make the check cost more
 * than this many entries.
 */
const MAX_REGEX_CHECK_NODES = 50_000;

/**
 * The first regex-bearing keyword in `schema` that does not compile, or `null`.
 *
 * The meta-schema does NOT catch these: `{ "type": "string", "pattern": "[" }`
 * is a perfectly well-formed schema document. But a client does not merely read
 * a `pattern` — it COMPILES it (the MCP SDK's own validator is `ajv.compile`),
 * so that schema throws there and the tool is dropped just as silently as one
 * the meta-schema rejects. Hexis has to find it for the same reason it finds
 * the others.
 *
 * Tested with the `u` flag, which is how ajv compiles a `pattern`
 * (`unicodeRegExp`, on by default) — so the verdict matches the validator the
 * clients actually run rather than a looser reading. The walk is iterative and
 * only ever descends through keywords whose value IS a schema, so a tool's own
 * field named `pattern` (or a `pattern` string inside a `const` value) is data
 * and is left alone.
 *
 * A `$defs`/`definitions` entry is reached only through a local `$ref` (or
 * `$dynamicRef`) that names it, and reported at ITS OWN path — the place in
 * the schema the server sent, which is what its owner edits. An entry nothing
 * references is never compiled by a client and never listed by the proxy, so
 * a bad regex in it hides no tool anywhere and is not a defect here: this
 * module's contract is "hidden on exactly what a client would refuse".
 */
function regexDefect(schema: Record<string, unknown>): SchemaDefect | null {
  const queue: Array<{ node: Record<string, unknown>; path: string }> = [{ node: schema, path: '' }];
  // Each node once, by path: two references to one entry are one schema.
  const seen = new Set<string>(['']);
  // The cap bounds what is ENQUEUED, not only what is dequeued: a wide schema
  // reaches its limit by breadth rather than depth, and a queue entry costs a
  // path string that the node it describes does not. Past the cap the check
  // simply stops looking, which is the fail-open rule this whole file follows.
  const enqueue = (node: Record<string, unknown>, path: string) => {
    if (seen.has(path) || queue.length >= MAX_REGEX_CHECK_NODES) return;
    seen.add(path);
    queue.push({ node, path });
  };
  for (let i = 0; i < queue.length; i += 1) {
    const { node, path } = queue[i];
    if (typeof node.pattern === 'string' && !compiles(node.pattern)) {
      return { path: `${path}/pattern`, reason: 'must be a valid regular expression' };
    }
    for (const keyword of ['$ref', '$dynamicRef'] as const) {
      const reference = node[keyword];
      if (typeof reference !== 'string' || !reference.startsWith('#/')) continue;
      const target = resolveLocalPointer(schema, reference);
      if (isSchemaObject(target)) enqueue(target, reference.slice(1));
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const map = node[keyword];
      if (!isSchemaObject(map)) continue;
      for (const [key, value] of Object.entries(map)) {
        if (keyword === 'patternProperties' && !compiles(key)) {
          return { path: `${path}/patternProperties/${pointerPart(key)}`, reason: 'must be a valid regular expression' };
        }
        if (isSchemaObject(value)) enqueue(value, `${path}/${keyword}/${pointerPart(key)}`);
      }
    }
    for (const keyword of SCHEMA_VALUED_KEYWORDS) {
      const value = node[keyword];
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (isSchemaObject(item)) enqueue(item, `${path}/${keyword}/${index}`);
        });
      } else if (isSchemaObject(value)) {
        enqueue(value, `${path}/${keyword}`);
      }
    }
  }
  return null;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The node a local JSON Pointer (`#/$defs/x`) names in `root`, or undefined. */
function resolveLocalPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const part of pointer.slice(2).split('/')) {
    if (!isSchemaObject(node) && !Array.isArray(node)) return undefined;
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    // Own members only: `#/__proto__` must name nothing, not `Object.prototype`.
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/** A JSON Pointer path segment: `~` and `/` in a name have to be escaped. */
function pointerPart(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The sentence the tool's owner reads, wherever the marker is shown — the tool
 * setup page and `list_tool_setup` say the same thing in the same words,
 * because they are the same finding.
 */
export function schemaDefectMarker(defect: SchemaDefect): string {
  return `Hidden from agents: its schema is invalid at ${defect.path} (${defect.reason}).`;
}

/** ajv says `must be string`; a sentence a person reads says `must be a string`. */
function withArticle(message: string): string {
  return message.replace(
    /^must be (array|boolean|integer|null|number|object|string)$/,
    (_full, type: string) => `must be a${/^[aeiou]/.test(type) ? 'n' : ''} ${type}`,
  );
}
