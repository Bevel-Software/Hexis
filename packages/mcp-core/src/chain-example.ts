import { sanitizeIdentifier, utcpNameToTsInterfaceName } from './code-mode-names.js';

/**
 * The example call in `call_tool_chain`'s description, derived from the live
 * catalog — the NAME and the ARGUMENTS both.
 *
 * The name alone was not enough. A first pass read the callable name off the
 * catalog (which the two surfaces spell differently: `KNOWLEDGE_BASE.read_file`
 * on the hosted endpoint, `hexis.hexis_read_file` through the local server) but
 * kept the arguments as fixed text, `{ body: { path: '…' } }`. Every knowledge-
 * base tool declares `branch` REQUIRED, so an agent copying that example got
 * `400 … \`branch\` is required` — the acceptance criterion is that a copied
 * example WORKS, and a right name with wrong arguments fails it just as
 * squarely as a wrong name.
 *
 * So the arguments come from the tool's own input schema, and only when the
 * schema determines them. `branch` is a free-form required string with no
 * `default` and no `enum`: nothing in the catalog says WHICH branch, and
 * `'main'` would be a guess that breaks on any deployment whose default branch
 * is named otherwise — as would a guessed `path`, which has to name a file that
 * exists. A tool like that is therefore not used for the example at all.
 * Instead the example is the simplest call the catalog fully determines, which
 * in practice is a no-argument discovery tool (`start_session({ body: {} })`):
 * it demonstrates the namespace, the dotted name and the `{ body: … }` wrapper
 * — the three things an agent actually gets wrong — and it cannot be stale,
 * because every value in it was read from the schema rather than invented.
 */

/** One tool of the surface's catalog, as both surfaces already hold it. */
export interface ChainExampleTool {
  /** The UTCP name, e.g. `KNOWLEDGE_BASE.read_file`. */
  utcpName: string;
  /** The tool's UTCP input schema (`ProxiedTool.inputSchema`). */
  inputSchema?: unknown;
}

export interface ChainExample {
  /** The namespace, as the chain runtime spells it. */
  namespace: string;
  /** A callable NAME from the catalog — safe to print on its own, no arguments implied. */
  name: string;
  /**
   * A complete call that works as written, or null when the catalog affords
   * none. Null prints no example at all rather than a call that would fail:
   * an example an agent cannot trust is worse than the shape plus `tools_info`.
   */
  call: string | null;
}

/** How deep into a schema to look before giving up on writing a value for it. */
const MAX_DEPTH = 6;

/**
 * The one name preferred as the example call when several are equally simple.
 *
 * `start_session` is the call an external agent is told to make first in any
 * case, and the one with no preconditions — no branch, no path, no per-user
 * credential, nothing that has to already exist. Among no-argument tools that
 * makes it the one least able to fail for a reason the schema cannot see.
 */
const PREFERRED_EXAMPLE_TOOLS = ['start_session'];

interface SchemaLike {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  enum?: unknown;
  default?: unknown;
  minItems?: unknown;
}

/** A single-quoted JavaScript string, safe to paste into chain source. */
function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** `value` as JavaScript source, or null when it is not a plain scalar. */
function scalarLiteral(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** An object key, bare when it is an identifier and quoted when it is not. */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

/** A written value and how many scalars had to be written to get it. */
interface WrittenValue {
  source: string;
  /** Scalars in the value. Zero — `{ body: {} }` — is the simplest example. */
  scalars: number;
}

/**
 * The smallest value that satisfies `schema`, as JavaScript source, or null
 * when the schema does not say enough to write one.
 *
 * Only the REQUIRED properties are written: an optional argument an agent did
 * not ask for has no business in an example. A free-form required string,
 * number or boolean returns null — the schema names a type, not a value, and
 * inventing one is exactly how the example stopped working.
 */
function satisfyingValue(schema: unknown, depth: number): WrittenValue | null {
  if (depth > MAX_DEPTH || !schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const s = schema as SchemaLike;
  // A `default`, or a closed `enum`, is the schema itself naming a value.
  if ('default' in s) {
    const literal = scalarLiteral(s.default);
    if (literal !== null) return { source: literal, scalars: 1 };
  }
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const literal = scalarLiteral(s.enum[0]);
    if (literal !== null) return { source: literal, scalars: 1 };
  }
  const declared = Array.isArray(s.type) ? s.type.find((t) => typeof t === 'string') : s.type;
  const type = typeof declared === 'string' ? declared : s.properties ? 'object' : undefined;
  if (type === 'object') {
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string') : [];
    const parts: string[] = [];
    let scalars = 0;
    for (const key of required) {
      const child = satisfyingValue(properties[key], depth + 1);
      // A required argument whose value the schema does not determine
      // disqualifies the whole tool: a call missing it is a call that 400s.
      if (!child) return null;
      parts.push(`${propertyKey(key)}: ${child.source}`);
      scalars += child.scalars;
    }
    return { source: parts.length > 0 ? `{ ${parts.join(', ')} }` : '{}', scalars };
  }
  if (type === 'array') {
    // An empty array satisfies an array that demands no minimum. One that does
    // needs an element whose value the schema has not named.
    const min = typeof s.minItems === 'number' ? s.minItems : 0;
    return min === 0 ? { source: '[]', scalars: 0 } : null;
  }
  if (type === 'null') return { source: 'null', scalars: 1 };
  return null;
}

/** Where `name` sits in {@link PREFERRED_EXAMPLE_TOOLS}; past the end when absent. */
function preference(name: string): number {
  const index = PREFERRED_EXAMPLE_TOOLS.findIndex((p) => name === p || name.endsWith(`.${p}`) || name.endsWith(`_${p}`));
  return index === -1 ? PREFERRED_EXAMPLE_TOOLS.length : index;
}

/**
 * The namespace, a callable name and a working call for this connection.
 *
 * This connection's OWN namespace is used when it has any tools: a third-party
 * `.tool` is a worse example than a core tool, since what an agent most needs
 * demonstrated is how to reach the knowledge base.
 */
export function chainExample(namespace: string, tools: readonly ChainExampleTool[]): ChainExample {
  const ns = sanitizeIdentifier(namespace);
  const callable = tools
    .map((t) => ({ name: utcpNameToTsInterfaceName(t.utcpName), schema: t.inputSchema }))
    // Sorted so that every tie below breaks the same way on every request —
    // a description that changed between two listings of the same catalog
    // would be its own small puzzle.
    .sort((a, b) => a.name.localeCompare(b.name));
  const own = callable.filter((t) => t.name.startsWith(`${ns}.`));
  const pool = own.length > 0 ? own : callable;
  // The NAME example. `read_file` is preferred because every surface has it
  // and an agent reading the description recognises it; printed without
  // arguments, so its required `branch` is not at stake here.
  const name = pool.find((t) => t.name.endsWith('read_file'))?.name ?? pool[0]?.name ?? `${ns}.read_file`;
  // The CALL example: the simplest call the catalog fully determines.
  let best: { name: string; value: WrittenValue } | undefined;
  for (const tool of pool) {
    const value = satisfyingValue(tool.schema, 0);
    if (!value) continue;
    if (
      !best ||
      value.scalars < best.value.scalars ||
      (value.scalars === best.value.scalars && preference(tool.name) < preference(best.name))
    ) {
      best = { name: tool.name, value };
    }
  }
  return { namespace: ns, name, call: best ? `${best.name}(${best.value.source})` : null };
}
