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
 * NAMES, how an entry's BYTES are read ({@link readZipEntry}), and the one
 * plan both surfaces land ({@link planZipEntries}): the things decidable from
 * the archive alone. Whether a target sits behind a symbolic link already on
 * disk, whether the caller may write there, and what is already at the path
 * are facts about a workspace, so each surface asks those where its own writes
 * land.
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
 * somewhere. {@link planZipEntries} skips such an entry, for both surfaces;
 * the entry is not a file, so there are no bytes of the caller's to land.
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

/** What one archive may expand into: how many entries, and how many uncompressed bytes in all and in one file. */
export interface ZipPlanLimits {
  /** Entries past this many are skipped. macOS metadata is not counted. */
  entries: number;
  /** What the planned files may hold in all. */
  totalBytes: number;
  /** What one planned file may hold. */
  entryBytes: number;
}

/** What {@link planZipEntries} needs of an entry: the part of adm-zip's it reads. */
export interface PlannableZipEntry extends ReadableZipEntry {
  entryName: string;
  isDirectory: boolean;
  header: ReadableZipEntry['header'] & { attr?: number };
}

/** Why {@link planZipEntries} skipped an entry. Each surface words it in its own answer. */
export type ZipSkipReason =
  /** Past {@link ZipPlanLimits.entries}. */
  | 'too_many_entries'
  /** A name {@link zipEntryNameRefusal} refuses; `detail` is its reason. */
  | 'invalid_name'
  /** A name that would land outside the destination. */
  | 'escapes_destination'
  /** A symbolic link ({@link isSymlinkZipEntry}). */
  | 'link'
  /** A directory entry at the path a planned file lands at. */
  | 'directory_is_a_file'
  /** A file past {@link ZipPlanLimits.entryBytes}. */
  | 'entry_too_large'
  /** A file past what is left of {@link ZipPlanLimits.totalBytes}. */
  | 'total_too_large'
  /** A file whose bytes cannot be read as its header says ({@link readZipEntry}); `detail` says how. */
  | 'unreadable';

/**
 * One entry of an archive, as {@link planZipEntries} plans it. `name` is the
 * entry's name with `/` separators (`(empty)` when it has none); `target` is
 * the workspace path it lands at, or, for a skipped entry, would have landed
 * at (null when its name gives it no place).
 */
export type ZipPlanStep =
  /** A file to land. `duplicate` when an earlier planned file lands at the same path. */
  | { kind: 'file'; name: string; target: string; data: Buffer; duplicate: boolean }
  | { kind: 'dir'; name: string; target: string }
  | { kind: 'skip'; name: string; target: string | null; reason: 'invalid_name' | 'unreadable'; detail: string }
  | { kind: 'skip'; name: string; target: string | null; reason: Exclude<ZipSkipReason, 'invalid_name' | 'unreadable'> };

/** A step {@link planZipEntries} skipped. */
export type ZipPlanSkip = Extract<ZipPlanStep, { kind: 'skip' }>;

/**
 * The ONE plan of an archive that both surfaces land: `unzip`
 * (`WorkspaceService.unzipFile`) and `apply_file_upload`. One step per entry,
 * in the archive's order: a file to land under `destination` (a workspace
 * path) with its bytes, a directory entry, or a skipped entry with the reason.
 *
 * It reads the archive and builds path strings, and never touches the
 * filesystem: what is on disk at a target, and whether the caller may write
 * there, are each surface's to ask.
 *
 * Per entry, in this order:
 *
 *  - macOS metadata ({@link isZipNoiseEntry}) is dropped: no step, and not
 *    counted toward `limits.entries`;
 *  - an entry past `limits.entries` is skipped;
 *  - a name {@link zipEntryNameRefusal} refuses is skipped, and so is one that
 *    would land outside `destination`;
 *  - a symbolic link is skipped;
 *  - a directory entry is a `dir` step;
 *  - a file is read through {@link readZipEntry}, never past
 *    `limits.entryBytes` nor past what is left of `limits.totalBytes`, and is
 *    skipped when it is past either or cannot be read.
 *
 * And two facts about the plan as a whole: a directory entry at the path a
 * planned file lands at is skipped, and a planned file whose path an earlier
 * planned file has is marked `duplicate`.
 *
 * `unzip` creates each directory entry its own checks let through;
 * `apply_file_upload` ignores them, since a folder comes into being with the
 * files under it. Neither acts on `duplicate`: `unzip` lands both files in one
 * batch, and `apply_file_upload` counts an earlier entry it kept as existing
 * when it judges `mode`, as `write_files` does.
 */
export function planZipEntries(
  zip: { getEntries(): PlannableZipEntry[] },
  destination: string,
  limits: ZipPlanLimits,
): ZipPlanStep[] {
  const steps: ZipPlanStep[] = [];
  const planned = new Set<string>();
  let counted = 0;
  let totalBytes = 0;
  /**
   * Where the entry named `rawName` lands under `destination`, or null when
   * its name gives it no place there. `zipEntryNameRefusal` already refuses a
   * `..` segment and a root-anchored name, so nothing should fail the
   * containment check; it stays because the cost of being wrong about that is
   * bytes landing outside the folder the caller named.
   */
  const landingOf = (rawName: string): string | null => {
    if (zipEntryNameRefusal(rawName) !== null) return null;
    const target = [destination, ...zipEntrySegments(rawName)].join('/');
    return target.startsWith(`${destination}/`) ? target : null;
  };
  for (const entry of zip.getEntries()) {
    const rawName = zipEntryName(entry.entryName);
    if (isZipNoiseEntry(rawName)) continue;
    const name = rawName || '(empty)';
    if (counted >= limits.entries) {
      steps.push({ kind: 'skip', name, target: landingOf(rawName), reason: 'too_many_entries' });
      continue;
    }
    counted++;
    const nameRefusal = zipEntryNameRefusal(rawName);
    if (nameRefusal !== null) {
      steps.push({ kind: 'skip', name, target: null, reason: 'invalid_name', detail: nameRefusal });
      continue;
    }
    const target = landingOf(rawName);
    if (target === null) {
      steps.push({ kind: 'skip', name, target: null, reason: 'escapes_destination' });
      continue;
    }
    if (isSymlinkZipEntry(entry)) {
      steps.push({ kind: 'skip', name, target, reason: 'link' });
      continue;
    }
    if (entry.isDirectory) {
      steps.push({ kind: 'dir', name, target });
      continue;
    }
    const left = limits.totalBytes - totalBytes;
    const read = readZipEntry(entry, Math.min(limits.entryBytes, left));
    if (!read.ok && read.reason === 'unreadable') {
      steps.push({ kind: 'skip', name, target, reason: 'unreadable', detail: read.detail });
      continue;
    }
    if (!read.ok) {
      // Past the per-file cap when the entry declares more than that cap, or
      // when that cap was the tighter of the two; past the total otherwise.
      const pastEntryCap = entry.header.size > limits.entryBytes || left >= limits.entryBytes;
      steps.push({ kind: 'skip', name, target, reason: pastEntryCap ? 'entry_too_large' : 'total_too_large' });
      continue;
    }
    totalBytes += read.data.byteLength;
    steps.push({ kind: 'file', name, target, data: read.data, duplicate: planned.has(target) });
    planned.add(target);
  }
  return steps.map((step) =>
    step.kind === 'dir' && planned.has(step.target)
      ? { kind: 'skip', name: step.name, target: step.target, reason: 'directory_is_a_file' }
      : step,
  );
}
