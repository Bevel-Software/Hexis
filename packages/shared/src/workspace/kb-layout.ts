import { branchSegment } from '../git/branchAuthor.js';

/**
 * Top-level layout of the KB repo (inside the `KB_DIR_NAME` clone).
 *
 * The repo root holds a small, fixed set of special folders that the app
 * treats distinctly:
 *
 *   <kbDirName>/
 *   ├── KnowledgeBase/   ← all team ontologies live here (the knowledge graph)
 *   ├── Skills/          ← shared skills, organised by ownership; plugins LINK to them
 *   ├── Plugins/         ← one folder per plugin: manifest, MCP servers, tools, links
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
 *    {@link ontologyRoots} (`KnowledgeBase/` and `Data/`); `Plugins/`,
 *    `Agents/`, `Pipelines/` (and anything else at the root) are ignored by
 *    parsing, validation, and the diagram.
 *  - Frontend: the file tree renders these root folders as distinct
 *    top-level sections.
 *
 * Don't hard-code these strings elsewhere — import them from here.
 *
 * CONFIGURABLE, WITH DEFAULTS. The three roots a deployment may rename
 * (`KnowledgeBase/`, `Skills/`, `Plugins/`) are `let` bindings applied by
 * {@link configureKbLayout} — the backend from its deployment settings, the
 * browser from `GET /api/config` — the same live-binding pattern as the branch
 * model in `git/protected.ts`. Unlike the branch model they carry defaults, so
 * nothing has to wait for configuration; but the same rule applies: read them
 * inside a function body, never capture one at module scope.
 */

/** Folder under the repo root that contains all team ontologies. */
export let KNOWLEDGE_BASE_DIR = 'KnowledgeBase';

/**
 * Folder under the repo root that holds SHARED skills, organised by ownership:
 *
 *   Skills/<scope>/…/<skill>/SKILL.md     a skill, at any depth
 *   Skills/<scope>/access.md              who owns / may read the scope
 *
 * A skill's readability comes from ITS OWN path walk — the scope folders'
 * `access.md` files — never from the plugins that link it. Plugins point at
 * skills here by path (see `HEXIS_LINKED_SKILLS_KEY`), so one definition can
 * ship in several plugins, and a skill in no plugin at all is a normal state.
 * Inline skills under `Plugins/<Plugin>/skills/` remain supported (personal
 * folders, legacy layouts); the catalog is the union of both trees.
 */
export let SKILLS_DIR = 'Skills';

/**
 * Folder under the repo root that holds the plugins.
 *
 *   Plugins/<Plugin>/plugin.json                  the Agent Plugins manifest; its
 *                                                 hexis extension lists LINKED skills
 *   Plugins/<Plugin>/skills/<skill>/SKILL.md      an inline skill
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
 * A plugin's own `access.md` governs what the plugin FOLDER holds: the
 * manifest, the MCP servers, the tools, and any inline skills. Shared skills
 * under `Skills/` are governed by their own scope and are made visible to a
 * plugin's members by granting the plugin's principal (`plugin/<Name>/read`)
 * on the skill — ownership decides, the plugin is a view.
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
export let PLUGINS_DIR = 'Plugins';

/** The three renameable roots, as a deployment declares them and `/api/config` serves them. */
export interface KbLayout {
  knowledgeBaseDir: string;
  skillsDir: string;
  pluginsDir: string;
}

/** The layout a deployment gets when it names nothing. */
export const DEFAULT_KB_LAYOUT: Readonly<KbLayout> = Object.freeze({
  knowledgeBaseDir: 'KnowledgeBase',
  skillsDir: 'Skills',
  pluginsDir: 'Plugins',
});

/**
 * What is wrong with one root name, or null. A root is joined onto the repo
 * root and onto `<dir>/.gitkeep`, so a separator or `..` would write outside
 * the repository; a dot-prefixed name would be skipped by every scanner that
 * treats dot-entries as bookkeeping; `.git` in any case would corrupt the clone.
 */
export function validateKbRootName(name: string): string | null {
  const v = name.trim();
  if (!v) return 'A folder name is required.';
  if (v === '.' || v === '..' || v.includes('/') || v.includes('\\')) {
    return 'Use a single folder name — no slashes.';
  }
  if (v.startsWith('.')) return 'The name can\'t start with a dot.';
  // eslint-disable-next-line no-control-regex -- control chars cannot be a path segment
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'The name can\'t contain control characters.';
  return null;
}

/**
 * What is wrong with a layout, or null — the same rule {@link configureKbLayout}
 * enforces, without applying anything. Separate so the setup screen can judge a
 * proposed layout before it is saved. The three names must differ, compared
 * case-insensitively: the workspaces live on case-insensitive filesystems too,
 * where `Skills` and `skills` are one folder.
 */
export function validateKbLayout(layout: KbLayout): string | null {
  for (const [label, value] of [
    ['knowledge base', layout.knowledgeBaseDir],
    ['skills', layout.skillsDir],
    ['plugins', layout.pluginsDir],
  ] as const) {
    const problem = validateKbRootName(value ?? '');
    if (problem) return `The ${label} folder: ${problem}`;
  }
  const names = [layout.knowledgeBaseDir, layout.skillsDir, layout.pluginsDir].map((n) =>
    n.trim().toLowerCase(),
  );
  if (new Set(names).size !== names.length) {
    return 'The knowledge base, skills and plugins folders must have three different names.';
  }
  return null;
}

/**
 * Apply the layout. Called once during boot on each side; throws on an invalid
 * one so a bad deployment setting fails beside the rest of the wiring rather
 * than scattering a half-renamed tree. Applying the defaults is a no-op.
 */
export function configureKbLayout(layout: KbLayout): void {
  const problem = validateKbLayout(layout);
  if (problem) throw new Error(problem);
  KNOWLEDGE_BASE_DIR = layout.knowledgeBaseDir.trim();
  SKILLS_DIR = layout.skillsDir.trim();
  PLUGINS_DIR = layout.pluginsDir.trim();
}

/** The layout currently in effect. */
export function currentKbLayout(): KbLayout {
  return { knowledgeBaseDir: KNOWLEDGE_BASE_DIR, skillsDir: SKILLS_DIR, pluginsDir: PLUGINS_DIR };
}

/**
 * Render the layout placeholders a managed template carries —
 * `{{knowledgeBaseDir}}`, `{{skillsDir}}`, `{{pluginsDir}}` — with the
 * names in effect. The packaged `AGENTS.md` and `.bevelignore` are written
 * this way so a deployment that renamed its roots hands the agent a guide
 * that names the folders it will actually find. Text without placeholders
 * passes through unchanged.
 */
export function renderKbLayoutPlaceholders(text: string, layout: KbLayout = currentKbLayout()): string {
  return text
    .replaceAll('{{knowledgeBaseDir}}', layout.knowledgeBaseDir)
    .replaceAll('{{skillsDir}}', layout.skillsDir)
    .replaceAll('{{pluginsDir}}', layout.pluginsDir);
}

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
 * The manifest key under which a plugin LINKS shared skills:
 *
 *   plugin.json → extensions["software.bevel.hexis"].skills: [
 *     "Skills/Engineering/deploy",   ← one skill folder
 *     "Skills/Sales"                 ← a folder of skills: every skill beneath
 *   ]
 *
 * Entries are repo-root-relative folder paths. A plugin's effective skill set
 * is its inline `skills/` folder PLUS everything these roots resolve to. The
 * spec reserves `extensions` for exactly this kind of client-specific data, so
 * a conformant client that ignores it still gets a valid manifest; the
 * compiled distribution copies the linked skills in for it.
 *
 * Linking is a reference, not a grant: a member of the plugin can read a
 * linked skill only because the skill's own access rules name the plugin's
 * principal (`plugin/<Name>/read`). The link service writes both together.
 */
export const HEXIS_LINKED_SKILLS_KEY = 'skills';

/**
 * Normalise a linked-skill root, or null when it cannot be one: a
 * repo-root-relative POSIX folder path with no `..`, no leading slash, no
 * backslashes and no empty segments. Trailing slashes are dropped.
 */
export function normalizeSkillRoot(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\\') || trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return segments.join('/');
}

/**
 * The linked-skill roots a parsed manifest declares — invalid entries are
 * dropped, duplicates collapsed, order kept. A manifest with no extension
 * block links nothing.
 */
export function linkedSkillRoots(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return [];
  const ext = (manifest as Record<string, unknown>).extensions;
  if (typeof ext !== 'object' || ext === null) return [];
  const ns = (ext as Record<string, unknown>)[HEXIS_EXTENSION_NS];
  if (typeof ns !== 'object' || ns === null) return [];
  const raw = (ns as Record<string, unknown>)[HEXIS_LINKED_SKILLS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const root = normalizeSkillRoot(typeof entry === 'string' ? entry : '');
    if (root !== null && !out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * The manifest with its linked-skill roots REPLACED by `roots`, every other
 * byte of the object preserved (the MCP extension block beside it, the
 * portable fields above it). An empty list removes the key rather than
 * leaving `skills: []` behind.
 */
export function withLinkedSkillRoots(
  manifest: Record<string, unknown>,
  roots: readonly string[],
): Record<string, unknown> {
  const extensions =
    typeof manifest.extensions === 'object' && manifest.extensions !== null && !Array.isArray(manifest.extensions)
      ? { ...(manifest.extensions as Record<string, unknown>) }
      : {};
  const current = extensions[HEXIS_EXTENSION_NS];
  const ns: Record<string, unknown> =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  if (roots.length > 0) ns[HEXIS_LINKED_SKILLS_KEY] = [...roots];
  else delete ns[HEXIS_LINKED_SKILLS_KEY];
  if (Object.keys(ns).length > 0) extensions[HEXIS_EXTENSION_NS] = ns;
  else delete extensions[HEXIS_EXTENSION_NS];
  const out: Record<string, unknown> = { ...manifest };
  if (Object.keys(extensions).length > 0) out.extensions = extensions;
  else delete out.extensions;
  return out;
}

/** Whether `skillPath` (a skill folder) falls under `root` (a skill folder or a folder of skills). */
export function skillUnderRoot(skillPath: string, root: string): boolean {
  return skillPath === root || skillPath.startsWith(`${root}/`);
}

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
 * A function, not a constant: `KNOWLEDGE_BASE_DIR` is configurable, and a
 * module-scope array would snapshot the default before configuration.
 */
export function ontologyRoots(): readonly string[] {
  return [KNOWLEDGE_BASE_DIR, DATA_DIR];
}

/**
 * Every reserved root name, as currently configured — the set the file tree
 * renders as its own sections rather than folding into Knowledge.
 */
export function reservedRootDirNames(): ReadonlySet<string> {
  return new Set([KNOWLEDGE_BASE_DIR, SKILLS_DIR, PLUGINS_DIR, DATA_DIR, AGENTS_DIR, PIPELINES_DIR]);
}

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
