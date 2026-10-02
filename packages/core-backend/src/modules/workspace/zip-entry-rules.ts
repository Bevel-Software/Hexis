import { validateFilename } from '@bevel-software/platform-shared';
import { GitInternalsError } from '../../shared/domain-errors.js';
import { hasGitInternalsSegment } from '../../shared/git-internals.js';

/**
 * What an archive's entry NAMES are allowed to be, as one set of rules two
 * surfaces ask: `unzip` (a .zip already in the workspace) and
 * `apply_file_upload` (a .zip the agent sent to the upload route). Both land
 * bytes an agent never typed at paths the archive chose, so both have to judge
 * the same names the same way — and they did not, for as long as the rules
 * lived inside `WorkspaceService.unzipFile` as three inline blocks.
 *
 * NAMES only. Whether a target sits behind a symbolic link already on disk,
 * whether the caller may write there, and what is already at the path are
 * facts about a workspace, so each surface asks those where its own writes
 * land. What this module decides is decidable from the entry's own name.
 */

/**
 * The entries an archive from macOS carries that nobody asked for: the
 * resource-fork sidecar tree and the Finder's own index. SILENTLY dropped
 * rather than reported — they are not the caller's content and a list of
 * refusals about them says nothing.
 */
export function isZipNoiseEntry(rawName: string): boolean {
  return (
    rawName.startsWith('__MACOSX/') ||
    rawName === '__MACOSX' ||
    rawName.endsWith('/.DS_Store') ||
    rawName === '.DS_Store' ||
    /(^|\/)\._/.test(rawName)
  );
}

/**
 * An entry's name with separators in the one spelling the rules read. A zip
 * written on Windows may use `\`, which every check below (and every path
 * built from the result) would otherwise read as part of a single segment.
 */
export function zipEntryName(entryName: string): string {
  return entryName.replace(/\\/g, '/');
}

/** The path segments `rawName` names, with a trailing slash and empty parts dropped. */
export function zipEntrySegments(rawName: string): string[] {
  return rawName
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s.length > 0);
}

/**
 * Why `rawName` may not be landed at all — the reason a caller reports beside
 * the entry — or null when the name is one a workspace path can be built from.
 *
 * Three rules, in the order that makes each refusal say the most useful thing:
 * a path that climbs out or is anchored at the root is invalid whatever its
 * segments are; the git folder is refused in every spelling, because an
 * archive must not be a way to write what git reads as its own metadata; and
 * then each segment has to be a name a filesystem on any of the three
 * operating systems keeps intact (`validateFilename`).
 */
export function zipEntryNameRefusal(rawName: string): string | null {
  if (!rawName || rawName.startsWith('/') || /(^|\/)\.\.($|\/)/.test(rawName)) return 'Invalid path';
  if (hasGitInternalsSegment(rawName)) return new GitInternalsError().message;
  for (const segment of zipEntrySegments(rawName)) {
    const reason = validateFilename(segment);
    if (reason) return reason;
  }
  return null;
}

/**
 * Whether a zip entry is a symbolic LINK rather than a file or a folder.
 *
 * A zip stores a link as an ordinary member whose bytes are the link's target
 * text and whose unix mode (the high half of the external attributes) carries
 * `S_IFLNK`. A reader that ignores the mode writes the target text out as a
 * regular file — content nobody sent, under a name that was meant to point
 * somewhere. `apply_file_upload` refuses such an entry outright; the entry is
 * not a file, so there are no bytes of the caller's to land.
 */
export function isSymlinkZipEntry(entry: {
  header?: { attr?: number };
  attr?: number;
}): boolean {
  const attr = entry.header?.attr ?? entry.attr ?? 0;
  if (!Number.isFinite(attr) || attr <= 0) return false;
  // The external attributes' high 16 bits are the unix mode when the archive
  // was written on a unix host; `S_IFMT & mode === S_IFLNK` is the link bit.
  return ((attr >>> 16) & 0o170000) === 0o120000;
}
