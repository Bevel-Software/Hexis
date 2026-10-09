import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { hasHttpStatus, ToolError } from '../tool-helpers/tool.contract.js';
import { isAbsence } from '../../shared/fs.contract.js';
import type { DownloadArtifact } from './agent-download.store.js';

/** Why a requested path was left out. The first two are the only verdicts the access rules give. */
export const NOT_FOUND = 'not found';
export const DOWNLOAD_PERMISSION_REQUIRED = 'download permission required';
const EMPTY_FOLDER = 'the folder holds no files';

/** What `downloadCandidatesAt` answers for one requested path. */
export type DownloadCandidates =
  | { kind: 'missing' }
  | { kind: 'file' | 'folder'; files: { path: string; bytes: number }[] };

export interface DownloadBuildDeps {
  /** The repository's folder in the workspace (`knowledge-base`). */
  kbDirName: string;
  /** The uncompressed total one request may carry — its files once, and separately its folders' zips. */
  maxBytes: number;
  /** How many distinct files one request may carry. */
  maxFiles: number;
  /** What is at a workspace path: nothing, a file, or a folder's explorer-visible files (repository-relative). */
  candidatesAt(wsPath: string): Promise<DownloadCandidates>;
  /** The caller's `read` verdicts, repository-relative paths. */
  canReadBatch(paths: string[]): Promise<Map<string, boolean>>;
  /** The caller's `download` verdicts, repository-relative paths. */
  canDownloadBatch(paths: string[]): Promise<Map<string, boolean>>;
  /**
   * The caller's `download` verdict on a FOLDER (workspace path): the gate a
   * folder's zip passes before its files are judged one by one, as the
   * app's folder zip route gates it. A child's own grant does not open a
   * folder its rules deny.
   */
  canDownloadFolder?(wsPath: string): Promise<boolean>;
  /** The deployment's read hook for one workspace path; throws to refuse it. */
  notifyRead(wsPath: string): Promise<void>;
  /** The bytes of one workspace path. */
  readFile(wsPath: string): Promise<Buffer>;
  /** The `Content-Type` a file's link answers with. */
  contentTypeOf(wsPath: string, bytes: Buffer): string;
}

export interface IncludedFile {
  /** Workspace path (`knowledge-base/…`), the form every tool speaks. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface IncludedFolder {
  path: string;
  /** Uncompressed total of the files in its zip. */
  bytes: number;
  /** The workspace paths its zip holds. */
  files: string[];
}

export interface Refused {
  path: string;
  reason: string;
}

/** A request judged and captured: what goes out, in link order, and what was left out. */
export interface BuiltDownload {
  files: IncludedFile[];
  folders: IncludedFolder[];
  refused: Refused[];
  /** One artifact per entry of `files`, then one per entry of `folders`, in that order. */
  artifacts: DownloadArtifact[];
}

/** The refusal a request over the size limit gets: the total and the limit, and no link. */
export function downloadTooLarge(total: number, maxBytes: number): ToolError {
  return new ToolError(
    `Those files total ${total} bytes uncompressed, over this deployment's ${maxBytes} byte download limit, so no ` +
      'link was issued. Ask for fewer paths at a time.',
    413,
    { kind: 'download-too-large', totalBytes: total, maxBytes },
  );
}

/** The refusal a request naming more files than one request may carry gets: no link. */
export function downloadTooManyFiles(maxFiles: number): ToolError {
  return new ToolError(
    `Those paths hold more than ${maxFiles} files, the most one download request may carry, so no link was ` +
      'issued. Ask for fewer or smaller folders at a time.',
    413,
    { kind: 'download-too-many-files', maxFiles },
  );
}

/**
 * The refusal a request gets when its folders' zips together would carry more
 * than the limit — a file inside two requested folders (`a/` and `a/b/`) is
 * packed into both, so the zips can outgrow the files they hold.
 */
function zipsTooLarge(total: number, maxBytes: number): ToolError {
  return new ToolError(
    `The requested folders' zips would total ${total} bytes uncompressed (a file inside two requested folders ` +
      `is packed into each), over this deployment's ${maxBytes} byte download limit, so no link was issued. Ask ` +
      'for fewer or non-overlapping folders at a time.',
    413,
    { kind: 'download-too-large', totalBytes: total, maxBytes },
  );
}

/**
 * Judge every file of a download request on its own, and capture the ones
 * that pass.
 *
 * A requested folder is expanded with the explorer's walk, and each file in
 * it is judged exactly as a file named directly is: included only when the
 * caller holds BOTH `read` and `download` on THAT file. `download` on the
 * folder is not enough — a file's own frontmatter or a nested `access.md` can
 * withhold it, and the app's folder zip once packed such files.
 *
 * A file the caller NAMED and may not read is `not found`, the same answer
 * as a path with nothing at it; a file met inside a requested folder that
 * they may not read is left out without a word — its name is what the read
 * model hides, and the explorer leaves it out the same way — and a folder
 * holding nothing they may read is `not found` too, as the explorer hides
 * such a folder outright (one with nothing in it at all "holds no files",
 * as the explorer shows it). A readable file they may not download is `download permission
 * required`, named either way: the explorer shows it. The file count a
 * request is held to counts only what the caller may read, so no refusal
 * tells them how many files they cannot see. Every included file then goes to the deployment's read
 * hook once, as a `read_file` of it would, and one the hook refuses is listed
 * with the hook's own words. One refused path never stops the others.
 *
 * The size limit is checked on the sizes on disk BEFORE any file is read, and
 * again on what was read; past it the whole request is refused. It holds twice
 * over: once on the distinct files (each file's own link), and once on the
 * folders' zips together, where a file is counted in every zip that packs it —
 * so what one request stores is bounded by twice the limit, however its
 * folders overlap. A request holding more than `maxFiles` readable files is
 * refused before any of them is read.
 */
export async function buildDownload(requested: string[], deps: DownloadBuildDeps): Promise<BuiltDownload> {
  const { kbDirName } = deps;
  const toWs = (rel: string): string => (rel ? `${kbDirName}/${rel}` : kbDirName);
  const refused: Refused[] = [];
  const refusedPaths = new Set<string>();
  const refuse = (path: string, reason: string): void => {
    if (refusedPaths.has(path)) return;
    refusedPaths.add(path);
    refused.push({ path, reason });
  };

  /** Every candidate file, named directly or found in a folder, once, in the order first met. */
  const sizes = new Map<string, number>();
  /** The files named directly, and each requested folder's files, before any verdict. */
  const direct: string[] = [];
  const candidates: { path: string; files: string[] }[] = [];
  for (const wsPath of [...new Set(requested)]) {
    let found: DownloadCandidates;
    try {
      found = await deps.candidatesAt(wsPath);
    } catch (err) {
      // A spelling the reads refuse (the git folder, a link) is a path the
      // caller may not read: answered as nothing there, like any other.
      if (hasHttpStatus(err) || isAbsence(err)) {
        refuse(wsPath, NOT_FOUND);
        continue;
      }
      throw err;
    }
    if (found.kind === 'missing') {
      refuse(wsPath, NOT_FOUND);
      continue;
    }
    for (const f of found.files) if (!sizes.has(f.path)) sizes.set(f.path, f.bytes);
    if (found.kind === 'folder') candidates.push({ path: wsPath, files: found.files.map((f) => f.path) });
    else direct.push(...found.files.map((f) => f.path));
  }

  // READ first, over everything found, before any other answer is given.
  const readable = sizes.size > 0 ? await deps.canReadBatch([...sizes.keys()]) : new Map<string, boolean>();
  // The count the caller is held to is the count of what they may read: a
  // refusal that counted hidden files would tell them how many there are.
  const visibleCount = [...sizes.keys()].filter((p) => readable.get(p) === true).length;
  if (visibleCount > deps.maxFiles) throw downloadTooManyFiles(deps.maxFiles);

  // A folder is answered as the explorer shows it. One with nothing in it
  // "holds no files". One whose every file the caller may not read is one
  // the explorer hides outright, so it is `not found` — the answer a folder
  // that is not there gets. Only a folder with something to show is then
  // asked for its own `download`: a zip of it is asked for as the app's
  // folder download is, before any file inside is judged — a file's own
  // grant must not open a folder its rules deny.
  const folders: { path: string; files: string[] }[] = [];
  for (const folder of candidates) {
    if (folder.files.length === 0) refuse(folder.path, EMPTY_FOLDER);
    else if (!folder.files.some((rel) => readable.get(rel) === true)) refuse(folder.path, NOT_FOUND);
    else if (deps.canDownloadFolder && !(await deps.canDownloadFolder(folder.path))) {
      refuse(folder.path, DOWNLOAD_PERMISSION_REQUIRED);
    } else folders.push(folder);
  }

  // Every file judged on its own: the named ones and the kept folders' —
  // read first, download on what may be read.
  const all = [...new Set([...direct, ...folders.flatMap((f) => f.files)])];
  const visible = all.filter((p) => readable.get(p) === true);
  const downloadable = visible.length > 0 ? await deps.canDownloadBatch(visible) : new Map<string, boolean>();
  const named = new Set(requested);
  const allowed: string[] = [];
  for (const rel of all) {
    if (readable.get(rel) !== true) {
      // Named by the caller: answered as nothing there. Found inside a folder:
      // not answered at all — listing it as refused would hand the caller the
      // name of a file the read model hides from them.
      if (named.has(toWs(rel))) refuse(toWs(rel), NOT_FOUND);
    } else if (downloadable.get(rel) !== true) refuse(toWs(rel), DOWNLOAD_PERMISSION_REQUIRED);
    else allowed.push(rel);
  }

  // The read hook, once per file that would be included.
  const passed: string[] = [];
  for (const rel of allowed) {
    try {
      await deps.notifyRead(toWs(rel));
      passed.push(rel);
    } catch (err) {
      if (!hasHttpStatus(err)) throw err;
      refuse(toWs(rel), err.message);
    }
  }

  // The limit, on the sizes on disk, before a byte is read.
  const declared = passed.reduce((sum, rel) => sum + (sizes.get(rel) ?? 0), 0);
  if (declared > deps.maxBytes) throw downloadTooLarge(declared, deps.maxBytes);
  const passedSet = new Set(passed);
  const zipsDeclared = folders.reduce(
    (sum, folder) => sum + folder.files.reduce((n, rel) => n + (passedSet.has(rel) ? (sizes.get(rel) ?? 0) : 0), 0),
    0,
  );
  if (zipsDeclared > deps.maxBytes) throw zipsTooLarge(zipsDeclared, deps.maxBytes);

  const files: IncludedFile[] = [];
  const artifacts: DownloadArtifact[] = [];
  const captured = new Map<string, Buffer>();
  let total = 0;
  for (const rel of passed) {
    const wsPath = toWs(rel);
    let data: Buffer;
    try {
      data = await deps.readFile(wsPath);
    } catch (err) {
      // Gone between the walk and the read: what a read a moment later says.
      if (isAbsence(err) || hasHttpStatus(err)) {
        refuse(wsPath, NOT_FOUND);
        continue;
      }
      throw err;
    }
    // Again on what was read: a file may have grown since it was measured.
    total += data.byteLength;
    if (total > deps.maxBytes) throw downloadTooLarge(total, deps.maxBytes);
    captured.set(rel, data);
    files.push({ path: wsPath, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') });
    artifacts.push({ data, contentType: deps.contentTypeOf(wsPath, data), filename: baseName(rel) || 'file' });
  }

  // One zip per requested folder that kept at least one file, its entries at
  // their full repository paths, so an upload of it at the repository root
  // lands every file where it came from.
  // Again on what was read, before a zip is built.
  const kept = folders.map((folder) => folder.files.filter((rel) => captured.has(rel)));
  const zipsTotal = kept.flat().reduce((sum, rel) => sum + captured.get(rel)!.byteLength, 0);
  if (zipsTotal > deps.maxBytes) throw zipsTooLarge(zipsTotal, deps.maxBytes);
  const zipped: IncludedFolder[] = [];
  for (const [i, folder] of folders.entries()) {
    const files = kept[i]!;
    if (files.length === 0) continue;
    const zip = new AdmZip();
    let bytes = 0;
    for (const rel of files) {
      const data = captured.get(rel)!;
      zip.addFile(rel, data);
      bytes += data.byteLength;
    }
    zipped.push({ path: folder.path, bytes, files: files.map(toWs) });
    const rel = folder.path === kbDirName ? '' : folder.path.slice(kbDirName.length + 1).replace(/\/+$/, '');
    artifacts.push({
      data: zip.toBuffer(),
      contentType: 'application/zip',
      filename: `${baseName(rel) || kbDirName}.zip`,
    });
  }

  return { files, folders: zipped, refused, artifacts };
}

function baseName(rel: string): string {
  return rel.split('/').filter(Boolean).pop() ?? '';
}
