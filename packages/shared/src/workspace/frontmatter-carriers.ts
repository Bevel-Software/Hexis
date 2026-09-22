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
 * pointer for the same files.
 *
 * The carriers are exactly the files the access resolver reads its own
 * frontmatter from — the backend's core access-frontmatter extension set:
 * Markdown notes (`.md`) and `.tool` definitions (whole-document YAML whose
 * access verbs sit beside the definition). Both are served by the file-reader
 * registry's text-editable text reader. The registry test pins both facts, so
 * this list cannot drift from the resolver or the registry silently. (Neither
 * can live here: the registry's document readers carry backend-only extraction
 * dependencies, and overlays register further extensions at boot — the backend
 * passes its full registered set as `extensions`.)
 *
 * Matching is case-SENSITIVE, as the resolver's is: `Note.MD` carries no
 * enforced rule, so a grant written there would never resolve. An extensionless
 * file is NOT a carrier either: its content may be anything, and a path alone
 * cannot tell a note from a binary.
 */
export const FRONTMATTER_CARRIER_EXTENSIONS: readonly string[] = ['.md', '.tool'];

/**
 * True when the file at `path` can carry its own frontmatter (and so its own
 * access rules). `extensions` defaults to the core set; the backend passes the
 * resolver's registered set so an overlay's kinds count too.
 */
export function canCarryFrontmatter(
  path: string,
  extensions: readonly string[] = FRONTMATTER_CARRIER_EXTENSIONS,
): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  // The resolver's own rule is a plain suffix match, so a file named exactly
  // `.md` is read for its frontmatter there — and must be a carrier here too,
  // or a rule the resolver honours could not be managed.
  return extensions.some((ext) => name.endsWith(ext));
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
