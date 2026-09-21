import { branchSegment } from '../git/branchAuthor.js';
import { PREAMBLE_FILE } from './agent-preamble.js';
import { validateFilename } from './filename.js';

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

/**
 * The file name of the platform's MANAGED agent guide at the repository root —
 * the document every connected agent is told to read first, written and
 * refreshed from the packaged template on every start.
 *
 * Configurable for one reason: `AGENTS.md` is the name coding agents look for
 * by convention, so a customer arriving with a repository of their own very
 * often already HAS one, and under the default name the platform would
 * overwrite it on the first boot and on every boot after. Renaming the managed
 * guide (`HEXIS.md`, say) hands that name back: `AGENTS.md` becomes ordinary
 * content the platform never writes, never refreshes and never hides, and the
 * customer's file is the one that points at ours (see
 * {@link agentsFilePointerSentence}).
 *
 * A live binding like the three roots above — read it inside a function body,
 * never capture it at module scope.
 */
export let AGENTS_FILE = 'AGENTS.md';

/**
 * The name the managed guide had when it was the only name it could have.
 *
 * Referenced ONLY by the code that has to tell OUR file from THEIRS — the
 * boot-time removal of a platform-written `AGENTS.md`, the ignore rule that
 * stops hiding it, the instruction telling an agent to read the customer's
 * file too. In the spirit of {@link LEGACY_GROUPS_DIR}: a second live spelling
 * of the CURRENT name is how two layouts start being supported by accident, so
 * this one is a constant and means exactly one thing.
 */
export const LEGACY_AGENTS_FILE = 'AGENTS.md';

/**
 * The platform files whose names are FIXED — the ones no deployment renames.
 * The guide is the fourth platform file and is deliberately absent here: its
 * name is {@link AGENTS_FILE}, and `platform-files.ts` composes the two into
 * the set every gate reads.
 *
 * It lives in this module rather than beside that composition because the
 * LAYOUT has to validate against it (a guide may not be called `access.md`),
 * and `platform-files.ts` already reads this module — the other direction
 * would be a cycle.
 */
export const FIXED_PLATFORM_FILE_NAMES: readonly string[] = Object.freeze([
  'access.md',
  'roles.yaml',
  '.bevelignore',
]);

/**
 * The three renameable roots and the guide's file name, as a deployment
 * declares them and `/api/config` serves them.
 */
export interface KbLayout {
  knowledgeBaseDir: string;
  skillsDir: string;
  pluginsDir: string;
  /**
   * The managed agent guide's file name. OPTIONAL, and deliberately: a layout
   * that predates the setting — an older server's `/api/config` body, a saved
   * deployment that never named one — carries three folders and no guide, and
   * the right answer to that is the right answer to an unset field, which is
   * `AGENTS.md`. Read it through {@link agentsFileOf} rather than directly, so
   * "absent" and "the default" can never come to mean two different things.
   */
  agentsFile?: string;
}

/** The layout a deployment gets when it names nothing. */
export const DEFAULT_KB_LAYOUT: Readonly<Required<KbLayout>> = Object.freeze({
  knowledgeBaseDir: 'KnowledgeBase',
  skillsDir: 'Skills',
  pluginsDir: 'Plugins',
  agentsFile: 'AGENTS.md',
});

/** The guide's name in a layout, with the default standing in for an absent one. */
export function agentsFileOf(layout: KbLayout): string {
  return (layout.agentsFile ?? '').trim() || DEFAULT_KB_LAYOUT.agentsFile;
}

/**
 * The ONE sentence the platform offers to keep in a customer's own
 * `AGENTS.md`, pointing at the managed guide beside it.
 *
 * Defined here, once, because two surfaces must produce the identical text:
 * the deployment-settings field previews it before the admin consents, and the
 * startup step appends it. A sentence written twice is a sentence that drifts,
 * and a drifted one appends a SECOND copy to every customer file on the boot
 * after the drift — which is the one thing this whole feature exists to stop.
 *
 * A guide name is a FILE NAME, not an identifier: everything `validateFilename`
 * admits can appear in it — spaces, brackets, parentheses, `#`, `%` — and each
 * of those means something in an inline link. So the link is BUILT rather than
 * interpolated: the label backslash-escaped ({@link markdownLinkLabel}), the
 * destination percent-encoded ({@link agentsFileLinkPath}). A name that only
 * parenthesised would break the destination; `#` would turn the rest of the
 * name into a URL fragment, and the link would point at the customer's own
 * file.
 *
 * Neither spelling need match the name as it is on disk, so nothing may ask
 * whether this sentence is present by searching for the RAW name — see
 * {@link mentionsAgentsFile}, which is how the startup step asks.
 */
export function agentsFilePointerSentence(agentsFile: string = AGENTS_FILE): string {
  return (
    `Read [${markdownLinkLabel(agentsFile)}](${agentsFileLinkPath(agentsFile)}) ` +
    'before working in this knowledge base — ' +
    "it is the platform's guide to its layout, files and rules."
  );
}

/**
 * `text` as an inline link's LABEL: the characters that would end the label or
 * start emphasis or code inside it, backslash-escaped. Nothing else is touched
 * — a filename is read by people, and `AGENTS\.md` helps no one.
 */
function markdownLinkLabel(text: string): string {
  return text.replace(/[\\[\]`*_]/g, (c) => `\\${c}`);
}

/**
 * The guide as an inline link's DESTINATION: `./` and the name, percent-encoded.
 *
 * `encodeURI` does most of it (a space, a bracket, and `%` itself, so an
 * already-encoded-looking name is not decoded by a reader). Three more are
 * encoded by hand because `encodeURI` leaves them and each one ENDS the path
 * early: `#` opens a fragment, and `(`/`)` close the destination in
 * CommonMark's bare form. `?` and the rest of the URL-significant set are
 * already refused by {@link validateFilename}.
 *
 * An ordinary name has none of these and comes out exactly as it went in.
 */
function agentsFileLinkPath(agentsFile: string): string {
  return `./${encodeURI(agentsFile).replace(/[#()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * Whether `text` already points at the guide — the ONE question the startup
 * step asks before appending {@link agentsFilePointerSentence} to a customer's
 * own `AGENTS.md`.
 *
 * The plain name is the answer that matters: a mention in the customer's own
 * words, a heading, a link they wrote, all count, and the platform stays out
 * of a file it does not own. The other two spellings are the platform's OWN,
 * and they are here for idempotence: the sentence writes the name escaped in
 * the label and encoded in the destination, so on a punctuated name the file
 * the last boot wrote need not contain the raw name at all. Asking only for
 * that one would append a second copy on the next boot, and a third on the
 * one after — the exact failure this feature exists to prevent.
 */
export function mentionsAgentsFile(text: string, agentsFile: string = AGENTS_FILE): boolean {
  return (
    text.includes(agentsFile) ||
    text.includes(markdownLinkLabel(agentsFile)) ||
    text.includes(agentsFileLinkPath(agentsFile))
  );
}

/**
 * What is wrong with one root name, or null. A root is joined onto the repo
 * root and onto `<dir>/.gitkeep`, so a separator or `..` would write outside
 * the repository; a dot-prefixed name would be skipped by every scanner that
 * treats dot-entries as bookkeeping; `.git` in any case would corrupt the clone.
 */
export function validateKbRootName(name: string): string | null {
  const v = name.trim();
  if (!v) return 'A folder name is required.';
  if (v.includes('/') || v.includes('\\')) return 'Use a single folder name — no slashes.';
  // The ONE rule for what a path segment may be called — the same one every
  // file and folder made through the platform passes (reserved Windows
  // names, trailing dots, forbidden characters, length) — plus what a ROOT
  // must not be: dot-prefixed, which every scanner skips as bookkeeping.
  const asName = validateFilename(v);
  if (asName) return asName;
  if (v.startsWith('.')) return 'The name can\'t start with a dot.';
  return null;
}

/**
 * What is wrong with the agent guide's file name, or null.
 *
 * The rules, and what each one is for:
 *
 *  - ONE FILE NAME. The name is joined onto the repository root and read from
 *    there and nowhere else, so a separator would name a file the platform
 *    would write but never read back.
 *  - A MARKDOWN NAME. The guide is a markdown document that people open in the
 *    app and agents read as text; `.md` is also what the per-file access rules
 *    apply to, so a guide under any other extension would take its folder's
 *    rules and stop being readable by everyone.
 *  - NOT `CLAUDE.md`. That is the guide's own pre-rename name; knowledge bases
 *    seeded before the rename still carry one, and it stays legacy content
 *    rather than becoming a second managed file.
 *  - NOT ANOTHER PLATFORM FILE. Two platform roles on one path means whichever
 *    writer runs last wins, silently.
 *  - NOT A ROOT FOLDER'S NAME, compared case-insensitively like the roots are
 *    to each other: the workspaces live on case-insensitive filesystems, where
 *    a file `Docs.md` and a folder `docs.md` are one entry.
 *
 * `roots` is the layout the name is judged against — the names this save would
 * put in effect, not necessarily the ones running now.
 */
export function validateAgentsFileName(
  name: string,
  roots: Pick<KbLayout, 'knowledgeBaseDir' | 'skillsDir' | 'pluginsDir'> = currentKbLayout(),
): string | null {
  const v = name.trim();
  if (!v) return 'A file name is required.';
  if (v.includes('/') || v.includes('\\')) return 'Use a single file name — no folders.';
  // The ONE rule for what a path component may be called, as everywhere else.
  const asName = validateFilename(v);
  if (asName) return asName;
  const lower = v.toLowerCase();
  // The taken names come FIRST, so a name that is wrong for a specific reason
  // is refused with that reason rather than with whichever general rule it
  // happens to break as well (`roles.yaml` is not merely 'not markdown').
  if (lower === 'claude.md') {
    return 'CLAUDE.md is the guide\'s pre-rename name and stays reserved for it.';
  }
  for (const reserved of [...FIXED_PLATFORM_FILE_NAMES, PREAMBLE_FILE]) {
    if (lower === reserved.toLowerCase()) return `${reserved} is a platform file name.`;
  }
  // A dot-prefixed name is skipped by every scanner that treats dot-entries as
  // bookkeeping — including the one that would show the guide in the tree.
  if (v.startsWith('.')) return 'The name can\'t start with a dot.';
  if (!v.endsWith('.md')) return 'The name must end in .md.';
  for (const [label, dir] of [
    ['knowledge', roots.knowledgeBaseDir],
    ['skills', roots.skillsDir],
    ['plugins', roots.pluginsDir],
  ] as const) {
    if (lower === (dir ?? '').trim().toLowerCase()) {
      return `That is already the ${label} folder's name.`;
    }
  }
  return null;
}

/**
 * What is wrong with a layout, or null — the same rule {@link configureKbLayout}
 * enforces, without applying anything. Separate so the setup screen can judge a
 * proposed layout before it is saved. The three folder names must differ,
 * compared case-insensitively: the workspaces live on case-insensitive
 * filesystems too, where `Skills` and `skills` are one folder. The guide's
 * file name is judged against all three by the same rule (see
 * {@link validateAgentsFileName}), which makes the four names distinct.
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
  // The fixed reserved roots are taken too: naming the skills folder `Data`
  // would give one directory two reserved roles.
  const fixed = [DATA_DIR, AGENTS_DIR, PIPELINES_DIR].map((n) => n.toLowerCase());
  const clash = names.find((n) => fixed.includes(n));
  if (clash) return `"${clash}" is a reserved folder name (${[DATA_DIR, AGENTS_DIR, PIPELINES_DIR].join(', ')}).`;
  // Judged against the roots THIS layout declares, not the ones in effect: a
  // save that renames the plugins folder and the guide together must be read
  // as the pair it is.
  const guide = validateAgentsFileName(agentsFileOf(layout), layout);
  if (guide) return `The agent guide's file name: ${guide}`;
  return null;
}

/** Everything that has asked to hear when the layout is applied. */
const layoutListeners = new Set<() => void>();

/**
 * Be told when {@link configureKbLayout} runs — for the few things that cannot
 * read a live binding at the moment they are used.
 *
 * Almost nothing needs this: the roots and the guide's name are `let` bindings
 * read inside function bodies, so code that follows the rule follows the
 * layout for free. The exception is a value BUILT ONCE and handed to something
 * that keeps it — the tool catalog's descriptions, which are validated into
 * frozen-ish defs at registration and then served to agents from a map. Boot
 * applies the layout before they are built, but the save that completes
 * FIRST-RUN SETUP applies it afterwards (see `setup.routes.ts`, which must, so
 * the KB phase that runs in the same request scaffolds the names the admin
 * just chose) — and without this the catalog would go on naming `AGENTS.md`
 * until someone restarted the server.
 *
 * Listeners run in registration order, after the bindings are updated and only
 * when the layout was accepted.
 */
export function onKbLayoutApplied(listener: () => void): void {
  layoutListeners.add(listener);
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
  AGENTS_FILE = agentsFileOf(layout);
  for (const listener of layoutListeners) listener();
}

/** The layout currently in effect. */
export function currentKbLayout(): Required<KbLayout> {
  return {
    knowledgeBaseDir: KNOWLEDGE_BASE_DIR,
    skillsDir: SKILLS_DIR,
    pluginsDir: PLUGINS_DIR,
    agentsFile: AGENTS_FILE,
  };
}

/**
 * Whether a layout — the one in effect, unless one is given — is the default
 * one. The setup-completing save applies the stored names while this holds,
 * the same "only from none to some" rule the branch model follows — and also
 * on a retry after its own failed initialization run, when the process holds
 * names setup applied but the app never opened (see `setup.routes.ts`). A
 * layout the process booted with is never replaced here.
 */
export function isDefaultKbLayout(layout: KbLayout = currentKbLayout()): boolean {
  return (
    layout.knowledgeBaseDir === DEFAULT_KB_LAYOUT.knowledgeBaseDir &&
    layout.skillsDir === DEFAULT_KB_LAYOUT.skillsDir &&
    layout.pluginsDir === DEFAULT_KB_LAYOUT.pluginsDir &&
    agentsFileOf(layout) === DEFAULT_KB_LAYOUT.agentsFile
  );
}

/**
 * Render the layout placeholders a managed template carries —
 * `{{knowledgeBaseDir}}`, `{{skillsDir}}`, `{{pluginsDir}}`, `{{agentsFile}}`
 * — with the names in effect. The packaged guide and `.bevelignore` are
 * written this way so a deployment that renamed its roots hands the agent a
 * guide that names the folders it will actually find, and a deployment that
 * renamed the guide gets a guide naming the file it lives in. Text without
 * placeholders passes through unchanged.
 */
export function renderKbLayoutPlaceholders(text: string, layout: KbLayout = currentKbLayout()): string {
  // Replacer FUNCTIONS: a string replacement would interpret `$&`, `$$` and
  // friends inside a folder name, and `$` is a legal character in one.
  return text
    .replaceAll('{{knowledgeBaseDir}}', () => layout.knowledgeBaseDir)
    .replaceAll('{{skillsDir}}', () => layout.skillsDir)
    .replaceAll('{{pluginsDir}}', () => layout.pluginsDir)
    .replaceAll('{{agentsFile}}', () => agentsFileOf(layout));
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
  const segments = trimmed.split('/');
  // Only TRAILING slashes are forgiven; an empty segment anywhere else
  // (`Skills//deploy`) is a malformed path, not a spelling of a valid one.
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
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
 * The Agent Plugins `name`: a kebab-case identifier — lowercase letters and
 * digits in hyphen-separated runs, nothing else. It is the plugin's IDENTITY:
 * what the marketplace publishes it as, what the access principals are
 * spelled from (`plugin/<name>/<verb>`), what the catalog and the URLs key
 * on. `pluginManifestName` folds any spelling into one of these.
 */
export const PLUGIN_IDENTIFIER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPluginIdentifier(name: unknown): name is string {
  return typeof name === 'string' && PLUGIN_IDENTIFIER_RE.test(name);
}

/**
 * The identity of a plugin folder: the manifest's `name` when it IS an
 * identifier, else the folder name folded into one. A manifest naming
 * something that cannot be an identifier is not silently reinterpreted; the
 * folder stands in, and discovery says so.
 */
export function pluginIdentityOf(manifest: Record<string, unknown> | null, folderName: string): string {
  const declared = manifest?.name;
  return isPluginIdentifier(declared) ? declared : pluginManifestName(folderName);
}

/**
 * What a person sees the plugin called: the manifest's `displayName` (the
 * vendor field Claude Code shows in its picker; any casing, spaces allowed),
 * else the manifest's `name`.
 *
 * THE MANIFEST IS THE ONLY SOURCE — there is no folder argument, on purpose.
 * The folder's spelling used to stand in here, which made where a plugin
 * happens to live a hidden input to what everyone sees it called: the API
 * always answered with a display name while the file sometimes omitted the
 * field, and moving or re-casing a folder silently renamed the plugin. Every
 * write path now persists the field (see {@link renderPluginManifest} and
 * the rename service), and one startup step backfilled the folder's spelling
 * into the manifests written before that, so nothing renames itself.
 *
 * Empty only for a manifest that names nothing at all — the shape discovery
 * already warns about and stands the folder in as the IDENTITY for; its
 * display name then follows that identity, never the folder directly.
 */
export function pluginDisplayNameOf(manifest: Record<string, unknown> | null): string {
  const declared = manifest?.displayName;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  const name = manifest?.name;
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * A minimal, valid `plugin.json` for a plugin folder: the identifier the
 * folder name folds into, and the name a person sees it by — `displayName`,
 * ALWAYS written, so a client's picker shows "Sales Team" for `sales-team`
 * and every reader has the one field to read.
 *
 * ONE argument, deliberately: `folderName` is the folder's own leaf, and on
 * the creation path that leaf IS the name its creator typed, trimmed — the
 * dialog's route and the `create_plugin` tool make the folder out of the
 * typed name and hand the same string to both. A second `displayName`
 * parameter would be a way for the two to disagree that no caller needs.
 * The field is written even when it equals the identifier: a manifest that
 * omits it when the two agree is a manifest whose readers need a second rule.
 *
 * Nothing else: `version`, `license` and the rest are metadata about a
 * DISTRIBUTED package, and inventing values for a folder someone just made
 * in the app would be asserting things nobody said.
 */
export function renderPluginManifest(folderName: string): string {
  const name = pluginManifestName(folderName);
  // Always a non-blank, trimmed answer: the spelling asked for, else the
  // identifier — a `displayName` of spaces would be a field present and
  // saying nothing, which is the shape every reader here exists to avoid.
  const shown = folderName.trim() || name;
  return `${JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name, displayName: shown }, null, 2)}\n`;
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
 * THE structural rule for a personal shelf: a repo-relative folder that is a
 * DIRECT child of the plugins root and carries the personal prefix. A deeper
 * folder so named is just a name, and a plugin whose manifest name happens
 * to start with the prefix is a plugin — discovery, the principal picker and
 * the item pages all ask this one question of the FOLDER.
 */
export function isPersonalPluginDir(repoRelDir: string): boolean {
  const segments = repoRelDir.split('/').filter(Boolean);
  return segments.length === 2 && segments[0] === PLUGINS_DIR && isPersonalPluginFolder(segments[1]!);
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

/**
 * The roots anyone may start a new folder in — knowledge, skills and plugins
 * — whatever the root's own `access.md` grants them. Everywhere else a change
 * needs read access to where it lands (the "read before write" rule); a new
 * folder directly under one of these three is the one place that rule does
 * not apply, because the new folder carries its creator's own grant. A
 * function, like {@link reservedRootDirNames}, because the names are
 * configurable.
 */
export function creatableRootDirNames(): ReadonlySet<string> {
  return new Set([KNOWLEDGE_BASE_DIR, SKILLS_DIR, PLUGINS_DIR]);
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
