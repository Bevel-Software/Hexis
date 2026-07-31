import { parseDocument } from 'yaml';

export type FrontmatterData = Record<string, string | string[]>;

/**
 * Render a non-string scalar / nested value into a readable string for the
 * frontmatter panel (which only displays `string | string[]`). `seen` guards
 * against circular references — YAML anchors/aliases (`a: &x { b: *x }`) make
 * `toJS()` return a cyclic object, which would otherwise recurse forever.
 */
function scalarToString(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => scalarToString(v, seen)).join(', ');
    // Nested map (e.g. `metadata:`) — render as `key: value` pairs.
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${scalarToString(v, seen)}`)
      .join(', ');
  }
  return String(value);
}

/** Coerce a parsed YAML value into the panel's `string | string[]` shape. */
function coerce(value: unknown): string | string[] {
  if (Array.isArray(value)) {
    const seen = new WeakSet<object>([value]);
    return value.map((v) => scalarToString(v, seen));
  }
  return scalarToString(value);
}

/**
 * Parse YAML frontmatter from a markdown string using a real YAML parser, so
 * block scalars (`|` / `>`), quoted strings, nested maps and lists all parse
 * correctly. Values are coerced to `string | string[]` for the frontmatter
 * panel. Returns the parsed data and the body without the frontmatter block.
 *
 * Resilient by design: `parseDocument` collects errors instead of throwing, so
 * a single malformed entry never blanks the whole block — the entries that DO
 * parse are still returned. This matters because the same frontmatter shape can
 * carry access entries that must always surface.
 */
export function parseFrontmatter(content: string): { data: FrontmatterData; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };

  const body = match[2].trimStart();
  const data: FrontmatterData = {};

  let parsed: unknown;
  try {
    // `parseDocument` collects errors instead of throwing, and `.toJS()` returns
    // the best-effort value of whatever parsed — so a single malformed entry
    // doesn't blank the block. (`.toJS()` itself can still throw, e.g. on an
    // alias bomb; the catch keeps the body readable.)
    parsed = parseDocument(match[1]).toJS();
  } catch {
    return { data: {}, body };
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      data[key] = coerce(value);
    }
  }

  return { data, body };
}

/** Human-readable label for a camelCase frontmatter key */
export function labelFor(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}
