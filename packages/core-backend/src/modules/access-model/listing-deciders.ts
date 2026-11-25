/**
 * Which files decide what a listing of a branch shows, by their content.
 *
 * An edit of any other existing file leaves every listing as it was, as long
 * as the file's own access entries (its frontmatter) are the same: the paths
 * are the same and so is who may read each. An edit of one of these can hide
 * or reveal paths without adding or removing any, so whoever announces a
 * change must not mark it "listing unchanged":
 *
 *   - an `access.md` at any depth, and the roles and groups files at the root:
 *     the rules themselves;
 *   - a plugin's manifest: it decides which folders are a plugin, and a
 *     plugin's folder has its own readers;
 *   - a `.bevelignore` at any depth: it removes paths from every listing.
 *
 * `repoRelativePath` is relative to the knowledge base's repository root, with
 * forward slashes. `pluginsDir` is the layout's plugins root.
 */
import { PLUGIN_MANIFEST_FILE } from '@bevel-software/platform-shared';
import { isAccessMdPath } from './access-grammar.js';
import { GROUPS_YAML, SYNCED_GROUPS_YAML } from './group-files.js';

const AT_THE_ROOT = new Set(['roles.yaml', GROUPS_YAML, SYNCED_GROUPS_YAML]);

export function decidesListing(repoRelativePath: string, pluginsDir: string): boolean {
  if (isAccessMdPath(repoRelativePath) || AT_THE_ROOT.has(repoRelativePath)) return true;
  const name = repoRelativePath.slice(repoRelativePath.lastIndexOf('/') + 1);
  if (name === '.bevelignore') return true;
  return name === PLUGIN_MANIFEST_FILE && repoRelativePath.startsWith(`${pluginsDir}/`);
}

/**
 * The leading `---` fenced block of `text` with line ends made alike, or `''`
 * when the text does not open with one: where a file's own access entries
 * are. A block that is never closed is the whole text: a file that is one
 * fenced document (a `.tool`) then counts every edit as a change of its head,
 * which is the safe reading.
 */
export function fencedHead(text: string): string {
  const unix = text.replace(/\r\n/g, '\n');
  if (!unix.startsWith('---\n')) return '';
  const end = unix.indexOf('\n---', 3);
  return end < 0 ? unix : unix.slice(0, end);
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
