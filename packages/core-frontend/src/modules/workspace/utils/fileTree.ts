import {
  AGENTS_DIR,
  DATA_DIR,
  KNOWLEDGE_BASE_DIR,
  PIPELINES_DIR,
  PLUGINS_DIR,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import type { PendingEntry } from '../state/workspace.context';

// RESERVED is not the same as CREATED (see kb-layout.ts): core only seeds
// KnowledgeBase/ and Plugins/, but every reserved name renders as its own root
// when present — a distribution that owns the execution layer seeds Data/,
// Agents/ and Pipelines/, and a KB that has them must not see them folded
// into Knowledge as stray content.
export const KB_ROOT_DIRS = new Set([
  KNOWLEDGE_BASE_DIR,
  DATA_DIR,
  AGENTS_DIR,
  PIPELINES_DIR,
  PLUGINS_DIR,
]);

/**
 * Descend past the workspace / KB-clone wrapper levels to the node that holds
 * the well-known KB root dirs (`KnowledgeBase/`, `Data/`, `Agents/`, …), or
 * null when the tree predates the split. Shared by the explorer's sectioning
 * and registry-contributed explorer items (e.g. the enterprise Graph view).
 */
export function findKbRoot(node: FileTreeEntry | null): FileTreeEntry | null {
  if (!node?.children) return null;
  const holdsSplit = node.children.some(
    (c) => c.type === 'directory' && KB_ROOT_DIRS.has(c.name),
  );
  if (holdsSplit) return node;
  for (const child of node.children) {
    if (child.type === 'directory') {
      const found = findKbRoot(child);
      if (found) return found;
    }
  }
  return null;
}

/** Documents, as opposed to the data, config and archives beside them. */
const READABLE_PAGE = /\.(md|markdown)$/i;

/**
 * Pages worth offering to someone who has nothing open: the documents nearest
 * the top of the knowledge tree, breadth-first, so the opening suggestion is a
 * section heading rather than the fifth file inside the first folder.
 *
 * Scoped to exactly what the explorer browses under "Knowledge" —
 * `KnowledgeBase/` plus any stray content folder. `Groups/` is the Skills &
 * Tools app's storage and is not a browsing destination here, and the loose
 * files at the root (`access.md`, `roles.yaml`) are how the deployment is
 * configured, not something to read. A clone that predates the split has no
 * named roots to scope to, so its whole tree is the knowledge.
 *
 * Fewer than `limit` — including none at all — is a legitimate answer for a
 * knowledge base that is still empty; the caller says so rather than padding.
 */
export function suggestedPages(tree: FileTreeEntry | null, limit: number): FileTreeEntry[] {
  const kbRoot = findKbRoot(tree);
  const roots = kbRoot?.children
    ? [
        ...kbRoot.children.filter((c) => c.type === 'directory' && c.name === KNOWLEDGE_BASE_DIR),
        ...kbRoot.children.filter((c) => c.type === 'directory' && !KB_ROOT_DIRS.has(c.name)),
      ]
    : tree
      ? [tree]
      : [];

  const pages: FileTreeEntry[] = [];
  let level = roots;
  while (level.length > 0 && pages.length < limit) {
    const next: FileTreeEntry[] = [];
    for (const entry of level) {
      // Enough pages is enough work: without this, the last level scanned is
      // walked to its end — every remaining sibling tested and pushed — for
      // pages the final slice would throw away.
      if (pages.length >= limit) break;
      // Dot-prefixed entries are the repository's own bookkeeping.
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'file') {
        if (READABLE_PAGE.test(entry.name)) pages.push(entry);
      } else if (entry.name !== GROUPS_DIR) {
        next.push(...(entry.children ?? []));
      }
    }
    level = next;
  }
  return pages.slice(0, limit);
}

function findEntryByPath(tree: FileTreeEntry | null, relativePath: string): FileTreeEntry | null {
  if (!tree) return null;
  if (tree.relativePath === relativePath) return tree;
  if (tree.children) {
    for (const child of tree.children) {
      const found = findEntryByPath(child, relativePath);
      if (found) return found;
    }
  }
  return null;
}

export function pathExistsInTree(tree: FileTreeEntry | null, relativePath: string): boolean {
  return findEntryByPath(tree, relativePath) !== null;
}

function collectFilesByBasename(tree: FileTreeEntry | null, basename: string, acc: string[]): void {
  if (!tree) return;
  if (tree.type === 'file' && tree.name === basename) acc.push(tree.relativePath);
  if (tree.children) {
    for (const child of tree.children) collectFilesByBasename(child, basename, acc);
  }
}

/**
 * Resolve a candidate path to a concrete workspace-relative path.
 * - Multi-segment candidates (contain `/`) must match an existing entry exactly.
 * - Single-segment candidates (e.g. `positioning.md`) also match if exactly one
 *   file in the tree has that basename — handles agent shorthand after a full
 *   path was already mentioned in the same turn. Ambiguous basenames stay null.
 */
/**
 * Merge optimistic pending-upload entries into a server-sourced file tree
 * so the FileExplorer can render dropped/picked files within one frame of
 * the user's action — well before their server commits have echoed back.
 *
 * Pending entries whose paths already exist on the server are skipped (the
 * real entry wins). Missing parent directories along the way are
 * synthesized as directory entries so a single dropped file inside a brand
 * new folder renders the folder too.
 *
 * Returns a freshly-allocated tree; the input is not mutated. Children at
 * each level are re-sorted so synthesized entries appear in the same order
 * a server refresh would render them: directories first, then files,
 * alphabetical within each group.
 */
export function mergePendingIntoTree(
  tree: FileTreeEntry,
  pending: Map<string, PendingEntry>,
): FileTreeEntry {
  if (pending.size === 0) return tree;

  const cloneNode = (node: FileTreeEntry): FileTreeEntry => ({
    name: node.name,
    relativePath: node.relativePath,
    type: node.type,
    children: node.children ? node.children.map(cloneNode) : undefined,
  });
  const root = cloneNode(tree);

  // Walk to (and create) the directory at `path`. Returns null if `path`
  // collides with an existing file along the way.
  const ensureDir = (path: string): FileTreeEntry | null => {
    if (!path || path === '.') return root;
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const segPath = parts.slice(0, i + 1).join('/');
      if (!node.children) node.children = [];
      let child = node.children.find((c) => c.relativePath === segPath);
      if (!child) {
        child = {
          name: parts[i],
          relativePath: segPath,
          type: 'directory',
          children: [],
        };
        node.children.push(child);
      } else if (child.type !== 'directory') {
        return null;
      } else if (!child.children) {
        child.children = [];
      }
      node = child;
    }
    return node;
  };

  for (const [fullPath, entry] of pending) {
    const parts = fullPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    if (!parent) continue;
    if (!parent.children) parent.children = [];
    if (parent.children.some((c) => c.relativePath === fullPath)) continue;
    parent.children.push({
      name,
      relativePath: fullPath,
      type: entry.type,
      children: entry.type === 'directory' ? [] : undefined,
    });
  }

  // Re-sort every level so synthesized entries appear in tree order.
  const sort = (node: FileTreeEntry) => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sort(c);
  };
  sort(root);

  return root;
}

export function resolveWorkspacePath(tree: FileTreeEntry | null, candidate: string): string | null {
  if (!tree || !candidate) return null;
  // The agent may emit either raw paths (`Knowledge/0. Current Truth/x.md`) or
  // percent-encoded ones (`Knowledge/0.%20Current%20Truth/x.md`) — react-markdown
  // hands us whatever was inside the link destination, so decode defensively.
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    // Malformed escape sequence — fall back to the raw candidate.
  }
  const normalized = decoded.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (!normalized) return null;
  const entry = findEntryByPath(tree, normalized);
  if (entry?.type === 'file') return normalized;
  if (normalized.includes('/')) return null;
  const matches: string[] = [];
  collectFilesByBasename(tree, normalized, matches);
  return matches.length === 1 ? matches[0] : null;
}
