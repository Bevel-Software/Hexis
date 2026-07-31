/**
 * Shared identity helpers for the KB's `---`-frontmatter files, so tool manuals,
 * skills, and node id-links all resolve identity the SAME way: a frontmatter `id`,
 * then `name`, then a caller-supplied fallback (folder/filename). One grammar
 * (lowercase `snake_case`) and one dedup rule (refuse duplicates) across all three.
 * The `---` splitter itself lives in `@bevel-software/platform-shared` (used by the
 * frontend too); re-exported here so backend callers keep one import site.
 */
import { extractFrontmatter } from '@bevel-software/platform-shared';

export { extractFrontmatter };

/**
 * Extract a node's stable frontmatter `id` — the short token nodes cross-reference
 * with (`[text](<id>)`). Null when the file has no leading `---` block or no `id:`
 * scalar in it. Keeps the lowercase-kebab grammar the renderer's id-link uses, so
 * any id this returns round-trips as a citation link. (Node-specific; tools/skills
 * read `id`/`name` from the PARSED frontmatter via {@link resolveDeclaredId}.)
 */
export function extractFrontmatterId(markdown: string): string | null {
  const fm = extractFrontmatter(markdown);
  if (!fm) return null;
  for (const line of fm.frontmatter.split(/\r?\n/)) {
    const m = line.match(/^id:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/);
    if (m) return m[1];
  }
  return null;
}

/** The ONE identity rule: frontmatter `id`, else `name`, else the caller's fallback. */
export function resolveDeclaredId(frontmatter: Record<string, unknown>, fallback: string): string {
  const id = typeof frontmatter.id === 'string' ? frontmatter.id.trim() : '';
  if (id) return id;
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (name) return name;
  return fallback;
}

/**
 * The canonical id grammar: lowercase `snake_case`. Enforced for tool manual ids
 * because the id is used VERBATIM as the UTCP variable namespace, whose grammar is
 * `[a-zA-Z0-9_]+` (underscores ok, hyphens rejected). Skills/nodes don't carry this
 * constraint, so they don't validate against it.
 */
export function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_]*$/.test(id);
}

/**
 * The ONE dedup rule: keep the first occurrence of each id, REFUSE later duplicates
 * (skip + `onDuplicate`). Callers pass items in a deterministic order (e.g. sorted by
 * path) so the winner is stable. Replaces tools' bespoke collision check and skills'
 * auto-suffix with one shared behaviour.
 */
export function dedupeById<T>(
  items: T[],
  keyOf: (item: T) => string,
  onDuplicate?: (item: T, id: string) => void,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = keyOf(item);
    if (seen.has(id)) {
      onDuplicate?.(item, id);
      continue;
    }
    seen.add(id);
    out.push(item);
  }
  return out;
}
