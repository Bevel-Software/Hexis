import {
  KNOWLEDGE_BASE_DIR,
  reservedRootDirNames,
  type FileTreeEntry,
} from '@bevel-software/platform-shared';
import type { PendingEntry } from '../state/workspace.context';

// RESERVED is not the same as CREATED (see kb-layout.ts): core only seeds
// KnowledgeBase/, Skills/ and Plugins/, but every reserved name renders as its
// own root when present — a distribution that owns the execution layer seeds
// Data/, Agents/ and Pipelines/, and a KB that has them must not see them
// folded into Knowledge as stray content. A function, not a module-scope set:
// three of the names are configurable and arrive after this module loads.
export const KB_ROOT_DIRS = {
  has: (name: string): boolean => reservedRootDirNames().has(name),
};

/**
 * The repository checkout inside the workspace tree: the direct child of the
 * workspace root named by the deployment (`workspace.kbDirName`, which the
 * bootstrap response already carries), or null when it is not there.
 *
 * A LOOKUP, not a search. This used to descend the tree until it met a node
 * whose children included a well-known root name (`KnowledgeBase/`,
 * `Plugins/`, …) — which is a guess, and on core-staging it guessed the
 * WORKSPACE ROOT, because a stray `KnowledgeBase/` had been written beside
 * the checkout. Every sidebar then read that directory: the stray became
 * "Knowledge", the real checkout was folded in beneath it as ordinary
 * content, and the Skills tree found no `Skills/` at all. The deployment
 * NAMES the folder, so nothing has to be inferred from what happens to sit
 * next to it.
 *
 * Null is an answer, not a cue to look elsewhere: the caller shows the
 * empty-workspace state rather than rendering some other directory's
 * contents (see `CHECKOUT_MISSING_MESSAGE`).
 */
export function checkoutRoot(
  tree: FileTreeEntry | null,
  kbDirName: string | null,
): FileTreeEntry | null {
  if (!tree?.children || !kbDirName) return null;
  return tree.children.find((c) => c.type === 'directory' && c.name === kbDirName) ?? null;
}

/**
 * Whether the tree shows the caller anything of the knowledge base at all.
 * What does not count: the reserved root folders themselves (every knowledge
 * base has them, and the server keeps them visible even to a reader who may
 * open nothing inside), and the root `.bevelignore` an admin sees in a
 * knowledge base nobody has written to yet. Anything else — a file, or a
 * folder, at any depth — is an entry on screen.
 *
 * Read from the checkout down, like every other surface. A workspace whose
 * checkout is missing shows nothing, whatever else was written beside it.
 */
export function treeHasVisibleEntries(tree: FileTreeEntry | null, kbDirName: string | null): boolean {
  const kbRoot = checkoutRoot(tree, kbDirName);
  if (!kbRoot) return false;
  return (kbRoot.children ?? []).some((c) => {
    if (c.type === 'file') return c.name !== '.bevelignore';
    return !KB_ROOT_DIRS.has(c.name) || (c.children?.length ?? 0) > 0;
  });
}

/** Documents, as opposed to the data, config and archives beside them. */
const READABLE_PAGE = /\.(md|markdown)$/i;

/**
 * An `access.md` is a document by extension only: it is a folder's
 * access-control rules, and it sits INSIDE the knowledge tree (every plugin
 * and any governed folder carries one), so the root-file exclusion below
 * never reaches it. Nobody opens a knowledge base to read who may edit it.
 */
const ACCESS_RULES_FILE = 'access.md';
const isAccessRulesFile = (entry: FileTreeEntry): boolean => entry.name.toLowerCase() === ACCESS_RULES_FILE;

/**
 * Pages worth offering to someone who has nothing open: the documents nearest
 * the top of the knowledge tree, breadth-first, so the opening suggestion is a
 * section heading rather than the fifth file inside the first folder.
 *
 * Scoped to exactly what the explorer browses under "Knowledge", and scoped
 * to the CHECKOUT: `KnowledgeBase/` plus any content folder beside it inside
 * `<kbDirName>/`. `Plugins/` is the Skills & Tools app's storage and is not a
 * browsing destination here, and the loose files at the checkout root
 * (`access.md`, `roles.yaml`) are how the deployment is configured, not
 * something to read. A clone that predates the split has no named roots at
 * all, so its whole checkout is the knowledge — including the loose files at
 * its root, which in that layout are pages rather than configuration. A
 * workspace with no checkout in it has nothing to offer.
 *
 * Fewer than `limit` — including none at all — is a legitimate answer for a
 * knowledge base that is still empty; the caller says so rather than padding.
 */
export function suggestedPages(
  tree: FileTreeEntry | null,
  kbDirName: string | null,
  limit: number,
): FileTreeEntry[] {
  const kbRoot = checkoutRoot(tree, kbDirName);
  const split = kbRoot?.children?.some((c) => c.type === 'directory' && KB_ROOT_DIRS.has(c.name));
  const roots = !kbRoot
    ? []
    : split
      ? [
          ...(kbRoot.children ?? []).filter((c) => c.type === 'directory' && c.name === KNOWLEDGE_BASE_DIR),
          ...(kbRoot.children ?? []).filter((c) => c.type === 'directory' && !KB_ROOT_DIRS.has(c.name)),
        ]
      : [kbRoot];

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
        if (READABLE_PAGE.test(entry.name) && !isAccessRulesFile(entry)) pages.push(entry);
      } else if (level === roots || !KB_ROOT_DIRS.has(entry.name)) {
        // Below the roots, the reserved SET decides — not two names: a folder
        // named after any reserved root, at any depth, is the same kind of
        // thing the root selection above keeps out. The roots themselves are
        // the selection's own answer (Knowledge is a reserved name too).
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

/**
 * Return the tree without one exact workspace-relative path. Reuses untouched
 * branches so a caller can apply it on every render without cloning the whole
 * file tree when the server has already filtered the path.
 */
export function omitPathFromTree(
  tree: FileTreeEntry | null,
  relativePath: string,
): FileTreeEntry | null {
  if (!tree || tree.relativePath === relativePath) return null;
  if (!tree.children) return tree;

  let changed = false;
  const children: FileTreeEntry[] = [];
  for (const child of tree.children) {
    const visible = omitPathFromTree(child, relativePath);
    if (visible !== child) changed = true;
    if (visible) children.push(visible);
  }
  return changed ? { ...tree, children } : tree;
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
