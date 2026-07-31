/**
 * Top-level layout of the KB repo (inside the `KB_DIR_NAME` clone).
 *
 * The repo root holds a small, fixed set of special folders that the app
 * treats distinctly:
 *
 *   <kbDirName>/
 *   ├── KnowledgeBase/   ← all team ontologies live here (the knowledge graph)
 *   ├── Data/            ← agent-produced records; parsed like KnowledgeBase/
 *   ├── Agents/          ← .agent files — agent role configurations (not the graph)
 *   ├── Pipelines/       ← .pipeline files — execution-layer processes (not the graph)
 *   ├── Groups/          ← one folder per group; each holds BOTH skills and tools
 *   ├── roles.yaml       ← identity → role mapping
 *   └── access.md        ← repo-root access-control rules
 *
 * These names are the single source of truth for both sides of the app:
 *  - Backend: the graph parser discovers ontologies under the
 *    {@link ONTOLOGY_ROOTS} (`KnowledgeBase/` and `Data/`); `Groups/`,
 *    `Agents/`, `Pipelines/` (and anything else at the root) are ignored by
 *    parsing, validation, and the diagram.
 *  - Frontend: the file tree renders these root folders as distinct
 *    top-level sections.
 *
 * Don't hard-code these strings elsewhere — import them from here.
 */

/** Folder under the repo root that contains all team ontologies. */
export const KNOWLEDGE_BASE_DIR = 'KnowledgeBase';

/**
 * Folder under the repo root that holds the groups.
 *
 *   Groups/<Group>/<skill>/SKILL.md   a skill
 *   Groups/<Group>/<name>.tool        a tool manual
 *   Groups/<Group>/access.md          who can read/write the whole group
 *
 * One folder is one group. Skills and tools live TOGETHER inside it because
 * they share a single access boundary: a tool a group cannot read is a skill
 * that group cannot run, so splitting them across two roots meant maintaining
 * the same permission twice and letting them drift.
 *
 * A group is not a registry of unique names — it is a folder. The same
 * integration may exist in several groups as separate files (`Everyone/
 * notion.tool` and `Finance/notion.tool`), each with its own credentials and
 * its own access rule. That duplication is the design, not an accident.
 */
export const GROUPS_DIR = 'Groups';

/**
 * Pre-merge roots, still read so the app keeps working against a KB that has
 * not been migrated yet.
 *
 * DELETE both, and the fallbacks that reference them, once the KB repo's
 * migration lands. They exist only so the code change and the content change
 * can ship independently — re-pointing the scanners at `Groups/` before the
 * repo has one would empty the catalog rather than fail loudly.
 */
export const LEGACY_SKILLS_DIR = 'Skills';
export const LEGACY_TOOLS_DIR = 'Tools';

/**
 * Every root whose direct subfolders are groups.
 *
 * The legacy pair is included so grouping works against an unmigrated KB:
 * `Skills/GTM/…` and `Groups/GTM/…` both report `GTM`, which is what lets the
 * UI ship its group navigation before the content moves.
 */
export const GROUP_ROOTS: readonly string[] = [
  GROUPS_DIR,
  LEGACY_SKILLS_DIR,
  LEGACY_TOOLS_DIR,
];

/**
 * The group a repo-root-relative path belongs to, or `null` for content that
 * sits outside any group.
 *
 *   Groups/GTM/heyreach-campaign/SKILL.md → 'GTM'
 *   Groups/GTM/heyreach.tool              → 'GTM'
 *   Skills/GTM/heyreach-campaign          → 'GTM'   (pre-migration)
 *   Groups/loose-skill/SKILL.md           → null    (no group folder)
 *   Tools/slack.tool                      → null    (ditto)
 *   KnowledgeBase/Product/…               → null    (not a group root)
 *
 * Returns null rather than throwing because a group is a property SOME paths
 * have. Callers bucket by it; nothing requires it. An ungrouped skill is a
 * real, supported state — the prototype calls those "yours alone".
 */
export function groupOfPath(repoRelativePath: string): string | null {
  const segments = repoRelativePath.split('/').filter(Boolean);
  if (!segments[0] || !GROUP_ROOTS.includes(segments[0])) return null;
  // Needs a segment for the group AND at least one below it, otherwise
  // `Groups/GTM` (the folder itself) would report itself as being in a group,
  // and `Tools/slack.tool` would report a group named "slack.tool".
  return segments.length >= 3 ? (segments[1] ?? null) : null;
}

/**
 * Folder under the repo root for agent-produced records (pipeline instances,
 * work items, intermediate outputs). Parsed exactly like `KnowledgeBase/`:
 * its direct subfolders are self-contained ontologies.
 */
export const DATA_DIR = 'Data';

/** Folder under the repo root that holds `.agent` files — agent role configurations (not graph nodes). */
export const AGENTS_DIR = 'Agents';

/** Folder under the repo root that holds `.pipeline` files — execution-layer processes (not graph nodes). */
export const PIPELINES_DIR = 'Pipelines';

/**
 * The roots whose subfolders are discovered as ontologies by the graph parser
 * (each subfolder with both `NodeTypes/` and `Knowledge/` is an ontology).
 */
export const ONTOLOGY_ROOTS: readonly string[] = [KNOWLEDGE_BASE_DIR, DATA_DIR];

/** The `Knowledge/` marker subfolder of an ontology (holds the graph nodes). */
export const KNOWLEDGE_DIR = 'Knowledge';

/** The `NodeTypes/` marker subfolder of an ontology (holds the type definitions). */
export const NODETYPE_DIR = 'NodeTypes';

/** The marker subfolders that make a directory an ontology (it needs BOTH). */
export const ONTOLOGY_MARKERS = new Set([KNOWLEDGE_DIR, NODETYPE_DIR]);

/**
 * A named ontology id, or `null` for the neutral bucket — content that belongs
 * to no named ontology (root config, `Skills/`, root-level `Knowledge/`, etc.).
 * The named id is the repo-root-relative path of the ontology directory,
 * e.g. `KnowledgeBase/Product` or `KnowledgeBase/IT Architecture`.
 */
export type Ontology = string | null;

// The implementation that resolves a path to its `Ontology` (`ontologyOf`) is
// backend-only — it lives in `packages/backend/src/shared/kb-layout.ts`, built
// from the `KNOWLEDGE_BASE_DIR` / `ONTOLOGY_MARKERS` constants above. This
// package holds only the cross-cutting constants and types, not logic.
