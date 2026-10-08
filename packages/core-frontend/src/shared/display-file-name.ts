import { PLUGIN_MANIFEST_FILE, currentKbLayout } from '@bevel-software/platform-shared';

/**
 * What the app CALLS a file, wherever it names one: a row in the tree, a tab,
 * a page's title, the bar above a document, a search result.
 *
 * Almost always that is the file's own name. The exceptions are the files the
 * platform reads as configuration, whose names only make sense to someone who
 * knows how Hexis is built: a plugin's `plugin.json` is its settings. Those
 * read in plain words here, and only here, so no surface can call the same
 * file two different things.
 *
 * DISPLAY ONLY. The file on disk, its URL, every API and everything an agent
 * reads keep the real name; {@link fileNameTooltip} hands it to whoever
 * hovers, so it is never hidden from someone who needs it.
 *
 * Paths, not bare names: a `plugin.json` is the plugin's settings only directly
 * inside a plugin's folder (`<kb>/Plugins/<plugin>/plugin.json`, or the same
 * path repo-relative). One bundled deeper — a skill's example — is just a file
 * called `plugin.json`, and a bare name cannot say which it is.
 */

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The plain name of a platform file, or null for every other file. */
function plainName(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const name = segments[segments.length - 1];
  if (name === PLUGIN_MANIFEST_FILE && segments[segments.length - 3] === currentKbLayout().pluginsDir) {
    return 'Plugin settings';
  }
  return null;
}

/** The name to show for the file at `path`. */
export function displayFileName(path: string): string {
  return plainName(path) ?? baseName(path);
}

/**
 * The file's real name, for a `title` — set only when {@link displayFileName}
 * shows something else, so an ordinary file keeps whatever tooltip it had.
 */
export function fileNameTooltip(path: string): string | undefined {
  return plainName(path) === null ? undefined : baseName(path);
}
