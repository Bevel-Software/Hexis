/**
 * Which files decide what a listing of a branch shows, by their content.
 *
 * An edit of any other existing file leaves every listing as it was, as long
 * as the file's own access entries (its frontmatter) are the same: the paths
 * are the same and so is who may read each. An edit of one of these can hide
 * or reveal paths without adding or removing any, so whoever announces a
 * change must not mark it "listing unchanged":
 *
 *   - every source of the access model (`accessSourceOf`): the rules
 *     themselves, and a plugin's manifest, which decides which folders are a
 *     plugin, whose folder has its own readers;
 *   - a `.bevelignore` at any depth: it removes paths from every listing.
 *
 * `repoRelativePath` is relative to the knowledge base's repository root, with
 * forward slashes. `pluginsDir` is the layout's plugins root.
 */
import { PLUGIN_MANIFEST_FILE } from '@bevel-software/platform-shared';
import { isAccessMdPath } from './access-grammar.js';
import { scanFrontmatter } from './frontmatter-lines.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML } from './group-files.js';

/** The sources of a model that are read by a fixed name at the root, whatever else the tree holds. */
export const FIXED_NAME_SOURCES = ['roles.yaml', SYNCED_GROUPS_YAML, GROUPS_YAML] as const;

/**
 * Which source of an access model the file at `p` (repository-relative) is:
 * a folder's rules (an `access.md` at any depth), one read by its fixed name
 * at the root (`FIXED_NAME_SOURCES`), a plugin's manifest (a `plugin.json`
 * in any folder below the plugins root), or none. The one answer
 * for every reader of the set: both builds of a model, the key a commit's
 * model is shared by, and `decidesListing`.
 */
export function accessSourceOf(p: string, pluginsDir: string): 'rules' | 'fixed-name' | 'manifest' | null {
  if (isAccessMdPath(p)) return 'rules';
  if ((FIXED_NAME_SOURCES as readonly string[]).includes(p)) return 'fixed-name';
  const cut = p.lastIndexOf('/');
  return cut > 0 && p.slice(cut + 1) === PLUGIN_MANIFEST_FILE && p.slice(0, cut).startsWith(`${pluginsDir}/`) ? 'manifest' : null;
}

export function decidesListing(repoRelativePath: string, pluginsDir: string): boolean {
  if (accessSourceOf(repoRelativePath, pluginsDir) !== null) return true;
  return repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1) === '.bevelignore';
}

/**
 * The leading `---` fenced block of `text` with line ends made alike, or `''`
 * when the text does not open with one: where a file's own access entries
 * are. The fences are found by the platform's one rule (`scanFrontmatter`,
 * the scan the access grammar itself reads a file with), so two texts with
 * equal heads declare the same access. A block that is never closed is the
 * whole text: a file that is one fenced document (a `.tool`) then counts
 * every edit as a change of its head, which is the safe reading.
 */
export function fencedHead(text: string): string {
  const scan = scanFrontmatter(text);
  if (scan.kind === 'none') return '';
  if (scan.kind === 'unterminated') return text.replace(/\r\n/g, '\n');
  return ['---', ...scan.fm].join('\n');
}

/**
 * Whether a commit that edited one existing file (`contentEdit`, as the git
 * layer reports it) left every listing of the branch as it was: the file is
 * not one that decides a listing, and its own access entries did not change.
 * `undefined` (the commit was not such an edit, or could not be told) is no.
 */
export function listingUnchangedBy(
  contentEdit: { frontmatterChanged: boolean } | undefined,
  repoRelativePath: string,
  pluginsDir: string,
): boolean {
  return contentEdit !== undefined && !contentEdit.frontmatterChanged && !decidesListing(repoRelativePath, pluginsDir);
}
