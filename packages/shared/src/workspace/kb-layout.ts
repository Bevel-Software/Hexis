import { branchSegment } from '../git/branchAuthor.js';

/**
 * Top-level layout of the KB repo (inside the `KB_DIR_NAME` clone).
 *
 * The repo root holds a small, fixed set of special folders that the app
 * treats distinctly:
 *
 *   <kbDirName>/
 *   ├── KnowledgeBase/   ← all team ontologies live here (the knowledge graph)
 *   ├── Plugins/         ← one folder per plugin; each holds BOTH skills and tools
 *   ├── Data/            ← agent-produced records; parsed like KnowledgeBase/
 *   ├── Agents/          ← .agent files — agent role configurations (not the graph)
 *   ├── Pipelines/       ← .pipeline files — execution-layer processes (not the graph)
 *   ├── roles.yaml       ← identity → role mapping
 *   └── access.md        ← repo-root access-control rules
 *
 * RESERVED IS NOT THE SAME AS CREATED. Core seeds the first two only
 * (`CORE_REQUIRED_DIRS`); `Data/`, `Agents/` and `Pipelines/` scaffold an
 * agentic execution layer that a distribution layers on. Their names stay here
 * regardless, because reserving a name is what stops a KB that HAS the folder
 * from having it treated as ordinary content — the file tree would otherwise
 * fold it into Knowledge as a stray directory.
 *
 * These names are the single source of truth for both sides of the app:
 *  - Backend: the graph parser discovers ontologies under the
 *    {@link ONTOLOGY_ROOTS} (`KnowledgeBase/` and `Data/`); `Plugins/`,
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
 * Folder under the repo root that holds the plugins.
 *
 *   Plugins/<Plugin>/plugin.json                  the Agent Plugins manifest
 *   Plugins/<Plugin>/skills/<skill>/SKILL.md      a skill
 *   Plugins/<Plugin>/mcp.json                     MCP servers
 *   Plugins/<Plugin>/software.bevel.hexis/tools/  http + inline `.tool` manuals
 *   Plugins/<Plugin>/access.md                    who can read/write the plugin
 *
 * Each folder is one plugin, laid out per the Agent Plugins specification
 * (https://agent-plugins.org, v1.0.0) so another conformant client can load it:
 * it finds the manifest, the skills and the MCP servers, and ignores everything
 * under the reverse-DNS extension directory.
 *
 * Two parts of a plugin are ours and deliberately outside the portable core:
 *
 *  - `access.md`, which must sit at the PLUGIN ROOT. Access resolution walks
 *    repo root → file directory accumulating rules, so the same file one level
 *    down would govern only that subtree — silently narrowing what it protects.
 *  - `software.bevel.hexis/tools/*.tool`, the UTCP manuals whose `http` and
 *    `inline` types the spec has no slot for. `mcp`-type manuals are emitted as
 *    real `mcp.json` entries instead, so the portable half stays portable.
 *
 * Skills and tools live TOGETHER in one plugin because they share a single
 * access boundary: a tool a plugin cannot read is a skill that plugin cannot
 * run, so splitting them across two roots meant maintaining the same permission
 * twice and letting them drift.
 *
 * A plugin is not a registry of unique names — it is a folder. The same
 * integration may exist in several plugins as separate files (`Everyone/…/
 * notion.tool` and `Finance/…/notion.tool`), each with its own credentials and
 * its own access rule. That duplication is the design, not an accident.
 *
 * The DIRECTORY name is unconstrained by the spec (§4.1 — a plugin is located
 * by path, and the name carries no meaning to a client), so folders keep their
 * display casing. The lowercase slug the spec does constrain lives in the
 * manifest's `name` field.
 */
export const PLUGINS_DIR = 'Plugins';

/**
 * The pre-rename name of {@link PLUGINS_DIR}. Referenced ONLY by the migration
 * that renames it — every other consumer should be reading the new name, and a
 * second live spelling is exactly how two layouts start being supported by
 * accident.
 */
export const LEGACY_GROUPS_DIR = 'Groups';

/** The manifest that makes a directory a plugin (Agent Plugins §4.1). */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

/** The MCP server configuration a conformant client reads (Agent Plugins §8). */
export const PLUGIN_MCP_FILE = 'mcp.json';

/** Where a plugin's skills live, one folder each (Agent Plugins §7.1). */
export const PLUGIN_SKILLS_DIR = 'skills';

/**
 * Our reverse-DNS extension namespace. The spec reserves these directories for
 * exactly this — client-specific behaviour that a portable core should not
 * carry — so anything a conformant third-party client has no way to interpret
 * goes here rather than loose in the plugin root.
 */
export const HEXIS_EXTENSION_NS = 'software.bevel.hexis';

/** UTCP manuals whose `http`/`inline` types the spec cannot express. */
export const HEXIS_TOOLS_DIR = `${HEXIS_EXTENSION_NS}/tools`;

/**
 * The manifest `name` for a plugin folder: lowercased, anything outside
 * `[a-z0-9.-]` folded to `-`, runs collapsed, ends trimmed to alphanumerics.
 *
 * The schema's pattern is `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`
 * — so a folder like `personal-<user-id>` whose sanitized id happens to contain
 * a doubled separator would produce an INVALID manifest, which is fatal to a
 * conformant client. Collapsing runs is what makes that unrepresentable rather
 * than merely unlikely.
 */
export function pluginManifestName(folderName: string): string {
  const slug = folderName
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, '');
  // Every character can be stripped (a folder named `---`), and `name` is
  // required — fall back rather than emit a manifest that fails validation.
  return slug || 'plugin';
}

/** The schema a v1.0.0 manifest declares, and the version both files must agree on. */
export const AGENT_PLUGINS_SCHEMA_VERSION = '1.0.0';
export const PLUGIN_MANIFEST_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGINS_SCHEMA_VERSION}/plugin.schema.json`;
export const PLUGIN_MCP_SCHEMA = `https://agent-plugins.org/schemas/${AGENT_PLUGINS_SCHEMA_VERSION}/mcp.schema.json`;

/**
 * A minimal, valid `plugin.json` for a plugin folder.
 *
 * Deliberately only the two required fields. `version`, `license` and the rest
 * are optional metadata about a DISTRIBUTED package, and inventing values for a
 * folder someone just made in the app would be asserting things nobody said —
 * a plugin here is a place a team keeps skills, not something published.
 *
 * The display name is the folder, which is why nothing here carries one: the
 * manifest's `name` is constrained to a lowercase slug, and the field set is
 * closed, so there is no conformant home for "Sales" other than an extension.
 */
export function renderPluginManifest(folderName: string): string {
  return `${JSON.stringify(
    { $schema: PLUGIN_MANIFEST_SCHEMA, name: pluginManifestName(folderName) },
    null,
    2,
  )}\n`;
}

/**
 * The reserved name prefix marking a personal folder under `Plugins/` —
 * `Plugins/personal-<user-id>/` is where a person's own skills live: created
 * implicitly on their first personal skill, private by default (its seeded
 * `access.md` names only its owner), and never listed as a group.
 *
 * The marker is STRUCTURAL on purpose: every surface that enumerates groups
 * (catalog scan, sidebar, counts) filters on the name alone, with no access
 * lookup needed, and the plugin-creation endpoint refuses names carrying the
 * prefix — so a regular plugin can never squat on someone's personal folder.
 */
export const PERSONAL_PLUGIN_PREFIX = 'personal-';

/**
 * The one personal folder name for a user — keyed to the STABLE user id, not
 * the email: emails change, and a folder keyed to one would be orphaned the
 * day it does. Ids are opaque, so the name carries no PII into git history
 * (which this platform never rewrites). `branchSegment` is THE segment
 * sanitizer — the id lands in the folder name exactly as it lands in the
 * user's suggestion-branch names, so the two spellings can never disagree.
 */
export function personalPluginFolderName(userId: string): string {
  return `${PERSONAL_PLUGIN_PREFIX}${branchSegment(userId)}`;
}

/** Whether a `Plugins/` child is somebody's personal folder. */
export function isPersonalPluginFolder(folderName: string): boolean {
  return folderName.startsWith(PERSONAL_PLUGIN_PREFIX);
}

/**
 * The plugin a repo-root-relative path belongs to, or `null` for content that
 * sits outside any plugin.
 *
 *   Plugins/GTM/skills/heyreach-campaign/SKILL.md → 'GTM'
 *   Plugins/GTM/mcp.json                          → 'GTM'
 *   Plugins/loose-skill/SKILL.md                  → 'loose-skill' (the folder IS the plugin)
 *   KnowledgeBase/Product/…                       → null    (not a plugin root)
 *
 * Returns null rather than throwing because a plugin is a property SOME paths
 * have. Callers bucket by it; nothing requires it. A plugin-less skill is a
 * real, supported state — the prototype calls those "yours alone".
 */
export function pluginOfPath(repoRelativePath: string): string | null {
  const segments = repoRelativePath.split('/').filter(Boolean);
  if (segments[0] !== PLUGINS_DIR) return null;
  // Needs a segment for the plugin AND at least one below it, otherwise
  // `Plugins/GTM` (the folder itself) would report itself as being in a plugin,
  // and a loose `Plugins/slack.tool` would report a plugin named "slack.tool".
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
 * to no named ontology (root config, `Groups/`, root-level `Knowledge/`, etc.).
 * The named id is the repo-root-relative path of the ontology directory,
 * e.g. `KnowledgeBase/Product` or `KnowledgeBase/IT Architecture`.
 */
export type Ontology = string | null;

// The implementation that resolves a path to its `Ontology` (`ontologyOf`) is
// backend-only — it lives in `packages/backend/src/shared/kb-layout.ts`, built
// from the `KNOWLEDGE_BASE_DIR` / `ONTOLOGY_MARKERS` constants above. This
// package holds only the cross-cutting constants and types, not logic.
