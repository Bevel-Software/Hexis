/**
 * Which files can carry their OWN frontmatter — and therefore their own
 * per-file access rules.
 *
 * A file-level grant, revoke or restriction splices a `---` YAML block into
 * the file itself. That is right for a Markdown note and destructive for
 * anything else: spliced into a PDF, a presentation or an image it corrupts
 * the bytes (the preview goes blank), and the grant never even resolves.
 * Such a file takes its folder's rules instead.
 *
 * THE ONE predicate for that question: the access routes refuse a file-level
 * mutation on a file it rejects, and the Manage access dialog shows the folder
 * pointer for the same files. The extension list mirrors the backend's
 * file-reader registry — Markdown-like kinds only, each served by a
 * text-editable text reader. The registry's own test pins the two together,
 * so a reader that ever claims one of these extensions as a non-text kind
 * fails there rather than drifting silently. (The registry itself cannot live
 * here: its document readers carry backend-only extraction dependencies.)
 *
 * An extensionless file is NOT a carrier: its content may be anything, and a
 * path alone cannot tell a note from a binary.
 */
export const FRONTMATTER_CARRIER_EXTENSIONS: readonly string[] = ['.md', '.markdown'];

/** Lowercased extension of the path's last segment, with the dot; '' when none (dotfiles included). */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/** True when the file at `path` can carry its own frontmatter (and so its own access rules). */
export function canCarryFrontmatter(path: string): boolean {
  return FRONTMATTER_CARRIER_EXTENSIONS.includes(extensionOf(path));
}

/** The `kind` a refused file-level access mutation answers with. */
export const FOLDER_GOVERNS_ACCESS_KIND = 'folder-governs-access';

/**
 * The one sentence both the 422 and the dialog say, naming the folder whose
 * rules govern the file.
 */
export function folderGovernsAccessMessage(folder: string): string {
  return `This file's access comes from its folder. Manage access on ${folder} instead.`;
}
