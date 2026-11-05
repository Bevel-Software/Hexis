import { inflateRawSync } from 'node:zlib';
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
 * NAMES, and how an entry's BYTES are read ({@link readZipEntry}) — the two
 * things decidable from the archive alone. Whether a target sits behind a
 * symbolic link already on disk, whether the caller may write there, and what
 * is already at the path are facts about a workspace, so each surface asks
 * those where its own writes land.
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

/** A zip's compression method for DEFLATE, the only one that can expand. */
const ZIP_METHOD_DEFLATED = 8;

/** What {@link readZipEntry} needs of an entry — the part of adm-zip's it reads. */
export interface ReadableZipEntry {
  header: { size: number; compressedSize: number; method: number };
  getData(): Buffer;
  getCompressedData(): Buffer;
}

/** An entry's bytes, or why they were not read. */
export type ZipEntryRead =
  | { ok: true; data: Buffer }
  /** The entry is, or would expand to, more than the caller's budget allows. */
  | { ok: false; reason: 'too_large' }
  /** The entry cannot be read as what its header says it is. `detail` says how. */
  | { ok: false; reason: 'unreadable'; detail: string };

/**
 * Read one entry's bytes, inflating NO MORE than `budget` of them.
 *
 * The one read both surfaces use, because the bound is the whole point and it
 * has a hole when each surface writes it itself. An entry's header DECLARES its
 * uncompressed size, and the reader caps the inflation at that — but only when
 * the size it declares is above zero. An entry that declares zero is inflated
 * with no cap at all, so "check the declared size against the budget, then
 * read" passes a 20 KB archive that expands to 20 MB, and a 50 MB one that
 * expands to tens of gigabytes in a single call, before any check on the bytes
 * that arrived has run. A thousandfold is what deflate does to a run of one
 * byte; the header saying "empty" was the only thing standing in front of it.
 *
 * So the declared size is never the only bound:
 *
 *  - an entry declaring more than `budget` is refused unread;
 *  - a DEFLATED entry declaring ZERO with a stream of its own is inflated here,
 *    capped at a single byte. An empty file compressed with deflate is exactly
 *    this shape (a two-byte stream that inflates to nothing) and is read as the
 *    empty file it is; anything that inflates to a byte or more contradicts its
 *    own header and is refused;
 *  - every other entry is read by the archive reader, which caps the inflation
 *    at the declared size this function has just held against the budget, and
 *    the bytes that arrive are measured again.
 *
 * A read that throws — a failed checksum, a stream longer than it declared, an
 * unknown method — is that entry's refusal, not the whole archive's: one bad
 * member must not cost the caller the others.
 */
export function readZipEntry(entry: ReadableZipEntry, budget: number): ZipEntryRead {
  const { size: declared, compressedSize, method } = entry.header;
  if (declared > budget) return { ok: false, reason: 'too_large' };
  if (declared === 0 && method === ZIP_METHOD_DEFLATED && compressedSize > 0) {
    let inflated: Buffer;
    try {
      inflated = inflateRawSync(entry.getCompressedData(), { maxOutputLength: 1 });
    } catch (err) {
      // Past the one-byte cap, or not a deflate stream at all: either way it
      // is not the empty file its header says it is.
      return { ok: false, reason: 'unreadable', detail: declaresEmptyButIsNot(err) };
    }
    if (inflated.byteLength > 0) return { ok: false, reason: 'unreadable', detail: declaresEmptyButIsNot() };
    return { ok: true, data: inflated };
  }
  let data: Buffer;
  try {
    data = entry.getData();
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }
  if (data.byteLength > budget) return { ok: false, reason: 'too_large' };
  return { ok: true, data };
}

function declaresEmptyButIsNot(err?: unknown): string {
  const outputLimit = (err as { code?: string } | undefined)?.code === 'ERR_BUFFER_TOO_LARGE';
  return err === undefined || outputLimit
    ? 'its header declares an empty file, but it holds content'
    : `its header declares an empty file, and its content could not be read (${err instanceof Error ? err.message : String(err)})`;
}
