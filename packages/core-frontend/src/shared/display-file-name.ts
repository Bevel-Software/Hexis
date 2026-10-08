import { PLUGIN_MANIFEST_FILE, PLUGIN_SKILLS_DIR, currentKbLayout } from '@bevel-software/platform-shared';

/**
 * What the app CALLS a file, wherever it names one: a row in the tree, a tab,
 * a page's title, the bar above a document, a search result.
 *
 * Almost always that is the file's own name. The exceptions are the files the
 * platform reads as configuration, whose names only make sense to someone who
 * knows how Hexis is built: a plugin's `plugin.json` is its settings, and a
 * folder's `access.md` is who has access to it. Those read in plain words
 * here, and only here, so no surface can call the same file two different
 * things.
 *
 * DISPLAY ONLY. The file on disk, its URL, every API and everything an agent
 * reads keep the real name; {@link fileNameTooltip} hands it to whoever
 * hovers, so it is never hidden from someone who needs it.
 *
 * Paths, not bare names: a `plugin.json` is the plugin's settings only in a
 * plugin's own folder under the plugins root, and the plugins root is the one
 * at the top of the repository — a folder a person happened to call `Plugins`
 * inside the knowledge tree holds no plugins. So a caller says what its path
 * is relative to: `kbDirName` for a workspace path (`<kbDirName>/Plugins/…`),
 * null for one that is already repository-relative (a change request's file
 * list). A plugin may sit under grouping folders, so its depth is not fixed;
 * what is fixed is that a `plugin.json` inside a plugin's `skills/` is a
 * skill's bundled example and nothing more. An `access.md` governs its folder
 * at any depth, so its name alone is enough.
 */

/** The access rules file's name — a platform file at any depth, in any case. */
const ACCESS_RULES_FILE = 'access.md';

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The path's segments from the repository root, or null for a workspace path
 * that does not start with the clone folder: that file is outside the
 * repository and under no root at all.
 */
function repoSegments(path: string, kbDirName: string | null): string[] | null {
  const segments = path.split('/').filter(Boolean);
  if (kbDirName === null) return segments;
  return segments[0] === kbDirName ? segments.slice(1) : null;
}

/**
 * Whether repository-relative `segments` name a plugin's own manifest: a
 * `plugin.json` under the plugins root, in a plugin's folder at any depth
 * (plugins sit under grouping folders too), and not inside a plugin's
 * `skills/`, where one is a skill's bundled example. A skill's example sits
 * at least one folder below a `skills` segment (`<plugin>/skills/<skill>/…`),
 * so only a `skills` segment ABOVE the file's own folder excludes it: a
 * plugin that is itself called `skills` keeps its settings.
 */
function isPluginManifest(segments: string[]): boolean {
  if (segments.length < 3) return false;
  if (segments[0] !== currentKbLayout().pluginsDir) return false;
  if (segments[segments.length - 1] !== PLUGIN_MANIFEST_FILE) return false;
  return !segments.slice(1, -2).includes(PLUGIN_SKILLS_DIR);
}

/** The plain name of a platform file, or null for every other file. */
function plainName(path: string, kbDirName: string | null): string | null {
  if (isAccessRulesFile(path)) return 'Who has access';
  const segments = repoSegments(path, kbDirName);
  return segments && isPluginManifest(segments) ? 'Plugin settings' : null;
}

/**
 * Whether `path` is a folder's access rules — the file "Who has access" names.
 * The one rule for it, wherever the app asks: the tree's suggestions and the
 * file page both read it from here.
 */
export function isAccessRulesFile(path: string): boolean {
  return baseName(path).toLowerCase() === ACCESS_RULES_FILE;
}

/**
 * The name to show for the file at `path`. `kbDirName` is the clone folder a
 * workspace path starts with; null (the default) says the path is already
 * repository-relative.
 */
export function displayFileName(path: string, kbDirName: string | null = null): string {
  return plainName(path, kbDirName) ?? baseName(path);
}

/**
 * The file's real name, for a `title` — set only when {@link displayFileName}
 * shows something else, so an ordinary file keeps whatever tooltip it had.
 */
export function fileNameTooltip(path: string, kbDirName: string | null = null): string | undefined {
  return plainName(path, kbDirName) === null ? undefined : baseName(path);
}
