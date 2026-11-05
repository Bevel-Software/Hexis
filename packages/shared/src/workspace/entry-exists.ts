/**
 * THE sentence a rename, a move or a copy answers with when something is
 * already at the destination.
 *
 * A rename is not a way to replace content: renaming a `.docx` onto an
 * existing `.md` used to hand the markdown file the Word bytes and break the
 * page. Every surface — the sidebar rename box, a drag onto a folder, the
 * agent's `move_file` and `copy_file` — refuses with this one sentence, so a
 * user who meets it in the sidebar and an agent that meets it in a tool
 * result are told the same thing.
 *
 * Kept here, beside `filename.ts`, for the same reason that file is: the
 * backend throws it and the frontend renders it, and neither should spell it
 * its own way.
 */

/** What is already sitting at the destination. */
export type ExistingEntryKind = 'file' | 'folder';

/**
 * `A file named <name> already exists in <folder>.` — `name` and `folder` are
 * read off `destinationPath`, which may be workspace-relative or
 * repo-relative; only its last two segments are used, so the reader sees the
 * name they typed and the folder they were aiming at rather than a full path.
 * A destination directly at the top of the tree has no folder segment to
 * name, and says `the top level` instead.
 */
export function entryExistsMessage(kind: ExistingEntryKind, destinationPath: string): string {
  const segments = destinationPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  const name = segments[segments.length - 1] ?? destinationPath;
  const folder = segments.length > 1 ? segments[segments.length - 2] : 'the top level';
  return `A ${kind} named ${name} already exists in ${folder}.`;
}
