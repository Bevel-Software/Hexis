import { spawn } from 'node:child_process';
import nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import type { Router, RequestHandler } from 'express';
import type { LocalFilesystem } from '@mastra/core/workspace';
import type { IToolRegistry, JsonSchema } from '../tool-registry/tool.contract.js';
import { hasHttpStatus, ToolError, type ToolContext, type ToolHandler } from '../tool-helpers/tool.contract.js';
import { BRANCH_INPUT, toolDef } from '../tool-helpers/tool-def.js';
import {
  notifyAgentRead,
  assertAgentWriteAllowed,
  SESSION_ID_INPUT,
  type AgentAccessGate,
} from './agent-access.gate.js';
import type { IRoutineWritePolicy } from './routine-write-policy.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import { requireInternalSource, requireExternalSource } from '../tool-auth/tool-auth.middleware.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import { GitInternalsError, WorkflowValidationError } from '../../shared/domain-errors.js';
// Leaf-level shared primitive (same exception `workspace.service.ts` already
// relies on) — not a workflow service, so this stays inside the module boundary.
import { assertValidBranchName } from '../kb-fs/branch-name.js';
import {
  assertInsideRepo,
  assertRepoRootNameFree,
  assertRepoRootNameFreeArgs,
  isInsideRepo,
  normalizePathArgs,
  normalizeWorkspacePath,
} from '../kb-fs/repo-path.js';
import { GitGuardedFilesystem } from '../kb-fs/git-guarded-filesystem.js';
import { assertNoGitInternalsSegment, assertNotGitInternals, hasGitInternalsSegment } from '../../shared/git-internals.js';
import { isRolesYamlPath } from '../access-model/roles-yaml-guard.js';
import type { ISessionSink } from './session-sink.js';
import { isAbsence, type ITreeWalker } from '../../shared/fs.contract.js';
import type { AccessDecisionSource, AccessTargetKind, IAccessControl } from '../access/access-control.interface.js';
import { accessRoster, resolveAccessView } from '../access/access-view.js';
import { accessMdPathForFolder, fileCarriesAccessRules, governingFolderOf } from '../access/access-mutation.service.js';
import { toKbRelative, resolveReadableMap } from '../access-model/kb-read-filter.js';
import type { SpillStore } from './spill-store.js';
import type { DocExtractService } from './file-readers/doc-extract.service.js';
import { displayPath, type FileKind, type FileReaderRegistry, type ReadResult } from './file-readers/file-reader.js';
import { fileTypeOf, needsContent } from './file-readers/content-mode.js';
import { createFileReaderRegistry } from './file-readers/file-reader.registry.js';
import { DocumentReader } from './file-readers/document-reader.js';
import { mcpImageResult } from '@bevel-software/platform-mcp-core';
import {
  folderPlaceholderPath,
  isFolderPlaceholder,
  isPlatformFile,
  isPlatformFolder,
  platformFileCreationRefusal,
  platformFileRefusal,
  platformFileUploadRefusal,
  platformFolderRefusal,
  isRepositoryOwnFile,
  repositoryOwnFileDeleteRefusal,
  entryExistsMessage,
  type ExistingEntryKind,
} from '@bevel-software/platform-shared';
import type { KbContext } from '../../shared/kb-context.js';
import { AccessDeniedError } from '../access-model/access-errors.js';
import {
  AGENT_GUIDE_FILE,
  isAgentGuidePath,
  isManagedGuide,
  withPlatformGuideAppended,
  type AgentGuideReader,
} from '../agent-guide/agent-guide.js';
import { removeEmptyDirs } from './empty-dirs.js';
import { FIRST_RUN_SECTION_ID, firstRunNote, knowledgeFolderIsNew, type FirstRunStarterSource } from './first-run.js';
import { planMoveLinks } from './move-links.js';
import { MoveLockedError, MoveRacedError, type LockingFilesystem } from '../kb-fs/locking-filesystem.js';
import { rethrowAsWriteDenial } from './write-denial.js';
import type { IChangeReadGate } from '../access-model/change-gate.js';
import { notFound, orDeclaredNotFound, orNotFound } from './not-found.js';
import { logger } from '../../shared/logging.js';
import { printable } from '../../shared/printable.js';
import { DestinationTakenError, inspectDestination } from '../../shared/rename-no-replace.js';
import { AgentUploadStore, type ClaimedUpload } from './agent-upload.store.js';
import type { IAgentDownloadStore } from './agent-download.store.js';
import { buildDownload } from './agent-download.builder.js';
import { DOWNLOAD_MAX_FILES, ZIP_DOWNLOAD_MAX_BYTES } from './workspace.service.js';
import {
  isSymlinkZipEntry,
  isZipNoiseEntry,
  readZipEntry,
  zipEntryName,
  zipEntryNameRefusal,
  zipEntrySegments,
} from './zip-entry-rules.js';

const log = logger('workspace-tools');

/** Types that run scripts wherever they are opened, sent by `request_file_download` as plain bytes. */
const ACTIVE_CONTENT_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml']);

/** The caller's verdict per access verb on one path. */
interface AccessVerbs {
  read: boolean;
  write: boolean;
  download: boolean;
  owner: boolean;
}

/** How many files `file_stat` counts under a folder before it stops and says so. */
const DESCENDANTS_CAP = 10_000;

/** How many of a folder's files a `delete_folder` answer names. */
const LISTED_FILES_CAP = 100;

/** A directory entry as returned by `LocalFilesystem.readdir`. */
interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  isSymlink?: boolean;
}

/**
 * Per-call read-permission gate. Built inside each read handler from the
 * caller's identity (`ctx.user.email`) and the branch they targeted, then
 * threaded into the filesystem walk so `read_file` / `list_files` / `grep`
 * never surface a KB node the user may not read.
 */
interface ReadGate {
  accessControl: IAccessControl;
  kbDirName: string;
  workspaceId: string;
  userEmail: string;
}

/** Throw a 403 ToolError if the gate denies reading `wsPath` (a KB node). */
async function assertCanRead(gate: ReadGate, wsPath: string): Promise<void> {
  const rel = toKbRelative(wsPath, gate.kbDirName);
  if (rel === null) return; // not a KB node — not governed by read rules
  const ok = await gate.accessControl.canRead(gate.workspaceId, gate.userEmail, rel);
  if (!ok) throw new ToolError(`You don't have permission to read "${wsPath}".`, 403);
}

/**
 * Drop the file entries the caller may not read from a directory listing.
 * Directory entries and non-KB files are always kept (a directory itself has
 * no `read:` verdict; its restricted children are filtered when read/listed) —
 * this is the AGENT's inclusion policy and differs from the explorer tree,
 * which hides restricted directories outright. Uses the FULL `canReadBatch`
 * (per-node frontmatter honoured), via the shared `resolveReadableMap`. One
 * batched ACL load per directory.
 */
async function filterReadableEntries(
  gate: ReadGate,
  dir: string,
  entries: DirEntry[],
): Promise<DirEntry[]> {
  const fileWsPaths: string[] = [];
  for (const e of entries) {
    if (e.type === 'directory') continue;
    fileWsPaths.push(dir ? `${dir}/${e.name}` : e.name);
  }
  if (fileWsPaths.length === 0) return entries;
  const verdict = await resolveReadableMap(
    (wid, email, rels) => gate.accessControl.canReadBatch(wid, email, rels),
    gate.workspaceId,
    gate.userEmail,
    gate.kbDirName,
    fileWsPaths,
  );
  return entries.filter((e) => {
    if (e.type === 'directory') return true;
    const wsPath = dir ? `${dir}/${e.name}` : e.name;
    return verdict.get(wsPath) === true;
  });
}

/**
 * Drop the empty-folder placeholder from a directory listing: it keeps a
 * folder alive in git and is never content (see `placeholder.ts`).
 */
function withoutPlaceholder(entries: DirEntry[]): DirEntry[] {
  return entries.filter((e) => e.type === 'directory' || !isFolderPlaceholder(e.name));
}

/**
 * Keep the folder a removal just emptied. A folder exists until it is deleted
 * explicitly, so when deleting or moving out its last entry leaves it empty it
 * gets the placeholder, written through the same filesystem (the agent's
 * lock-aware one commits it) within the same tool call. Only folders inside
 * the repository qualify, never the clone folder itself.
 *
 * It runs in the folder's turn, which the explicit folder delete also takes,
 * and looks inside it: a folder that is gone by then was deleted explicitly
 * and stays gone. A failure fails the call — the removal landed, but the
 * folder would vanish on the next clone, and the agent must hear that.
 */
async function keepFolderOf(
  fs: LocalFilesystem,
  ctx: ToolContext,
  branch: string,
  removedPath: string,
  kbDirName: string,
): Promise<void> {
  const trimmed = removedPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const dir = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) : '';
  if (!dir.startsWith(`${kbDirName}/`)) return;
  try {
    await ctx.workspaceService.withFolderTurn(workspaceIdForBranch(branch), dir, async () => {
      let entries: unknown[];
      try {
        entries = await fs.readdir(dir);
      } catch (err) {
        if (isAbsence(err)) return;
        throw err;
      }
      if (entries.length > 0) return;
      await fs.writeFile(folderPlaceholderPath(dir), '');
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`could not keep the folder ${printable(dir)} after removing ${printable(removedPath)}: ${printable(reason)}`);
    const message = `"${removedPath}" was removed, but its folder "${dir}" could not be kept: ${reason}`;
    // The original error keeps its status (a lock held elsewhere stays a 409).
    if (!(err instanceof Error)) throw new ToolError(message, 500);
    err.message = message;
    throw err;
  }
}

const int = (description: string): JsonSchema => ({ type: 'integer', description });

const str = (description: string): JsonSchema => ({ type: 'string', description });

/**
 * The upload route, named on every tool that takes content as a JSON string.
 *
 * ONE sentence, and the tools' own: it is what stops the three failures the
 * route was built for. An agent landing 27 files read each one and typed it
 * out again as a tool argument: a 37 KB write was truncated mid-answer, a page
 * of regex backslashes failed to parse as a JSON parameter, and a PNG could not
 * be sent at all. None of that is discoverable from a refusal — a truncated
 * write reports success — so the tools that invite it name where the bytes
 * should go instead, in the description itself, for a client that reads
 * nothing else. WHY, and how the route is used, is one of the shared rules
 * (`agent-instructions/shared-file-rules.ts`): said in full on three
 * descriptions it took each of them past the length a client cuts at.
 */
const UPLOAD_ROUTE_NOTE =
  ' Large, escape-heavy or binary content does not go through here: use `request_file_upload` + `apply_file_upload`.';

/**
 * A path input that names the clone folder, and says what happens when it does
 * not. The tools are rooted at the WORKSPACE dir, one level above the git clone,
 * so a path reaches git only when it starts with that folder — and a path that
 * does not name it is PLACED under it now rather than refused, by the one
 * normaliser every route and tool goes through. An agent that reads
 * `KnowledgeBase/Foo.md` in a URL or a doc and passes it verbatim gets the page
 * of that name in the repository, which is what it meant; it no longer gets a
 * refusal, and it never again gets a file written beside the repository where
 * nothing commits it. Saying so in the input itself, not only in prose, is what
 * the agent actually sees when it fills the argument.
 *
 * ONE sentence for every input, where there used to be a shorter second form for
 * the ones that could legitimately name a stray (a source to rescue, a file to
 * remove). Nothing can name a stray any more. Traversal (`.`/`..`), backslashes
 * and absolute paths are still refused, everywhere.
 */
const wsPath = (kbDirName: string, what: string): JsonSchema =>
  str(
    `${what}: under \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash (\`/${kbDirName}/…\` is the same path). ` +
      `A path without that prefix is placed under \`${kbDirName}/\`, so \`KnowledgeBase/Foo.md\` means \`${kbDirName}/KnowledgeBase/Foo.md\`; \`.\` or \`..\` segments, backslashes and absolute paths are refused.`,
  );

/**
 * The inputs each tool CREATES at, for the reserved-root-name rule (see
 * `assertRepoRootNameFreeArgs`). Destinations only: `src` of a copy or a move,
 * and the path of a delete, are left out on purpose, so an existing reserved
 * folder can be moved out of or removed. A tool absent here creates nothing.
 */
const RESERVED_ROOT_NAME_TARGETS: Readonly<Record<string, readonly string[]>> = {
  write_file: ['path'],
  write_files: ['files'],
  edit_file: ['path'],
  mkdir: ['path'],
  copy_file: ['dest'],
  move_file: ['dest'],
  unzip: ['destination'],
  // The folder the upload lands in. Each of its own paths is checked again
  // inside the handler — an archive chooses its entry names, not the caller.
  apply_file_upload: ['destination'],
};

function asText(content: string | Buffer): string {
  return typeof content === 'string' ? content : content.toString('utf8');
}

function asBytes(content: string | Buffer): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
}

/**
 * How many NOT-yet-cached documents one `grep` call will extract. Extraction
 * is the expensive step (unzip + parse; pdf.js for PDFs) and a cold grep over
 * a document-heavy KB would otherwise extract the whole tree inside a single
 * walk. Cached extractions are always searched (a cache hit costs one small
 * JSON read); beyond the budget the walk skips the document and the result
 * carries a note with the count, so the caller knows a re-run (or a
 * `read_file`, which extracts unbudgeted) will cover the rest.
 */
const UNCACHED_DOCS_PER_GREP = 20;

/** Per-grep-walk extraction state: the shared budget + how many documents it left unsearched. */
interface DocGrepState {
  readers: FileReaderRegistry;
  uncachedBudget: number;
  skippedUncached: number;
}

/** What a `binary_not_writable` refusal points to, in the order to try them. */
const BINARY_USE_INSTEAD = ['upload', 'copy_file', 'move_file'] as const;

/**
 * The ONE refusal the text tools give for content they must not write: status
 * 415, kind `binary_not_writable`, the file's kind, and the tools to use
 * instead — upload for new bytes, copy_file/move_file for bytes already in
 * the workspace. `explanation` is the format-specific why.
 */
function binaryNotWritable(fileKind: FileKind, explanation: string): ToolError {
  return new ToolError(
    `${explanation} [binary_not_writable: this file's kind is ${fileKind}; write_file, write_files and edit_file accept text only. ` +
      'Use upload for new bytes (`request_file_upload` + `apply_file_upload`, or Upload in the app), ' +
      'or copy_file / move_file to place bytes that are already in the workspace.]',
    415,
    { kind: 'binary_not_writable', fileKind, useInstead: [...BINARY_USE_INSTEAD] },
  );
}

/** The generic why, for a reader without format-specific refusal copy. */
const KIND_EXPLANATION: Record<FileKind, (path: string) => string> = {
  text: (p) => `"${p}" cannot be written as text.`,
  document: (p) =>
    `"${p}" is an office document/PDF. read_file returns EXTRACTED text for it — not the file's real ` +
    'content — so text written back cannot round-trip and would corrupt the document. To change it, ' +
    'replace the document by uploading a new version.',
  image: (p) => `"${p}" is an image. Its content is bytes, and text written to it could only produce a broken picture.`,
  archive: (p) => `"${p}" is an archive. Its content is bytes, and text written to it could only produce a broken archive.`,
  binary: (p) => `"${p}" is a binary file. Its content is bytes, and text written to it could only produce a broken file.`,
};

/**
 * The write-refusal by FORMAT on the agent TEXT-editing tools (write_file /
 * write_files / edit_file): documents (read_file returns an EXTRACTION, so
 * text written back would silently destroy the real document), images,
 * archives and other binary formats — every reader that declares
 * `textEditable: false`. Uploads and the plain HTTP write routes are
 * untouched — humans replacing a file is exactly the right move — and the
 * byte tools (copy/move/delete/unzip) never ask.
 */
function assertNotDocumentEdit(readers: FileReaderRegistry, path: string): void {
  const reader = readers.readerFor(path);
  if (reader.textEditable) return;
  const shown = displayPath(path);
  throw binaryNotWritable(reader.fileKind, reader.editRefusal?.(shown) ?? KIND_EXPLANATION[reader.fileKind](shown));
}

/**
 * The write-refusal for what a path ALREADY holds, as opposed to what its
 * extension means (see `assertNotDocumentEdit` for that half). Only the
 * fallback reader answers here today: an extensionless file may hold anything,
 * and `read_file` refuses binary content — so a write gate that never asked
 * would let an agent overwrite bytes it was not allowed to read.
 *
 * Costs one read of the existing file, and only for readers that ask the
 * question. A path with nothing at it is a CREATE: there is nothing to destroy.
 * For the tools that REPLACE a file without needing what it held (`write_file`,
 * `write_files`); `edit_file` holds the bytes already and asks
 * `assertBytesTextEditable` of each reading it takes.
 */
async function assertNotBinaryOverwrite(
  readers: FileReaderRegistry,
  path: string,
  fs: { readFile(p: string): Promise<string | Buffer> },
): Promise<void> {
  const reader = readers.readerFor(path);
  if (reader.editRefusalForExisting === undefined) return;
  let existing: Buffer;
  try {
    existing = asBytes(await fs.readFile(path));
  } catch (err) {
    // Only a MISSING file is a create (both raw Node errors and Mastra's
    // FileNotFoundError carry the disk's absence codes). Any other failure —
    // permissions, I/O — means the existing content could not be inspected:
    // propagate it rather than let the write destroy bytes the gate never saw.
    if (isAbsence(err)) return; // nothing there yet
    throw err;
  }
  assertBytesTextEditable(readers, path, existing);
}

/**
 * The same refusal, over bytes the caller already holds. Split out so a tool
 * that reads the file more than once — `edit_file`, before the lock and again
 * under it — judges EVERY reading with the one rule, and the bytes it replaces
 * are always bytes this gate has seen.
 */
function assertBytesTextEditable(readers: FileReaderRegistry, path: string, existing: Buffer): void {
  const refusal = readers.readerFor(path).editRefusalForExisting?.(existing, path) ?? null;
  if (refusal !== null) throw binaryNotWritable('binary', refusal);
}

/** What a write is ALLOWED to do at a path. `create` is the default everywhere. */
export type WriteMode = 'create' | 'overwrite' | 'update';

/** What a write actually DID at a path, in the answer the caller reads. */
export type WriteOutcome = 'created' | 'replaced' | 'updated';

/**
 * The `mode` input, on both write tools. Stated on the input itself and not
 * only in the description, because the argument is where an agent decides:
 * the default refuses to replace anything, so "write this here" can no longer
 * destroy a page the agent never read.
 */
const WRITE_MODE_INPUT: JsonSchema = {
  type: 'string',
  enum: ['create', 'overwrite', 'update'],
  description:
    'What the write may do at the path, default `create`: `create` writes a NEW file and refuses (`exists`) a path that already ' +
    'holds something; `overwrite` replaces what is there, and creates the file when there is nothing; `update` replaces an ' +
    'EXISTING file and refuses (`missing`) a path that holds nothing.',
};

/** The refusal `create` gives on a path that already holds something. */
function pathExists(path: string): ToolError {
  return new ToolError(
    `"${displayPath(path)}" already exists — pass mode: overwrite to replace it, or write to a different path.`,
    409,
    { code: 'exists', path },
  );
}

/** The refusal `update` gives on a path that holds nothing. */
function pathMissing(path: string): ToolError {
  return new ToolError(
    `"${displayPath(path)}" does not exist — pass mode: create to create it.`,
    404,
    { code: 'missing', path },
  );
}

/**
 * The mode gate for ONE path: refuses the write the mode does not allow, or
 * names what it is about to do. `create` on something that exists and `update`
 * on something that does not are the two refusals; everything else writes, and
 * the outcome distinguishes a file that was there from one that was not.
 */
function decideWrite(mode: WriteMode, path: string, exists: boolean): WriteOutcome {
  if (mode === 'create' && exists) throw pathExists(path);
  if (mode === 'update' && !exists) throw pathMissing(path);
  if (mode === 'update') return 'updated';
  return exists ? 'replaced' : 'created';
}

/**
 * How many of an upload's paths the answer NAMES before it stops and says how
 * many there were. A 300-file zip's full outcome list is pages of text an agent
 * pays for on every call; 25 is enough to see the shape of what happened, and
 * `total` plus `truncated` say that there is more. `all: true` asks for the
 * rest, for a caller that really does have to read each one.
 */
const APPLY_ANSWER_CAP = 25;

/**
 * How many entries of one uploaded archive are landed, and how many bytes of
 * uncompressed content in total.
 *
 * Tighter than `unzip`'s own caps on purpose. An apply lands its whole set as
 * ONE commit, which means every entry's bytes are held in memory at once —
 * the property that makes the commit atomic is the one that makes a zip bomb
 * expensive. The upload itself is already bounded by the deployment's upload
 * limit; these bound what that upload is allowed to expand into.
 */
const APPLY_MAX_ENTRIES = 5_000;
const APPLY_MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MB uncompressed

/**
 * One path of an upload, as `apply_file_upload` plans it: the bytes to write,
 * or the reason this path is refused before any gate is asked. A refused path
 * carries the name the archive held rather than a workspace path, because for
 * those the whole problem is that no workspace path can be built from it.
 */
interface PlannedUploadPath {
  path: string;
  content?: Buffer;
  error?: string;
  message?: string;
}

/**
 * Turn a stored upload into one planned path per file.
 *
 * A single file is one path: the destination plus the name it was sent with.
 * A zip is one path per member, with the member's folder structure kept under
 * the destination — judged by the same entry rules `unzip` applies
 * (`zip-entry-rules.ts`), plus one `unzip` does not have: an entry that is a
 * symbolic LINK is refused outright. A zip stores a link as a member whose
 * bytes are its target text, so a reader that ignored the mode bits would
 * write that text out as a file — content nobody sent, under a name that was
 * meant to point elsewhere.
 */
/** The refusal an entry gets when the archive would expand past what one commit lands. */
function tooLargeToApply(): string {
  return `This archive expands past the ${APPLY_MAX_TOTAL_BYTES} byte total the apply lands in one commit; this entry was not applied.`;
}

async function planUpload(
  upload: ClaimedUpload,
  destination: string,
  kbDirName: string,
): Promise<PlannedUploadPath[]> {
  const bytes = await nodeFs.readFile(upload.absolutePath);
  if (upload.kind !== 'zip') {
    return [{ path: `${destination}/${upload.filename}`, content: bytes }];
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch (err) {
    throw new ToolError(
      `"${upload.filename}" could not be opened as a .zip archive: ${err instanceof Error ? err.message : String(err)}`,
      422,
      { code: 'unreadable_archive' },
    );
  }
  const planned: PlannedUploadPath[] = [];
  let seen = 0;
  let totalBytes = 0;
  for (const entry of zip.getEntries()) {
    const rawName = zipEntryName(entry.entryName);
    if (isZipNoiseEntry(rawName)) continue;
    if (seen >= APPLY_MAX_ENTRIES) {
      planned.push({
        path: rawName || '(empty)',
        error: 'too_many_entries',
        message: `This archive holds more than ${APPLY_MAX_ENTRIES} entries; the rest were not applied.`,
      });
      continue;
    }
    seen++;
    const nameRefusal = zipEntryNameRefusal(rawName);
    if (nameRefusal !== null) {
      planned.push({ path: rawName || '(empty)', error: 'invalid_entry', message: nameRefusal });
      continue;
    }
    if (isSymlinkZipEntry(entry)) {
      planned.push({
        path: rawName,
        error: 'link',
        message: `"${rawName}" is a symbolic link, not a file; an upload lands files, never links.`,
      });
      continue;
    }
    // A folder comes into being with the files under it (the write path mkdirs
    // each parent), so a directory member has nothing of its own to land.
    if (entry.isDirectory) continue;
    const segments = zipEntrySegments(rawName);
    const target = [destination, ...segments].join('/');
    // Belt and braces: `zipEntryNameRefusal` already refuses a `..` segment
    // and a root-anchored name, so nothing should reach here that climbs out.
    // The check stays because the cost of being wrong about that is bytes
    // landing outside the folder the caller named.
    if (!target.startsWith(`${destination}/`) || !isInsideRepo(target, kbDirName)) {
      planned.push({ path: rawName, error: 'invalid_entry', message: 'Path escapes destination' });
      continue;
    }
    // Through the one bounded reader `unzip` uses too, capped at what is left
    // of the budget: a deflate stream can expand a thousandfold, and the
    // header's declared size is the archive's claim, not a fact — an entry
    // declaring ZERO would otherwise be inflated with no cap at all (see
    // `readZipEntry`). A read that fails is this entry's outcome and no more.
    const read = readZipEntry(entry, APPLY_MAX_TOTAL_BYTES - totalBytes);
    if (!read.ok) {
      planned.push(
        read.reason === 'too_large'
          ? { path: rawName, error: 'too_large', message: tooLargeToApply() }
          : { path: rawName, error: 'unreadable_entry', message: `"${rawName}" could not be read: ${read.detail}.` },
      );
      continue;
    }
    totalBytes += read.data.byteLength;
    planned.push({ path: target, content: read.data });
  }
  return planned;
}

/**
 * Record on `entry` that this path was refused, saying what the gate that
 * refused it said. Four kinds of refusal count as one path's outcome: a
 * typed tool refusal (`exists`, `platform_file`, the mode gate), a permission
 * refusal (the caller may not write this path, where the DESTINATION was
 * writable), the git folder in any spelling, and a path-shape refusal from the
 * repository rules. Anything else
 * is not a verdict about this path — it is a gate failing — so it travels on
 * and the whole apply fails loudly, exactly as it does in `write_files`.
 */
function refuseEntry(entry: Record<string, unknown>, err: unknown): void {
  entry.outcome = 'refused';
  if (err instanceof ToolError) {
    const details = (err.details ?? {}) as { code?: string; kind?: string };
    entry.error = details.code ?? details.kind ?? 'refused';
    entry.message = err.message;
    return;
  }
  if (err instanceof AccessDeniedError) {
    entry.error = 'write-denied';
    entry.message = err.message;
    return;
  }
  if (err instanceof GitInternalsError || err instanceof WorkflowValidationError) {
    entry.error = (err.payload as { kind?: string } | undefined)?.kind ?? 'refused';
    entry.message = err.message;
    return;
  }
  throw err;
}

/** The three modes, as a set the handler can check a raw argument against. */
const WRITE_MODES: readonly WriteMode[] = ['create', 'overwrite', 'update'];

/**
 * The call's mode — `create` when it says nothing, which is the whole point of
 * the default. A mode that is not one of the three is REFUSED rather than
 * treated as the nearest thing: a tool that quietly read `replace` as
 * "overwrite" would put the silent overwrite back, by a different door.
 */
function modeOf(a: Record<string, unknown>): WriteMode {
  if (a.mode === undefined || a.mode === null) return 'create';
  if (typeof a.mode === 'string' && (WRITE_MODES as readonly string[]).includes(a.mode)) return a.mode as WriteMode;
  throw new ToolError(
    `"${String(a.mode)}" is not a write mode: use ${WRITE_MODES.map((m) => `\`${m}\``).join(', ')} (default \`create\`).`,
    400,
    { code: 'bad_mode' },
  );
}

/**
 * What searching ONE file amounted to. The walk ignores this (a file with
 * nothing searchable is just a file with no matches), but a grep whose path
 * NAMES that one file has nothing else to report: without this it could only
 * answer an empty match list, which reads as "your pattern is not in there"
 * when the truth is "there was never any text to look at".
 */
type FileGrepOutcome =
  /** Its text was searched; any matches are in `out`. */
  | 'searched'
  /** No searchable text at all: an image, binary content, a corrupt document. */
  | 'no-text'
  /** A cold document the per-call extraction budget could not afford (counted in `docs`). */
  | 'budget-skipped';

/**
 * Search ONE file and append its matches to `out`. Shared by the directory
 * walk and by a grep whose `path` names a file, so both produce the same match
 * shape (that path, 1-based line numbers, 300-char text) under the same cap.
 *
 * What is searched is the file's reader's business: text content for the text
 * reader (null on NUL bytes / invalid UTF-8 — binary is not searchable), the
 * EXTRACTION for a document reader (marker line included, so the
 * `[slide N]`/`[sheet: …]`/`[page N]` lines are themselves searchable and line
 * numbers match what read_file returns), nothing for images.
 *
 * Throws whatever reading the file throws — the caller decides whether that is
 * a file to skip (the walk) or an error to surface (a single-file grep).
 */
async function grepOneFile(
  fs: LocalFilesystem,
  path: string,
  re: RegExp,
  out: { path: string; line: number; text: string }[],
  max: number,
  docs: DocGrepState,
): Promise<FileGrepOutcome> {
  const reader = docs.readers.readerFor(path);
  const bytes = asBytes(await fs.readFile(path));
  let content = reader.greppableText ? await reader.greppableText(bytes, path) : null;
  if (content === null && reader instanceof DocumentReader) {
    // Cold document (extraction not yet cached): cached ones above are free,
    // extracting draws on the per-walk budget (see UNCACHED_DOCS_PER_GREP) —
    // beyond it the search skips the document and counts it.
    if (docs.uncachedBudget <= 0) {
      docs.skippedUncached++;
      return 'budget-skipped';
    }
    docs.uncachedBudget--;
    const res = await reader.read(bytes, path);
    // A non-text outcome is a corrupt document — nothing searchable.
    content = res.kind === 'text' ? res.text : null;
  }
  if (content === null) return 'no-text';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) out.push({ path, line: i + 1, text: lines[i].slice(0, 300) });
  }
  return 'searched';
}

/**
 * What a grep's `path` actually names. The walk starts with `readdir`, which
 * fails on a file and on a path with nothing at it alike — both would end as a
 * silent empty result — so the search root is resolved FIRST and each case
 * gets its own honest answer.
 *
 * This helper never raises an error of its own. Only a DIRECTORY answer earns
 * the walk; everything else takes the single-file route, where the read gate
 * speaks first and the answer is then produced by the very `fs.readFile` that
 * `read_file` calls. That is what makes grep tell read_file's story for an odd
 * path by CONSTRUCTION rather than by coincidence.
 */
async function searchRootKind(
  fs: LocalFilesystem,
  path: string,
): Promise<'directory' | 'file' | 'missing'> {
  try {
    return (await fs.stat(path)).type === 'directory' ? 'directory' : 'file';
  } catch (err) {
    // "Nothing there" is the disk's own definition of absence: plain ENOENT,
    // and ENOTDIR for a path whose parent is an existing FILE
    // (`notes.md/deeper`) — nothing can live there either, so it earns the
    // same honest 404 rather than a raw failure. (Mastra's
    // FileNotFoundError carries these codes, as do raw Node errors.)
    if (isAbsence(err)) return 'missing';
    // Any OTHER stat failure — permissions, I/O, a symlink loop — is not
    // absence and is not this helper's to report. Calling it a file sends the
    // path down the ordinary single-file route: the gate answers 403 if the
    // caller may not read it, and otherwise the read itself fails exactly as
    // `read_file`'s does. Nothing is invented, and nothing extra is disclosed.
    return 'file';
  }
}

/** JS grep over the workspace tree (read methods only) — bounded by match + depth caps. */
async function grepWalk(
  fs: LocalFilesystem,
  dir: string,
  re: RegExp,
  out: { path: string; line: number; text: string }[],
  max: number,
  depth: number,
  gate: ReadGate,
  notifyRead: (path: string) => Promise<void>,
  docs: DocGrepState,
  /** A file the walk leaves to its caller: never opened, never counted against `max`. */
  skip: (path: string) => boolean = () => false,
): Promise<void> {
  if (out.length >= max || depth > 12) return;
  let entries;
  try {
    entries = (await fs.readdir(dir || '.')) as DirEntry[];
  } catch {
    return;
  }
  // Filter unreadable KB nodes out of the walk so grep never opens — or leaks
  // a line from — a file the caller may not read.
  entries = await filterReadableEntries(gate, dir, entries);
  for (const e of entries) {
    if (out.length >= max) return;
    if (hasGitInternalsSegment(e.name) || e.name === 'node_modules') continue;
    if (e.type !== 'directory' && isFolderPlaceholder(e.name)) continue;
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.type === 'directory') {
      await grepWalk(fs, p, re, out, max, depth + 1, gate, notifyRead, docs, skip);
    } else if (skip(p)) {
      continue;
    } else {
      // Opening a file is a read of it, even when the walk started at a root
      // the read hook was already told about — so every file the walk opens
      // reaches the hook by name (closes the read-leak).
      await notifyRead(p);
      // A file the walk cannot read is silently skipped: one unreadable entry
      // must not fail a search over the whole tree.
      try {
        await grepOneFile(fs, p, re, out, max, docs);
      } catch {
        continue;
      }
    }
  }
}

/** One `allowed-tools` entry a saved SKILL.md names that no visible tool matches. */
export interface SkillSaveWarning {
  entry: string;
  message: string;
  suggestion?: string;
}

/** The save-time skill check the write tools consult — satisfied by the skills module's `AllowedToolsChecker`. */
export interface SkillSaveCheck {
  checkSave(userEmail: string, path: string, content: string): Promise<SkillSaveWarning[]>;
  /** The batch form: `result[i]` is for `files[i]`, and the catalog is read once. */
  checkSaves(userEmail: string, files: readonly { path: string; content: string }[]): Promise<SkillSaveWarning[][]>;
}

const SAVE_WARNINGS_OUTPUT: JsonSchema = {
  type: 'array',
  description:
    'Present only when the file is a SKILL.md whose `allowed-tools` names platform tools you cannot use: ' +
    'each `{ entry, message, suggestion? }`. The write still happened.',
  items: { type: 'object' },
};

/**
 * The batch form of {@link SAVE_WARNINGS_OUTPUT}. A batch may save several
 * skills at once, so each warning also carries the `path` it is about —
 * without it the caller cannot tell which SKILL.md a warning names.
 */
const BATCH_SAVE_WARNINGS_OUTPUT: JsonSchema = {
  type: 'array',
  description:
    'Present only when the batch wrote a SKILL.md whose `allowed-tools` names platform tools you cannot use: ' +
    'each `{ path, entry, message, suggestion? }`, where `path` is the written file the warning is about. ' +
    'The writes still happened.',
  items: { type: 'object' },
};

/**
 * The `sessionId` property inside a BUILT tool def's input schema, or
 * `undefined` for a tool that declares none. `toolDef` wraps the flat inputs
 * under `body` and copies the schema it is given, so a note registered after
 * the tools were built has to be written here rather than onto the shared
 * `SESSION_ID_INPUT` constant.
 */
export function sessionIdInputOf(def: { inputs?: unknown }): { description?: string } | undefined {
  const inputs = def.inputs as
    | { properties?: { body?: { properties?: Record<string, { description?: string }> } } }
    | undefined;
  return inputs?.properties?.body?.properties?.sessionId;
}

/**
 * A read of ONE workspace file, exactly as `read_file` performs it: the read
 * hook, the access gate, the not-found refusal and the per-extension reader,
 * in that order. Rejects with the same `ToolError`s `read_file` rejects with.
 *
 * `offset`/`limit` and the `__tool_chain_spill__/…` ref are deliberately NOT
 * here: they are `read_file`'s own arguments, not part of what reading a file
 * means.
 */
export type ReadForTool = (
  branch: string,
  path: string,
  ctx: ToolContext,
) => Promise<ReadResult>;

/**
 * What the workspace tool registration hands back for another module to build
 * on, rather than re-deriving.
 *
 * One member today, and it is the only kind of thing that belongs here: a
 * behaviour the platform promises TWICE in the same words (`open_page`
 * answers "the way `read_file` does") and must therefore implement once.
 */
export interface WorkspaceToolsPorts {
  readForTool: ReadForTool;
}

/**
 * Workspace domain tools: the file primitives (replacing Mastra's auto-injected
 * Workspace tools) + unzip. Most just re-expose the SAME `LocalFilesystem`
 * methods Mastra's tools call (via `ctx.getFilesystem(a.branch as string)`), so behaviour is
 * identical and write-side ops still flow through the lock/commit pipeline.
 * `edit_file`, `grep`, and `execute_command` are tool-level (no filesystem
 * method), so they're implemented here. File ops are `both`; `execute_command`
 * is INTERNAL-only (arbitrary shell as the caller is too dangerous to expose).
 */
export function registerWorkspaceTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  spillStore: SpillStore,
  docExtract: DocExtractService,
  accessControl: IAccessControl,
  kb: KbContext,
  agentAccessGate: AgentAccessGate,
  writePolicy: IRoutineWritePolicy,
  sessionSink: ISessionSink,
  /**
   * Save-time skill check (see `AllowedToolsChecker`): a write to a SKILL.md
   * returns `warnings` for `allowed-tools` entries naming no visible tool.
   * Advisory only — it never refuses the write.
   */
  skillSaveCheck?: SkillSaveCheck,
  /**
   * Read-before-write, for the `write-denied` answer's "may you propose this
   * instead?" — the same verdict the lock applies on the draft the proposal
   * would be made on. Optional so tool harnesses need not wire it; the read
   * verdict alone then decides, which differs only at a root.
   */
  changeGate?: IChangeReadGate,
  /**
   * The upload-token store behind `request_file_upload` / `apply_file_upload`
   * — the route an agent lands bytes by, without their content passing
   * through the model. Optional for the same reason the two above are: a tool
   * harness that is about the file primitives need not stand one up. Every
   * real composition wires it (`create-core-server.ts`), and without it the
   * two tools are not mounted at all rather than mounted and broken.
   */
  uploads?: AgentUploadStore,
  /**
   * The platform's agent guide (see `modules/agent-guide`), which `read_file`
   * and `file_stat` answer at the guide's name in the repository root — after
   * the knowledge base's own file of that name, when it has one. Optional for
   * the harnesses that are about the file primitives; without it the two
   * tools read the disk and nothing else.
   */
  agentGuide?: AgentGuideReader,
  /**
   * The download-link store behind `request_file_download` — the way an agent
   * takes files OUT without their content passing through the model. Optional
   * for the harnesses about the file primitives; without it the tool is not
   * mounted.
   */
  downloads?: IAgentDownloadStore,
  /**
   * The starter pack the knowledge base was filled from, if any (see
   * `modules/onboarding`): its untouched pages do not end the `firstRun`
   * note, and the note names the pages it suggests. Optional; without it the
   * note reads the knowledge folder alone.
   */
  starterPacks?: FirstRunStarterSource,
  /**
   * The one tree walk (see `shared/fs.contract.ts`), for the `firstRun`
   * note's look at the knowledge folder. Optional for the harnesses about the
   * file primitives; without it `start_session` answers the id alone.
   */
  disk?: ITreeWalker,
): WorkspaceToolsPorts {
  const { kbDirName } = kb;
  /**
   * The one extension→reader registry every read-shaped decision routes
   * through: read_file dispatches on it, grep asks it for searchable text,
   * and the write-refusal consults its `textEditable`. Built once per mount
   * around the shared extraction cache.
   */
  const readers = createFileReaderRegistry(docExtract);

  /** `{ warnings }` when a saved skill names tools nobody can resolve, else `{}` — spread into a write's result. */
  const saveWarnings = async (
    ctx: ToolContext,
    path: string,
    content: string,
  ): Promise<{ warnings?: SkillSaveWarning[] }> => {
    if (!skillSaveCheck) return {};
    const warnings = await skillSaveCheck.checkSave(ctx.user.email, path, content);
    return warnings.length > 0 ? { warnings } : {};
  };

  /** Build the per-call read gate from the tool's branch input + caller identity. */
  const readGateFor = (branch: string, ctx: ToolContext): ReadGate => ({
    accessControl,
    kbDirName,
    workspaceId: workspaceIdForBranch(branch),
    userEmail: ctx.user.email,
  });

  /** A repo-relative path in the workspace-relative form every tool speaks. */
  const toWs = (rel: string): string => (rel ? `${kbDirName}/${rel}` : kbDirName);
  const sourceToWs = (s: AccessDecisionSource | null) => (s ? { ...s, path: toWs(s.path) } : null);

  /**
   * What `file_stat` adds to its `access` verdicts when asked to explain them:
   * `why` each verdict holds, from the resolver the gates use, and — only for
   * someone who may write the path's access rules, the same gate the Manage
   * access dialog's grant route applies — the roster that dialog lists. A file
   * that cannot carry rules of its own is governed by its folder's
   * `access.md`, so that is the file the gate asks about.
   */
  const explainAccessAt = async (branch: string, ctx: ToolContext, p: string, kind: AccessTargetKind) => {
    const norm = p.replace(/^\/+/, '').replace(/\/+$/, '');
    const rel = norm === kbDirName ? '' : toKbRelative(norm, kbDirName);
    if (rel === null) {
      return { why: null, roster: null, rosterReason: `"${p}" is outside the \`${kbDirName}/\` repository, so no access rules apply to it.` };
    }
    if (!accessControl.explainAccess) throw new ToolError('Access explanation is not available on this server.', 501);
    const workspaceId = workspaceIdForBranch(branch);
    const email = ctx.user.email;
    const explained = await accessControl.explainAccess(workspaceId, email, kind, rel);
    const why = Object.fromEntries(
      Object.entries(explained).map(([verb, { source, via, principal }]) => [verb, { source: sourceToWs(source), via, principal }]),
    );
    const rulesPath =
      kind === 'folder'
        ? accessMdPathForFolder(rel)
        : fileCarriesAccessRules(rel)
          ? rel
          : accessMdPathForFolder(governingFolderOf(rel));
    if (!(await accessControl.canWrite(workspaceId, email, rulesPath))) {
      return {
        why,
        roster: null,
        rosterReason: `You cannot change who has access here (no write on ${toWs(rulesPath)}), so only your own access is shown.`,
      };
    }
    const roster = accessRoster(await resolveAccessView(accessControl, workspaceId, rel, email, kind), kind, rel);
    const rosterWs = Object.fromEntries(
      Object.entries(roster).map(([verb, entries]) => [
        verb,
        entries.map((e) => ({ ...e, sources: e.sources.map((s) => ({ ...s, path: toWs(s.path) })) })),
      ]),
    );
    return { why, roster: rosterWs };
  };

  /**
   * Refuse a file tool call that names the repository's git folder, in any
   * input, before any gate, lock or read runs (see `shared/git-internals.ts`).
   * Every spelling first, then the resolved form against the branch's
   * workspace, so a link into the folder is refused the same way. The resolved
   * check only runs on a branch that is already cloned: bootstrapping a clone
   * here would happen before the handler's access and agent-access gates. A branch
   * not cloned yet (or that does not resolve) is left to the handler; the
   * filesystem refuses again underneath regardless.
   */
  const toolPathArgs = (args: Record<string, unknown>): string[] => {
    const paths: string[] = [];
    for (const key of ['path', 'src', 'dest', 'destination'] as const) {
      if (typeof args[key] === 'string') paths.push(args[key]);
    }
    if (Array.isArray(args.files)) {
      for (const f of args.files as unknown[]) {
        const fp = f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined;
        if (typeof fp === 'string') paths.push(fp);
      }
    }
    return paths;
  };

  /**
   * The branch's workspace root, to judge a spelling against what is on disk
   * — or null when there is nothing to judge it against yet. Only a branch
   * ALREADY cloned is used: bootstrapping one here would clone before the
   * handler's access and agent-access gates have had their say.
   */
  const gitCheckRootFor = async (args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> => {
    if (typeof args.branch !== 'string' || args.branch === '') return null;
    try {
      if (!(await ctx.workspaceService.hasBootstrappedWorkspace(workspaceIdForBranch(args.branch)))) return null;
      const fs = await ctx.getFilesystem(args.branch);
      return fs instanceof GitGuardedFilesystem ? fs.basePath : null;
    } catch {
      return null;
    }
  };

  /**
   * The WHOLE rule — the spelling and where it lands, links resolved — over
   * the caller's own arguments, before any gate, lock or read.
   *
   * Run before `normalizePathArgs`, which refuses a `..` segment, a `.`
   * segment, a backslash and an absolute path as PATHS: a 400 that quotes the
   * spelling back and names a corrected one. That answer used to arrive first
   * for five families of spelling, so `knowledge-base/Notes/../.git/config`
   * was told which path it meant instead of being refused. Running only the
   * LEXICAL half here fixed those and left the same hole one step along: a
   * link into the folder (`Notes/../gitlink/config`) has no `.git` to read in
   * its spelling, so it took the path rule's answer too. Both halves therefore
   * read the caller's spelling before anything may rewrite or refuse it.
   *
   * Nothing under the folder was reachable through any of it — the filesystem
   * refuses again underneath — but which rule answers is not the caller's to
   * choose by how they spell the path.
   */
  const assertToolPathsNotGitInternals = async (args: Record<string, unknown>, ctx: ToolContext): Promise<void> => {
    const paths = toolPathArgs(args);
    for (const p of paths) assertNoGitInternalsSegment(p);
    const onDisk = paths.filter((p) => !spillStore.isSpillRef(p));
    if (onDisk.length === 0) return;
    const root = await gitCheckRootFor(args, ctx);
    if (root === null) return;
    for (const p of onDisk) await assertNotGitInternals(root, p);
  };

  // ── preflight for moves and deletes ─────────────────────────────────────
  // What an agent is told before (and instead of) a destructive operation:
  // whether the item is the platform's own, what the caller may do with it,
  // how much a folder takes with it, and — for a move — whether the caller's
  // access changes on the way. The same verdicts gate the execution, so a
  // dry run and the real call never disagree.

  /** The caller's verdicts on a KB path. A path outside the repository carries no rules. */
  const accessAt = async (branch: string, ctx: ToolContext, path: string): Promise<AccessVerbs> => {
    const rel = toKbRelative(path, kbDirName);
    if (rel === null) return { read: true, write: true, download: true, owner: false };
    const wid = workspaceIdForBranch(branch);
    const email = ctx.user.email;
    const [read, write, download, owner] = await Promise.all([
      accessControl.canRead(wid, email, rel),
      accessControl.canWrite(wid, email, rel),
      accessControl.canDownload(wid, email, rel),
      accessControl.canOwner(wid, email, rel),
    ]);
    return { read, write, download, owner };
  };

  /** Whether any one of the caller's four verdicts differs between the two sides of a preview. */
  const verbsDiffer = (before: AccessVerbs, after: AccessVerbs): boolean =>
    (Object.keys(before) as (keyof AccessVerbs)[]).some((v) => before[v] !== after[v]);

  /**
   * Why `copy_file` will not take a folder. One sentence, said by the dry
   * run and by the call itself, so the preflight and the execution never
   * disagree — the rule this whole section is built on.
   */
  const folderCopyRefusal = (src: string): string =>
    `"${src}" is a folder; copy_file copies one file. Copy its files one by one, or move the folder with move_file.`;

  /**
   * The caller's verdicts at `dest` as they will be once `src` has been
   * moved (or, with `sourceRemains`, copied) there — the `after` half of a
   * move's or copy's preview.
   *
   * `accessAt(dest)` is the wrong answer to that question for a folder: the
   * destination on disk has neither the folder nor the `access.md` files it
   * carries, so it describes the destination's PARENT. A rename of a folder
   * that names the caller owner in its own `access.md` therefore warned
   * about losing owner access the move was about to hand straight back, and
   * a warning that is wrong is a warning people learn to click through.
   *
   * Preview only, like everything else in this section: it answers what the
   * caller WILL have, never whether they may do it. The write verdicts that
   * gate the move are `writeBlocked` and the lock gate, both of which read
   * the tree as it is.
   */
  const accessAfter = async (
    branch: string,
    ctx: ToolContext,
    src: string,
    dest: string,
    opts?: { sourceRemains?: boolean },
  ): Promise<AccessVerbs> => {
    const from = toKbRelative(src, kbDirName);
    const to = toKbRelative(dest, kbDirName);
    // Outside the repository there are no rules to carry, and none to land
    // among — the same answer `accessAt` gives for such a path.
    if (from === null || to === null) return accessAt(branch, ctx, dest);
    return accessControl.previewAccessAfterRelocation(
      workspaceIdForBranch(branch),
      ctx.user.email,
      from,
      to,
      opts,
    );
  };

  /**
   * What `copy_file`'s dry run answers: the same impact shape `move_file`
   * previews, over a copy's own rules.
   *
   * A copy LEAVES the source where it is, so the rules it carries are
   * duplicated rather than relocated (`sourceRemains`) — otherwise the two
   * previews ask the same question. The order of the refusals is `copy_file`'s
   * own and is load-bearing: the write verdict on the destination outranks
   * "that name is taken", because a caller who may not write a folder must
   * not learn what is in it from a refusal.
   *
   * A folder source is reported as the refusal it is. `copy_file` copies one
   * file; the preview says so rather than promising a copy that would fail,
   * and still answers `access.after` for the folder it was asked about.
   *
   * NOTHING is probed on disk until the write verdict on the destination has
   * been taken — not the destination, and not the source either, which is the
   * order the call itself keeps at length: a caller who may not write there
   * gets the same refusal whether the source is a file, a folder, or missing
   * altogether. Probing the source first put a 404 in front of that 403 and
   * handed a denied caller the source's kind and its file count. So a refused
   * preview answers `allowed: false` with the sentence and no `kind` or
   * `descendants`: those are the half of the impact the caller has to have
   * earned. The two `access` sides are the caller's own four verbs and tell
   * them nothing they could not ask `file_stat` for.
   */
  const copyImpact = async (branch: string, ctx: ToolContext, src: string, dest: string) => {
    const [before, after, blocked] = await Promise.all([
      accessAt(branch, ctx, src),
      accessAfter(branch, ctx, src, dest, { sourceRemains: true }),
      writeBlocked(branch, ctx, [dest]),
    ]);
    const access = { before, after };
    const accessChanges = verbsDiffer(before, after);
    if (blocked.length > 0) {
      return {
        src,
        dest,
        access,
        accessChanges,
        allowed: false,
        reason: `You may not write "${dest}", so the copy cannot run.`,
        dryRun: true,
        copied: false,
      };
    }
    const fs = await ctx.getFilesystem(branch);
    const kind = await kindOf(fs, src);
    if (kind === null) throw notFound(src, 'Nothing to copy');
    const srcFiles = kind === 'folder' ? (await filesUnder(fs, src)).files : [src];
    const occupiedBy = await existingAt(await workspaceRoot(branch, ctx), dest);
    const reason = occupiedBy !== null
      ? entryExistsMessage(occupiedBy, dest)
      : kind === 'folder'
        ? folderCopyRefusal(src)
        : undefined;
    return {
      src,
      dest,
      kind,
      // The placeholder travels with its folder, but it is never content —
      // counted as `move_file` counts it.
      descendants: srcFiles.filter((f) => !isFolderPlaceholder(f)).length,
      access,
      accessChanges,
      allowed: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
      dryRun: true,
      copied: false,
    };
  };

  /**
   * The paths among `paths` the caller may NOT write, judged exactly as the
   * lock gate judges them (`WorkflowService.acquireLock`): on a protected
   * branch only, against the access tree at HEAD, with no rules at HEAD
   * meaning allow. Empty on a draft branch — changes there reach a protected
   * branch only through a change request.
   */
  const writeBlocked = async (branch: string, ctx: ToolContext, paths: string[]): Promise<string[]> => {
    if (!kb.isProtectedBranch(branch)) return [];
    const byRel = new Map<string, string>();
    for (const p of paths) {
      const rel = toKbRelative(p, kbDirName);
      if (rel !== null) byRel.set(rel, p);
    }
    if (byRel.size === 0) return [];
    const verdicts = await accessControl.canWriteBatchAtRef(
      workspaceIdForBranch(branch),
      'HEAD',
      ctx.user.email,
      [...byRel.keys()],
    );
    if (!verdicts) return [];
    return [...byRel].filter(([rel]) => verdicts.get(rel) !== true).map(([, p]) => p);
  };

  /**
   * The refusal the lock gate itself would raise for a path this tool's own
   * preflight already found unwritable — same `AccessDeniedError`, same
   * "Eligible: …" reading, from the same `eligibleWritersAtRef`.
   *
   * Raised as that error rather than as a finished body on purpose: every
   * proposable tool's handler is wrapped in ONE mapping
   * (`rethrowAsWriteDenial`), which turns an access refusal into the
   * `write-denied` answer with whether and how to propose instead. Going
   * through it means a refusal the preflight found and a refusal the gate
   * found are the same answer in the same shape, and there is one place that
   * decides what that shape is.
   */
  const writeRefusal = async (
    branch: string,
    path: string,
    /** What `path` is — a folder the move or delete was judged on, or a file. See `AccessDeniedDetails.targetKind`. */
    targetKind: 'file' | 'dir' = 'file',
  ): Promise<AccessDeniedError> => {
    const rel = toKbRelative(path, kbDirName);
    const eligible = rel === null
      ? null
      : await accessControl.eligibleWritersAtRef(workspaceIdForBranch(branch), 'HEAD', rel);
    return new AccessDeniedError({
      path,
      eligibleRoles: eligible?.roles ?? [],
      eligibleUsers: eligible?.users ?? [],
      targetKind,
    });
  };

  /** Whether a workspace-relative path is, or lies inside, a repository's `.git` metadata. */
  const isGitMetadata = (path: string): boolean => path.split('/').includes('.git');

  /**
   * Why the item at `path` is the platform's own and may not be moved or
   * deleted — a platform file, the root or a reserved root folder, or git
   * metadata — or undefined when it is content. Judged on `path`'s on-disk
   * spelling (see `onDiskSpelling`), so an alternate casing on a
   * case-insensitive disk is judged as the item it opens.
   */
  const managedReason = (path: string, kind: 'file' | 'folder'): string | undefined => {
    const norm = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (isGitMetadata(norm)) return `"${norm}" is git metadata and cannot be moved or deleted.`;
    if (kind === 'file') {
      const rel = toKbRelative(norm, kbDirName);
      return rel !== null && isPlatformFile(rel, kb.layout) ? platformFileRefusal(rel) : undefined;
    }
    if (norm === '' || norm === kbDirName) return platformFolderRefusal('');
    const rel = toKbRelative(norm, kbDirName);
    return rel !== null && isPlatformFolder(rel, kb.layout) ? platformFolderRefusal(rel) : undefined;
  };

  /**
   * Why `delete_file` may not delete the FILE at `path` whoever asks, or
   * undefined when the caller's write access decides. Narrower than
   * {@link managedReason}: a nested `access.md` never moves, but whoever may
   * write it may delete it — as in the app — and its folder then follows its
   * parent's rules. The root's `access.md` and `roles.yaml` are deleted by
   * nobody. Judged on the on-disk spelling, as `managedReason` is.
   */
  const fileDeleteRefusal = (path: string): string | undefined => {
    const norm = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (isGitMetadata(norm)) return managedReason(norm, 'file');
    const rel = toKbRelative(norm, kbDirName);
    if (rel === null || !isPlatformFile(rel, kb.layout)) return undefined;
    if (isRepositoryOwnFile(rel, kb.layout)) return repositoryOwnFileDeleteRefusal(rel);
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    return name === 'access.md' ? undefined : `${name} is a platform file and cannot be deleted through the agent tools.`;
  };

  /** The workspace root on disk for `branch`. */
  const workspaceRoot = (branch: string, ctx: ToolContext): Promise<string> =>
    ctx.workspaceService.getWorkspacePath(workspaceIdForBranch(branch));

  /**
   * `path` spelled as it is on disk: each segment that is not there verbatim
   * but matches exactly one entry case-insensitively takes that entry's name.
   * On a case-sensitive disk an existing path comes back unchanged; on a
   * case-insensitive one `knowledge-base/skills` comes back as the
   * `knowledge-base/Skills` it opens, so the platform checks see the real item.
   */
  const onDiskSpelling = async (root: string, path: string): Promise<string> => {
    const segments = path.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
    const out: string[] = [];
    for (const segment of segments) {
      let names: string[];
      try {
        names = await nodeFs.readdir(join(root, ...out));
      } catch {
        return [...out, ...segments.slice(out.length)].join('/');
      }
      if (!names.includes(segment)) {
        const matches = names.filter((n) => n.toLowerCase() === segment.toLowerCase());
        out.push(matches.length === 1 ? matches[0] : segment);
      } else {
        out.push(segment);
      }
    }
    return out.join('/');
  };

  /**
   * Refuse a path with a `.` or `..` segment or a backslash. Moves and deletes
   * judge the path as written — its access rules, its platform status, its
   * links — so it must be the path of the item that is changed:
   * `knowledge-base/Public/../Locked/x.md` would be judged under `Public/`
   * while removing `Locked/x.md`, or leave the clone altogether.
   */
  const assertPlainPath = (path: string): void => {
    const segments = path.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/');
    if (path.includes('\\') || segments.some((seg) => seg === '.' || seg === '..')) {
      throw new ToolError(`"${path}" may not contain "." or ".." segments or backslashes; name the item by its own path.`, 400);
    }
  };

  /**
   * The first part of `path` inside the repository that is a symbolic link —
   * the last part too, unless `allowLast` — or undefined. Never follows one.
   * The workspace root and the clone folder itself are the operator's and are
   * not judged.
   */
  const symlinkOnPath = async (root: string, path: string, allowLast = false): Promise<string | undefined> => {
    const segments = path.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
    if (segments[0] !== kbDirName) return undefined;
    const last = allowLast ? segments.length - 1 : segments.length;
    for (let i = 2; i <= last; i++) {
      const prefix = segments.slice(0, i).join('/');
      try {
        if ((await nodeFs.lstat(join(root, prefix))).isSymbolicLink()) return prefix;
      } catch (err) {
        if (isAbsence(err)) return undefined;
        throw err;
      }
    }
    return undefined;
  };

  /**
   * Refuse `path` when it is not plain (see `assertPlainPath`) or any part of
   * it inside the repository is a symbolic link — the last part too, unless
   * `allowLast` (a link removed on its own is just the link). A link on the way
   * would carry the write somewhere else — beside the clone, where git never
   * sees it, or into another folder whose rules were never consulted — so none
   * is followed.
   */
  const assertNoSymlinkOnPath = async (root: string, path: string, allowLast = false): Promise<void> => {
    assertPlainPath(path);
    const link = await symlinkOnPath(root, path, allowLast);
    if (link !== undefined) {
      throw new ToolError(`"${path}" goes through the symbolic link "${link}"; moves and deletes never follow links.`, 400);
    }
  };

  /**
   * What is already at `dest` — `file` or `folder` — or null when the name is
   * free. The kind is what the refusal names, so the sentence says "A folder
   * named …" of a folder.
   *
   * With `src`, the one case that is not a clash is the destination BEING the
   * source — `deal.md` → `Deal.md` on a case-insensitive disk, where the two
   * spellings are one entry. `inspectDestination` decides that, by the same
   * reading the move itself uses, so the preflight and the move cannot answer
   * differently: one inode is not enough (two hard links are one inode under
   * two names a user sees separately), the parent has to list one entry for
   * the two spellings. Without `src` — a copy, which creates a second entry
   * rather than moving the first — anything at `dest` is a clash, the source's
   * own alternate spelling included.
   */
  const existingAt = async (
    root: string,
    dest: string,
    src?: string,
  ): Promise<ExistingEntryKind | null> => {
    if (src !== undefined) {
      const verdict = await inspectDestination(join(root, src), join(root, dest));
      return verdict.state === 'taken' ? verdict.kind : null;
    }
    let destStat: import('node:fs').Stats;
    try {
      destStat = await nodeFs.lstat(join(root, dest));
    } catch (err) {
      if (isAbsence(err)) return null;
      throw err;
    }
    return destStat.isDirectory() ? 'folder' : 'file';
  };

  /**
   * Run a move or a copy and answer a lost race the way the look before it
   * would have: 409 with the one sentence. The filesystem refuses a taken
   * destination atomically (see `shared/rename-no-replace.ts`), which is what
   * makes the refusal true even when the name is claimed after the look; this
   * only carries that refusal out as a tool error rather than a 500.
   */
  const asEntryExists = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof DestinationTakenError) throw new ToolError(err.message, 409);
      throw err;
    }
  };

  const kindOf = async (fs: LocalFilesystem, path: string): Promise<'file' | 'folder' | null> => {
    try {
      return (await fs.stat(path)).type === 'directory' ? 'folder' : 'file';
    } catch (err) {
      if (isAbsence(err) || (err as { name?: string }).name === 'FileNotFoundError') return null;
      throw err;
    }
  };

  /**
   * Every file under `dir`, at any depth, as workspace-relative paths; counts to
   * `cap` (the walk itself goes on, for `links`). A symbolic link is listed as the entry it is, never followed, so the
   * walk cannot wander into a folder elsewhere, and is ALSO named in `links`:
   * the per-file delete cannot remove a link (it stats through it, so a dangling
   * link or a link to a folder fails), so a folder holding one is refused before
   * anything is deleted. The git folder is skipped, in any spelling of its name.
   */
  const filesUnder = async (
    fs: LocalFilesystem,
    dir: string,
    cap = Infinity,
  ): Promise<{ files: string[]; links: string[]; truncated: boolean }> => {
    const files: string[] = [];
    const links: string[] = [];
    let truncated = false;
    // The cap STOPS the walk, so a caller that passes one does bounded work on
    // a folder of any size. It is the deciding caller's job to make a
    // truncated answer a refusal rather than a guess: `file_stat`, the only
    // capped caller, answers `movable`/`deletable` false once `truncated` is
    // set, which covers the link it may not have reached. The tools that act —
    // `delete_folder`, `move_file` — pass no cap and see every file and every
    // link, because they must judge all of them.
    const walk = async (d: string): Promise<void> => {
      for (const e of (await fs.readdir(d)) as DirEntry[]) {
        if (truncated) return;
        const child = `${d.replace(/\/+$/, '')}/${e.name}`;
        if (hasGitInternalsSegment(e.name)) continue;
        if (e.type === 'directory' && !e.isSymlink) {
          await walk(child);
        } else {
          if (e.isSymlink) links.push(child);
          if (files.length < cap) files.push(child);
          else {
            truncated = true;
            return;
          }
        }
      }
    };
    await walk(dir);
    return { files, links, truncated };
  };

  /** Whether `path` itself is a symbolic link (never followed). */
  const isSymlinkAt = async (root: string, path: string): Promise<boolean> => {
    try {
      return (await nodeFs.lstat(join(root, path))).isSymbolicLink();
    } catch (err) {
      if (isAbsence(err)) return false;
      throw err;
    }
  };

  /** The refusal for a folder that holds symbolic links: named, with the way out. */
  const linksRefusal = (path: string, links: string[]): string =>
    `"${path}" holds ${links.length === 1 ? 'the symbolic link' : `${links.length} symbolic links, e.g.`} "${links[0]}"; ` +
    'the agent tools never follow or remove links, so the folder cannot be deleted through them. Remove the link outside the agent tools first.';

  /** The refusal for a path that is itself a symbolic link. */
  const linkRefusal = (path: string): string =>
    `"${path}" is a symbolic link; the agent tools never follow or remove links.`;

  const mount = (spec: {
    name: string;
    /**
     * A FUNCTION for a description that names something the layout decides —
     * the guide's file name, the platform files it belongs to. Those are
     * applied at boot, but also by the save that completes first-run setup,
     * which happens AFTER these tools are mounted; a plain string would
     * snapshot whatever was in effect at mount time and go on telling agents
     * to read `AGENTS.md` on a deployment that just named its guide something
     * else. Rebuilt from the function whenever the layout is applied (below).
     */
    description: string | (() => string);
    inputs: JsonSchema;
    outputs?: JsonSchema;
    write: boolean;
    internalOnly?: boolean;
    /**
     * A permission refusal from this tool is answered as `write-denied`
     * (with whether and how to propose the change instead), and the
     * description says so.
     */
    proposable?: boolean;
    /** False for a tool that is not a file tool (the shell), which the content rule does not describe. */
    fileTool?: boolean;
    /**
     * This tool runs through the agent-access gate, so a call to it reaches
     * the deployment's read or write hook. Such a tool carries the note the
     * deployment registered ({@link ToolDescriptionNotes}) at the end of its
     * description — core registers none, so on a core-only deployment the
     * flag adds nothing to what the agent reads.
     */
    gated?: boolean;
    /**
     * Refuse a read-only credential, as a write tool is refused, WITHOUT being
     * a write: the read-only-deployment gate does not apply. For a read a
     * read-only key may still not make (`request_file_download`).
     */
    writeScope?: boolean;
    /**
     * This tool resolves `branch` ITSELF and must not be pre-checked here.
     * Only `execute_command` sets it: for an internal session that leaves the
     * argument off, it falls back to the caller's own focused branch (from its
     * signed token) rather than refusing. It still answers the same
     * `branch-required` kind when there is nothing to fall back on — see its
     * handler. Every other tool takes the check below.
     */
    resolvesBranchItself?: boolean;
    /** Arguments this tool refuses by name itself, with its own wording (see `ToolDefSpec.refusesItself`). */
    refusesItself?: string[];
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    // Every description ends with ONE sentence pointing at the rules these
    // tools share — the content rule, the agent guide, the write modes, the
    // dry-run protocol, the proposal route. They used to be appended here in
    // FULL, which made a description several thousand characters of text the
    // agent had already read on the tool above, and clients cut a long
    // description from the END, where what is specific to the tool sits. The
    // rules themselves are in the handshake instructions and in the managed
    // guide (see `shared-file-rules.ts`), stated once and from one text.
    const describe = (): string =>
      (typeof spec.description === 'function' ? spec.description() : spec.description) +
      (spec.gated ? agentAccessGate.notes.gatedToolNote() : '');
    const def = toolDef({
      name: spec.name,
      description: describe(),
      path,
      inputs: spec.inputs,
      outputs: spec.outputs,
      refusesItself: spec.refusesItself,
      tags: spec.write ? ['workspace', 'write'] : ['workspace'],
    });
    // Every tool here declares `branch` required in its inputs, which is how
    // `toolDef` records it: the tool handler refuses a branch-less call before
    // the path work below and before any handler. Most of these tools would
    // meet the same refusal one layer down at `getFilesystem`, but not all —
    // `unzip` hands `branch` straight to the workspace service by id.
    registry.registerInternalTool(def);
    if (!spec.internalOnly) registry.registerExternalTool(def);
    /**
     * What the agent reads about this tool, rebuilt from whatever is in effect
     * NOW: the layout's names and the notes the deployment registered.
     *
     * The catalog FOLLOWS the layout. The conventions reminder above names the
     * guide, and several descriptions name it again as a platform file, so the
     * save that completes first-run setup — which applies the names the admin
     * just chose, in that same request, without a restart — must be able to
     * move the text with them. Rewritten in place: the registry holds this
     * object, both surfaces hold the same one, and re-registering would be a
     * duplicate name. The `sessionId` input is rewritten on the DEF rather
     * than on `SESSION_ID_INPUT`, because `toolDef` copies the schema it is
     * given.
     */
    const redescribe = (): void => {
      def.description = describe();
      const sessionId = sessionIdInputOf(def);
      if (sessionId) sessionId.description = agentAccessGate.notes.sessionIdDescription();
    };
    // Once for a note registered BEFORE the tools were mounted (the `sessionId`
    // input is copied by `toolDef`, so it carries the bare default until this
    // runs), and then on every later change: a note may be registered AFTER
    // the mount, from the tool-surface hook an overlay registers on.
    redescribe();
    kb.onLayoutApplied(redescribe);
    agentAccessGate.notes.onChange(redescribe);
    // Internal-only tools (e.g. `execute_command`) keep their route mounted —
    // our agent calls it over the same loopback — but gate it to internal-source
    // callers so an external connection key can't invoke it by name.
    router.post(
      path.slice('/api'.length),
      toolAuth,
      ...(spec.internalOnly ? [requireInternalSource] : []),
      // EVERY path input becomes a repository path here, once, before any
      // handler runs: the root-anchored `/<kbDirName>/…` form Copy path gives
      // names the same workspace path, and a path with no prefix at all is
      // placed under `<kbDirName>/` instead of being refused.
      //
      // The one exception is `read_file`'s `__tool_chain_spill__/…` ref, which
      // belongs to no workspace and is left exactly as it came — and it is
      // `read_file`'s ALONE. `read_file` is the only tool that consumes a
      // spill ref; for any other, `__tool_chain_spill__/x` is an ordinary
      // path, and exempting it there would be a workspace-relative path that
      // never reached the repository — the whole bug, spelled with a prefix.
      toolHandler(
        async (args, ctx) => {
          // BEFORE the normaliser: see `assertToolPathsNotGitInternals`.
          if (spec.fileTool !== false) await assertToolPathsNotGitInternals(args, ctx);
          const normalized = normalizePathArgs(
            args,
            kbDirName,
            spec.name === 'read_file' ? (v) => spillStore.isSpillRef(v) : undefined,
          );
          // The checkout's own name is reserved at the repository root on this
          // surface too. The routes meet that rule inside `WorkspaceService`;
          // these tools write through the locking filesystem, which never
          // enters it, so the rule is applied here — on the inputs a tool
          // CREATES at, never on a source, so an existing reserved folder can
          // still be moved out of or deleted.
          const creates = RESERVED_ROOT_NAME_TARGETS[spec.name];
          if (creates) assertRepoRootNameFreeArgs(normalized, kbDirName, creates);
          // The git folder is refused before the handler — and so before the
          // write-denial wrapper below, which would otherwise offer to propose
          // a change to it.
          if (spec.fileTool !== false) await assertToolPathsNotGitInternals(normalized, ctx);
          if (!spec.proposable) return spec.handler(normalized, ctx);
          try {
            // Awaited here so a refusal is caught; proposable tools never stream.
            return await spec.handler(normalized, ctx);
          } catch (err) {
            return rethrowAsWriteDenial(
              err,
              { tool: spec.name, branch: args.branch, userEmail: ctx.user.email, userId: ctx.user.id },
              accessControl,
              kb,
              changeGate,
            );
          }
        },
        // `execute_command` resolves its own branch (see `resolvesBranchItself`).
        { write: spec.write, writeScope: spec.writeScope, ...(spec.resolvesBranchItself ? { branch: 'own' as const } : {}) },
      ),
    );
  };

  // ── session bootstrap (external agents) ─────────────────────────────────
  // Every read/write tool below takes a `sessionId`: the conversation the
  // call belongs to, which is what a deployment's hooks scope their rule to.
  // The in-process agent carries its thread id, but an external agent has no
  // ambient run id, so this mints one up front (called ONCE); the MCP proxy
  // then threads it onto every later call via its sessionId-output continuity
  // convention. EXTERNAL-ONLY (not registered internal): the in-process agent
  // already supplies its session id and ignores any body value.
  //
  // WHAT the minted id is backed by is the `ISessionSink` port's business
  // (session-sink.ts). In the enterprise app it is a REAL chat-thread id, so
  // the SAME id works end to end: the file tools take it AND `ask` accepts it
  // (its sessionId IS a chat thread, resolved via getThread), so a run's reads
  // and its questions are one conversation rather than two. In a core-only
  // deployment (no chat/ask) the default sink mints a bare id.
  //
  // The description tells the caller that retrying is safe, and that is a
  // property of the sink rather than a promise this route makes on its own:
  // minting leaves nothing half-made. A call that failed created no session
  // (the core sink is a random id and does no I/O at all; a chat thread the
  // enterprise sink failed to create does not exist), and two calls that both
  // succeed leave two unrelated ids, neither of which invalidates the other.
  // Saying so matters because the alternative is a caller that reads a
  // transport hiccup on its first call as an unrecoverable start.
  const startSessionDef = toolDef({
    name: 'start_session',
    description:
      'Mint this conversation\'s id: the `sessionId` KnowledgeBase tools take. Call this ONCE, at the start of your work — minting a new id mid-run starts a second conversation as far as the server is concerned. The id is also a chat session in the app, so you can hand the SAME id to the `ask` tool: your reads and your questions are then one conversation. Pass the returned id as `sessionId` on every later KnowledgeBase tool call, inside `call_tool_chain` too. RETRYING IS SAFE: a call that fails created nothing, so retry it. If a retry lands after a success you hold two independent ids, which is harmless: keep passing the one you already used and ignore the other. Returns `{ sessionId }`, plus `firstRun` while the knowledge base is still empty: a note to act on.',
    path: '/api/agent/tools/start_session',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: {
        sessionId: str('The minted session id — pass it as `sessionId` on subsequent KnowledgeBase tool calls and to `ask`.'),
        firstRun: str(
          `Present only while the knowledge base holds nothing but its starter guide (and a starter pack's untouched pages): what to offer the person (the guide's \`${FIRST_RUN_SECTION_ID}\` section says how).`,
        ),
      },
      required: ['sessionId'],
    },
    tags: ['workspace'],
  });
  registry.registerExternalTool(startSessionDef);
  // Mint the session id via the sink and return it (see comment above: one id
  // spans start_session -> reads -> ask).
  router.post(
    '/agent/tools/start_session',
    toolAuth,
    // External-only: an internal token already carries its run's sessionId, so
    // minting a new thread mid-run would split one run in two. Note
    // "external" includes the MCP proxy's `externalProxy` loopback tokens
    // (OAuth/JWT MCP sessions) — the verifier resolves those to
    // `source: 'external'`, and one such session may legitimately mint several
    // per-chat sessionIds over its lifetime.
    requireExternalSource,
    toolHandler(async (_args, ctx) => {
      const { sessionId } = await sessionSink.createSession(ctx.user.id, new Date());
      const firstRun = await firstRunFor(ctx);
      return firstRun ? { sessionId, firstRun } : { sessionId };
    }),
  );

  /**
   * The `firstRun` note (see `first-run.ts`) while the default branch's
   * knowledge folder holds nothing but the starter guide, else null. Asked of
   * a clone that is ALREADY there — never one this call would have to make, so
   * the first call of a conversation does no clone — and never allowed to fail
   * the call: minting the id is what `start_session` is for, and the note is a
   * courtesy on top of it.
   */
  const firstRunFor = async (ctx: ToolContext): Promise<string | null> => {
    try {
      if (!disk || !kb.isBranchModelConfigured()) return null;
      const workspaceId = kb.defaultWorkspaceId();
      if (!(await ctx.workspaceService.hasBootstrappedWorkspace(workspaceId))) return null;
      const knowledgeDir = kb.layout.knowledgeBaseDir;
      // GATED LIKE A READ. The note says what the knowledge folder holds —
      // nothing, or a pack's pages still as the pack wrote them — so it goes
      // only to a caller who may read that folder, and judges the folder as
      // THEY may see it: a page they may not read does not make it old for
      // them (`mayRead` below), since reading the folder is no leave to learn
      // what restricted pages sit in it.
      if (!(await accessControl.canRead(workspaceId, ctx.user.email, knowledgeDir))) return null;
      const root = await ctx.workspaceService.getWorkspacePath(workspaceId);
      const mayRead = async (rels: string[]) => {
        const verdicts = await accessControl.canReadBatch(workspaceId, ctx.user.email, rels.map((rel) => `${knowledgeDir}/${rel}`));
        return new Map(rels.map((rel) => [rel, verdicts.get(`${knowledgeDir}/${rel}`) === true]));
      };
      // A starter pack's pages, still as the pack wrote them, are tasks to
      // fill in rather than pages anyone wrote: they leave the note standing,
      // and the note names what the pack suggests drafting first. A pack
      // page the caller may not read keeps the note away altogether: it
      // names the pack and what it suggests drafting, which is about pages
      // this caller is not to know of — in the checkout or gone from it.
      const starter = (await starterPacks?.firstRunStarter()) ?? null;
      const pages = starter ? await readableStarterPages(ctx, workspaceId, knowledgeDir, starter.pages) : undefined;
      if (starter && pages && pages.size < starter.pages.size) return null;
      if (!(await knowledgeFolderIsNew(disk, join(root, kbDirName), knowledgeDir, pages, mayRead))) return null;
      return firstRunNote(`${kbDirName}/${knowledgeDir}`, starter ?? undefined);
    } catch (err) {
      log.debug('start_session: could not tell whether the knowledge base is new', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  /** The starter pages (paths below the knowledge folder → text) the caller may read, and no other. */
  const readableStarterPages = async (
    ctx: ToolContext,
    workspaceId: string,
    knowledgeDir: string,
    pages: ReadonlyMap<string, string>,
  ): Promise<ReadonlyMap<string, string>> => {
    const rels = [...pages.keys()];
    const verdicts = await accessControl.canReadBatch(workspaceId, ctx.user.email, rels.map((rel) => `${knowledgeDir}/${rel}`));
    return new Map(rels.filter((rel) => verdicts.get(`${knowledgeDir}/${rel}`)).map((rel) => [rel, pages.get(rel)!]));
  };

  // ── reads ──────────────────────────────────────────────────────────────

  /**
   * What reading a workspace file ANSWERS, gate and all — `read_file`'s whole
   * behaviour minus the spill ref and the `offset`/`limit` slice, which are
   * that tool's own arguments.
   *
   * Factored out because a second tool has to answer the same way: `open_page`
   * (see `modules/embed`) promises the file's text "the way `read_file` does",
   * and the refusals `read_file` gives for a path the caller may not read or
   * one that does not exist. Any of that re-derived there would be a second
   * answer to a question with one correct answer — the access gate, the read
   * hook, the extraction and the not-found message all have to match, and a
   * copy drifts on the first change to any of them.
   */
  const readForTool: ReadForTool = async (branch, p, ctx) => {
    // The guide's name at the repository root answers with the platform's
    // guide, which is text the code owns and every agent may read: no gate
    // and no read hook for it. A file the knowledge base keeps under that
    // name is ITS OWN conventions page and is read as any file is — gated,
    // noted — and comes first, with the guide after it. A copy of the
    // guide an earlier release wrote to disk (still on a draft, say) is
    // recognised by its header and not served a second time.
    if (agentGuide && isAgentGuidePath(toKbRelative(p, kbDirName) ?? '')) {
      return { kind: 'text', text: await guideAt(branch, ctx, p) };
    }
    await notifyAgentRead(agentAccessGate, ctx, branch, p);
    await assertCanRead(readGateFor(branch, ctx), p);
    const fs = await ctx.getFilesystem(branch);
    // Reading (extraction, image and binary handling included) happens AFTER
    // the access gate and the read hook above — a document read is still a
    // KB read. ONE registry dispatch picks the reader by extension.
    const bytes = await orNotFound(p, async () => asBytes(await fs.readFile(p)));
    return readers.readerFor(p).read(bytes, p);
  };

  mount({
    name: 'read_file',
    gated: true,
    description:
      'Read a workspace file as text. Returns `{ path, content }`. What comes back for a document, an email file, an image ' +
      'or any other binary file is the content rule\'s business (see the shared rules): text files as text, documents and ' +
      'email files as extracted text, an image as the picture itself, anything else as a one-line description. ' +
      'Optional `offset`/`limit` slice the content (characters for a file, bytes for a `__tool_chain_spill__/…` ref; ignored ' +
      'for an image) — use them to page through large files or a `call_tool_chain` spill rather than reading multi-MB in full. ' +
      'It also reads a `__tool_chain_spill__/…` ref back from a truncated `call_tool_chain`: such a ref belongs to no ' +
      'workspace, so `branch` is ignored for it.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str(`Path to read, under \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash — a path without that prefix is placed under \`${kbDirName}/\` — or a \`__tool_chain_spill__/…\` ref from a truncated \`call_tool_chain\`.`),
        offset: int('Start character index (default 0).'),
        limit: int('Max characters to return from `offset`.'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { path: str('The path that was read (echoes the input).'), content: str('File (or spill) content, sliced if offset/limit were given.') },
      required: ['path', 'content'],
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      const p = a.path as string;
      const offset = typeof a.offset === 'number' ? a.offset : undefined;
      const limit = typeof a.limit === 'number' ? a.limit : undefined;
      if (spillStore.isSpillRef(p)) {
        return { path: p, content: await spillStore.read(p, offset, limit) };
      }
      const slice = (content: string): string => {
        const start = offset && offset > 0 ? offset : 0;
        return offset !== undefined || limit !== undefined
          ? content.slice(start, limit !== undefined ? start + limit : undefined)
          : content;
      };
      const result = await readForTool(a.branch as string, p, ctx);
      // Images return the picture itself as an MCP image content block, so a
      // multimodal model SEES it. The handler returns the `McpImageResult`
      // sentinel; the MCP result shaping (`toCallToolResult` in
      // platform-mcp-core) turns it into `content: [image, text-note]`. The
      // declared `outputs` schema (`{ path, content }`) intentionally does NOT
      // cover this shape: `outputs` is advisory documentation — never enforced
      // at the route, and not advertised over MCP (`toListedTool` exposes
      // `inputSchema` only) — and the image result is replaced wholesale by
      // content blocks before any client could try to validate it, so the
      // schema keeps describing the text path it has always described.
      // `offset`/`limit` are meaningless on a picture and are ignored.
      if (result.kind === 'image') {
        return mcpImageResult(result.data, result.mimeType, result.note);
      }
      // Text and refusals alike land in `content` — a refusal (corrupt
      // document, unreadable binary, oversized image) IS the file's honest
      // textual answer, sliced like any other content.
      const content = result.kind === 'text' ? result.text : result.message;
      return { path: p, content: slice(content) };
    },
  });

  /**
   * The knowledge base's OWN file at the guide's path, read as any file is —
   * through the read hook and the access gate — or null when there is none,
   * when the caller MAY NOT READ IT, or when what is there is a copy of the
   * platform's guide an earlier release wrote (recognised by its header),
   * which the guide served beside it would only repeat. A file that is not
   * text (a binary squatting the name) is read for what it is: its honest
   * textual answer.
   *
   * A file the caller may not read answers EXACTLY as no file does: the guide
   * alone, with nothing said. A refusal here would tell a caller the root
   * denies that a conventions file exists, which is the one thing the
   * platform never tells about a file someone may not read — a restricted
   * node is indistinguishable from an absent one on every other read.
   */
  /** What a read of the guide's path answers: the guide, after the knowledge base's own readable file when it has one. */
  const guideAt = async (branch: string, ctx: ToolContext, p: string): Promise<string> => {
    const guide = await agentGuide!();
    const own = await ownGuideFile(branch, ctx, p);
    return own === null ? guide : withPlatformGuideAppended(own, guide);
  };

  const ownGuideFile = async (branch: string, ctx: ToolContext, p: string): Promise<string | null> => {
    const fs = await ctx.getFilesystem(branch);
    // Existence first, then the gate, then the hook and the bytes — nothing of
    // theirs is read, or noted as read, before they are allowed to read it.
    if (!(await ownGuideReadable(fs, branch, ctx, p))) return null;
    await notifyAgentRead(agentAccessGate, ctx, branch, p);
    // Gone between the probe and the read — a concurrent delete — is the
    // absent case: the guide alone, as a read a moment later would answer.
    const bytes = await fs.readFile(p).then(asBytes, (err: unknown) => {
      if (isAbsence(err)) return null;
      throw err;
    });
    if (bytes === null) return null;
    const result = await readers.readerFor(p).read(bytes, p);
    const text = result.kind === 'text' ? result.text : result.kind === 'image' ? result.note : result.message;
    return isManagedGuide(text) ? null : text;
  };

  /**
   * Whether there is a file of the knowledge base's own at the guide's path
   * that THIS caller may read. False for nothing there and for a file the
   * access rules close to them, on purpose and without distinction (see
   * {@link ownGuideFile}).
   */
  const ownGuideReadable = async (fs: LocalFilesystem, branch: string, ctx: ToolContext, p: string): Promise<boolean> => {
    // The permission verdict BEFORE the filesystem is asked anything, as on
    // every other read: a caller the rules close the path to learns nothing
    // from it — not that something is there, and not what the filesystem
    // says about an entry it cannot stat.
    const gate = readGateFor(branch, ctx);
    const rel = toKbRelative(p, gate.kbDirName);
    if (rel !== null && !(await gate.accessControl.canRead(gate.workspaceId, gate.userEmail, rel))) return false;
    return existsAt(fs, p);
  };

  /** Whether something is at `p` on `fs` — absence is false, any other failure is thrown. */
  const existsAt = async (fs: LocalFilesystem, p: string): Promise<boolean> =>
    fs.stat(p).then(
      () => true,
      (err: unknown) => {
        if (isAbsence(err)) return false;
        throw err;
      },
    );

  /**
   * Whether what is at `p` is an entry of the knowledge base's own for the
   * ordinary stat to describe: anything there except a plain file that is a
   * copy of the guide an earlier release wrote (recognised by its header).
   * A folder at the guide's name is theirs and is never read — reading a
   * folder is an error, not an absence. Nothing there, at the stat or at the
   * read a moment later (a concurrent delete), is the absent case, which the
   * caller answers with the guide.
   */
  const isOwnEntryStill = async (fs: LocalFilesystem, p: string): Promise<boolean> => {
    const type = await fs.stat(p).then(
      (st) => st.type,
      (err: unknown) => {
        if (isAbsence(err)) return undefined;
        throw err;
      },
    );
    if (type === undefined) return false;
    if (type !== 'file') return true;
    const bytes = await fs.readFile(p).then(asBytes, (err: unknown) => {
      if (isAbsence(err)) return null;
      throw err;
    });
    if (bytes === null) return false;
    const result = await readers.readerFor(p).read(bytes, p);
    return !(result.kind === 'text' && isManagedGuide(result.text));
  };

  mount({
    name: 'list_files',
    gated: true,
    description:
      `List a directory. Returns \`{ path, entries: [{ name, type, size? }] }\`. Omit \`path\` for the workspace root, which holds the repository as the \`${kbDirName}/\` folder: every content path is under it (e.g. \`${kbDirName}/KnowledgeBase\`), and a path given without that prefix is placed under it.`,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str(`Directory to list, under \`${kbDirName}/\`, with or without a leading slash — a path without that prefix is placed under \`${kbDirName}/\` (default: the workspace root, where the repository is the \`${kbDirName}/\` folder).`),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: str('The directory listed (empty string for the root).'),
        entries: {
          type: 'array',
          description: 'Directory entries.',
          items: {
            type: 'object',
            properties: { name: str('Entry name.'), type: str('`file` or `directory`.'), size: int('Size in bytes (files only).') },
            required: ['name', 'type'],
          },
        },
      },
      required: ['path', 'entries'],
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      const dir = (a.path as string) || '';
      await notifyAgentRead(agentAccessGate, ctx, a.branch as string, dir);
      const fs = await ctx.getFilesystem(a.branch as string);
      const entries = withoutPlaceholder((await fs.readdir(dir || '.')) as DirEntry[]);
      const filtered = await filterReadableEntries(readGateFor(a.branch as string, ctx), dir, entries);
      return { path: a.path ?? '', entries: filtered };
    },
  });

  mount({
    name: 'file_stat',
    gated: true,
    description:
      'Get a file/directory\'s metadata (name, type, size, …) without returning content, and what you may DO with it. ' +
      'A file also reports `contentMode`, `kind`, `mime`, `mimeSource` and `textEditable` — decided by the same readers ' +
      'read_file, grep and the write tools use, so an extensionless text file is `text/plain`. ' +
      '`access: { read, write, download, owner }` is your own verdict under the access rules; pass `explainAccess: true` to ' +
      'learn why, and who else holds each verb. ' +
      'Call this before a move or delete: `managed`, `movable` and `deletable` answer the shared rules on what these tools ' +
      'never move or delete, judged like the dry runs (on a draft branch writes are not gated); `movable` judges the SOURCE ' +
      'side only, so the destination still wants a `move_file` dry run. ' +
      'For a folder, `descendants` counts the files under it at any depth; counting stops at 10000 and ' +
      '`descendantsTruncated` says so, past which `movable` and `deletable` are false (not judged in full): run the ' +
      '`move_file` or `delete_folder` dry run for the real verdict.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path'),
        explainAccess: {
          type: 'boolean',
          description:
            'Also explain `access` (default false): `access.why` says what decided each of your verdicts — the folder rules or file frontmatter and whether that is inherited; `access.roster` lists who holds each verb and where each grant is written, given only when you can manage this path\'s access (otherwise null, with `access.rosterReason`).',
        },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      description: "The filesystem entry's metadata.",
      properties: {
        name: str('Entry name.'),
        type: str('`file` or `directory`.'),
        size: int('Size in bytes.'),
        managed: { type: 'boolean', description: 'True for a platform file or platform folder.' },
        movable: { type: 'boolean', description: 'Whether `move_file` would be allowed for you.' },
        deletable: { type: 'boolean', description: 'Whether `delete_file` (a file) or `delete_folder` (a folder) would be allowed for you.' },
        access: {
          type: 'object',
          description: 'Your verdict per access verb on this path.',
          properties: {
            read: { type: 'boolean', description: 'You may read it.' },
            write: { type: 'boolean', description: 'You may write it.' },
            download: { type: 'boolean', description: 'You may download it.' },
            owner: { type: 'boolean', description: 'You own it.' },
            why: {
              type: ['object', 'null'],
              description:
                'Only with `explainAccess: true`. `why.<verb>` is `{ source, via, principal }`: `source` is `{ kind: folder | frontmatter, path, inherited }` (null when no rule decided it — default-deny, admin rescue, a machine-owned file, or Admin\'s write at a root with no rules); `via` is `person`, `group`, `role`, `plugin`, `everyone`, `admin-rescue`, `admin-floor` (Admin always keeps write at the repository root), `machine-owned` or `default-deny`. Null for a path outside the repository.',
            },
            roster: {
              type: ['object', 'null'],
              description:
                'Only with `explainAccess: true`. `roster.<verb>` lists `{ kind: group | role | plugin | person, name, email?, sources }` as the Manage access dialog does; null with `rosterReason` when you cannot manage this path\'s access. Paths start with the repository folder.',
            },
            rosterReason: str('Present when `roster` is null: why only your own access is shown.'),
          },
          required: ['read', 'write', 'download', 'owner'],
        },
        descendants: int('Folders only: files under it at any depth.'),
        descendantsTruncated: { type: 'boolean', description: 'Folders only: true when counting stopped at the cap.' },
        contentMode: {
          type: 'string',
          enum: ['text', 'document', 'binary'],
          description: 'Files only: what the file tools can do with the content — `text` (read/write/edit as text), `document` (read extracts; replace by upload), `binary` (bytes: copy/move/delete; replace by upload).',
        },
        kind: {
          type: 'string',
          enum: ['text', 'document', 'image', 'binary'],
          description: 'Files only: what the file is, as read_file treats it (archives are `binary`; `mime` names them).',
        },
        mime: str('Files only: the MIME type — named by the extension, `text/plain` for text content, else `application/octet-stream`.'),
        mimeSource: {
          type: 'string',
          enum: ['extension', 'sniff', 'fallback'],
          description: 'Files only: where `mime` came from. `fallback` means no type was detected.',
        },
        textEditable: { type: 'boolean', description: 'Files only: whether write_file/write_files/edit_file accept this file as it is now.' },
        mimeNote: str('Present when `mimeSource` is `fallback`: says the MIME type is a fallback, not a detected type.'),
        platformGuide: {
          type: 'boolean',
          description:
            "True at the agent guide's name in the repository root when the knowledge base has no file of its own there: what read_file answers is the platform's guide, which is not on disk and cannot be written, moved or deleted.",
        },
      },
      required: ['managed', 'movable', 'deletable', 'access'],
      additionalProperties: true,
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      const p = a.path as string;
      const branch = a.branch as string;
      // The guide's name with no file of the knowledge base's own under it —
      // or one the caller may not read, or a copy of the guide an earlier
      // release wrote, none of which `read_file` serves: what a read answers
      // there is the platform's guide, so stat says a text file is there to
      // read — ungated, like the read — and that nothing can be moved,
      // deleted or written at it through these tools. The three cases get
      // ONE answer on purpose: a different one for the file the caller may
      // not read would tell them it exists. A file of the knowledge base's
      // own that the caller may read is a file like any other, and the
      // ordinary answer below describes it.
      let noted = false;
      if (agentGuide && isAgentGuidePath(toKbRelative(p, kbDirName) ?? '')) {
        const fs = await ctx.getFilesystem(branch);
        const readable = await ownGuideReadable(fs, branch, ctx, p);
        // Telling the organisation's own file from a stale copy READS it, so
        // the read hook hears of it as it hears of a read_file there — after
        // the gate, never before, and once (the ordinary stat below is told).
        if (readable) {
          await notifyAgentRead(agentAccessGate, ctx, branch, p);
          noted = true;
        }
        const own = readable && (await isOwnEntryStill(fs, p));
        if (!own) {
          const guide = await agentGuide();
          return {
            name: p.slice(p.lastIndexOf('/') + 1),
            type: 'file',
            size: Buffer.byteLength(guide, 'utf8'),
            managed: true,
            movable: false,
            deletable: false,
            access: { read: true, write: false, download: false, owner: false },
            contentMode: 'text',
            kind: 'text',
            mime: 'text/markdown',
            mimeSource: 'extension',
            textEditable: false,
            platformGuide: true,
          };
        }
      }
      if (!noted) await notifyAgentRead(agentAccessGate, ctx, branch, p);
      await assertCanRead(readGateFor(branch, ctx), p);
      // Nothing there is a 404, and the placeholder — never content — gets
      // exactly that answer: the one every file tool gives (see not-found.ts).
      if (isFolderPlaceholder(p)) throw notFound(p);
      const fs = await ctx.getFilesystem(branch);
      const root = await workspaceRoot(branch, ctx);
      // Judged before `stat`, which follows links: a link anywhere on the path
      // (or a path move_file and delete_file would refuse as not plain) is
      // never movable or deletable, and a dangling one is named, not a 404.
      const segments = p.replace(/^\.?\/+/, '').replace(/\/+$/, '').split('/');
      const plain = !p.includes('\\') && !segments.some((seg) => seg === '.' || seg === '..');
      const viaLink = plain ? await symlinkOnPath(root, p) : undefined;
      let stat: Awaited<ReturnType<LocalFilesystem['stat']>>;
      try {
        stat = await fs.stat(p);
      } catch (err) {
        if (viaLink !== undefined) {
          throw new ToolError(`"${p}" goes through the symbolic link "${viaLink}", which leads nowhere; the agent tools never follow links.`, 400);
        }
        if (isAbsence(err)) throw notFound(p);
        throw err;
      }
      // The filesystem's own `mimeType` comes from a second extension table
      // (octet-stream for an extensionless text file) and would contradict
      // `mime` below, so it is never passed through.
      delete stat.mimeType;
      const kind = stat.type === 'directory' ? 'folder' : 'file';
      const onDisk = await onDiskSpelling(root, p);
      const managed = managedReason(onDisk, kind) !== undefined;
      // A nested `access.md` is managed — it never moves — yet deleted by
      // whoever may write it, so a FILE's delete is judged on its own rule.
      const undeletable = kind === 'file' ? fileDeleteRefusal(onDisk) !== undefined : managed;
      const verdicts = await accessAt(branch, ctx, p);
      const access =
        a.explainAccess === true ? { ...verdicts, ...(await explainAccessAt(branch, ctx, p, kind)) } : verdicts;
      const link = !plain || viaLink !== undefined;
      // Judged on the same paths move_file and delete_folder judge: a folder
      // move or delete touches every file under it, so a file its own rules
      // deny you makes the folder neither movable nor deletable, however
      // writable the folder is.
      //
      // Two bounds, because this is a READ tool the description tells agents
      // to call before every move and delete, and the folder it is asked about
      // may be the repository root:
      //   - a platform item or a path through a link is already not movable
      //     and not deletable, so no access verdict is asked for any file
      //     under it (the count below is a plain directory walk);
      //   - the walk stops at the cap, and a truncated walk answers
      //     `movable`/`deletable` false rather than judging part of a folder
      //     and calling it the whole (`delete_folder`'s dry run, which walks
      //     uncapped, remains the authority for a folder that large).
      const decided = (managed && undeletable) || link;
      const { files, links, truncated } =
        kind === 'folder'
          ? await filesUnder(fs, p, DESCENDANTS_CAP)
          : { files: [p], links: [] as string[], truncated: false };
      const judged = kind === 'folder' ? [p, ...files] : [p];
      const writable = decided ? false : (await writeBlocked(branch, ctx, judged)).length === 0;
      // A restricted run (see IRoutineWritePolicy) is refused per file by both tools.
      const policyAllows =
        !decided &&
        files.every((file) => {
          try {
            writePolicy.assertPathWritable(ctx.sessionId, file);
            return true;
          } catch {
            return false;
          }
        });
      const open = !decided && !truncated && writable && policyAllows;
      const out: Record<string, unknown> = {
        ...stat,
        managed,
        movable: open && !managed,
        // delete_folder also refuses a folder holding a link.
        deletable: open && !undeletable && links.length === 0,
        access,
      };
      if (kind === 'folder') {
        // The placeholder is never content: a folder holding only it has none.
        out.descendants = files.filter((f) => !isFolderPlaceholder(f)).length;
        if (truncated) out.descendantsTruncated = true;
        return out;
      }
      // A FILE also reports what the file tools can do with its content. The
      // mode is decided by the same registry the write gates consult, so what
      // stat reports is what write_file will do. Only a reader whose answer
      // depends on the bytes (the text fallback) costs a read — one full read,
      // the same one write_file/edit_file already pay on the same file. A
      // head-only sniff would be cheaper but wrong: invalid UTF-8 or a NUL
      // anywhere makes the write gate refuse, so stat must judge the same
      // bytes or it would report `text` for a file the write then refuses.
      // `kind` and `mime` come from that same reader too, so stat never calls
      // a file binary that read_file returns as text.
      const reader = readers.readerFor(p);
      const bytes = needsContent(reader)
        ? await orNotFound(p, async () => asBytes(await fs.readFile(p)))
        : undefined;
      return { ...out, ...fileTypeOf(reader, p, bytes) };
    },
  });

  mount({
    name: 'grep',
    gated: true,
    description:
      'Regex search across the workspace. Returns `{ matches: [{ path, line, text }] }` (capped). Use to find where something is defined/referenced. `path` may name a DIRECTORY (searches the subtree) or a single FILE (searches just that file); a path with nothing at it is an error, never an empty result. Searches INSIDE Office and OpenDocument files (.docx/.pptx/.xlsx, .odt/.odp/.ods), PDFs and email files (.eml/.msg) via their extracted text — matches there carry the extraction\'s line numbers, and the `[slide N]`/`[sheet: Name]`/`[page N]`/`[from]`/`[subject]` marker lines locate them; a bounded number of not-yet-extracted documents is extracted per call, and the result notes how many were skipped (re-run to cover them).',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        pattern: str('JavaScript regular expression.'),
        path: str(`Subtree to search, or a single file to search on its own, with or without a leading slash — a path without the \`${kbDirName}/\` prefix is placed under \`${kbDirName}/\` (default: the whole repository, \`${kbDirName}/\`).`),
        ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
        max_results: { type: 'integer', minimum: 1, maximum: 1000, description: 'Cap on matches (default 200).' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'pattern'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        matches: {
          type: 'array',
          description: 'Matching lines (capped by `max_results`).',
          items: {
            type: 'object',
            properties: { path: str('Workspace-relative file path.'), line: int('1-based line number.'), text: str('The matching line (truncated to 300 chars).') },
            required: ['path', 'line', 'text'],
          },
        },
        truncated: { type: 'boolean', description: 'True if the match cap was hit and results may be incomplete.' },
        note: str('Present when the empty/partial result needs explaining: a `path` naming a file with no searchable text (image, binary, corrupt document), or documents (office/PDF/email files) left unsearched because their text was not yet extracted and the per-call extraction budget ran out — re-run grep to cover those.'),
      },
      required: ['matches', 'truncated'],
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      let re: RegExp;
      try {
        re = new RegExp(a.pattern as string, a.ignore_case ? 'i' : '');
      } catch (err) {
        throw new ToolError(`Invalid regex: ${(err as Error).message}`, 400);
      }
      // No path means the whole REPOSITORY, not the workspace directory above
      // it. The workspace root also holds whatever an older build left beside
      // the checkout, and the read gate has no rules for a path outside the
      // repository — it answers "readable" — so a walk from there would hand
      // any caller the contents of every stray, including documents that were
      // uploaded to a restricted folder and landed beside it instead. The
      // boot note names those for an operator; no tool reads them.
      // An EMPTY string is the same absence: the normaliser leaves it alone
      // (an empty path is the handler's to explain), and here it would
      // otherwise name the workspace directory by another spelling.
      const searchRoot = typeof a.path === 'string' && a.path.length > 0 ? a.path : kbDirName;
      const fs = await ctx.getFilesystem(a.branch as string);
      const gate = readGateFor(a.branch as string, ctx);
      const out: { path: string; line: number; text: string }[] = [];
      const max = typeof a.max_results === 'number' ? Math.min(a.max_results, 1000) : 200;
      const docs: DocGrepState = { readers, uncachedBudget: UNCACHED_DOCS_PER_GREP, skippedUncached: 0 };
      // The empty root is the workspace itself — always a directory, and never
      // worth a stat.
      // A placeholder named on its own is searched as what it is to every
      // other tool: nothing.
      const kind =
        searchRoot === ''
          ? 'directory'
          : isFolderPlaceholder(searchRoot)
            ? 'missing'
            : await searchRootKind(fs, searchRoot);
      /** Why a single-file search found nothing, when "no matches" would be a lie. */
      let fileNote: string | undefined;
      // The guide is searched where it is read: a search of the repository
      // root covers it, and a search of its own path is a search of what
      // `read_file` answers there. The composed text is what is searched —
      // the knowledge base's own readable file first, then the platform's
      // guide — under the guide's path and with the line numbers a read of
      // it gives. The walk leaves that one file to this: a match the walk
      // made there would be the same line again, and one it COUNTED against
      // `max_results` would be a file later in the tree never searched while
      // the answer says nothing was cut. A file the caller may not read is
      // absent from it, as it is from the read.
      const guidePath = `${kbDirName}/${AGENT_GUIDE_FILE}`;
      const rel = toKbRelative(searchRoot, kbDirName);
      const coversGuide =
        agentGuide !== undefined && (kind === 'directory' ? rel === null : isAgentGuidePath(rel ?? ''));
      // The search root goes to the read hook — once, and only when it is
      // repository content: a folder, or a file of the knowledge base's own.
      // The guide's own path is not told here, because `guideAt` tells the
      // hook of the organisation's file there exactly as `read_file` does
      // (after the gate), and the platform's guide alone is nobody's file to
      // note. Each file the walk opens goes to the hook per file below, so a
      // hook sees every path a grep reached rather than only its root.
      if (!(coversGuide && kind !== 'directory')) {
        await notifyAgentRead(agentAccessGate, ctx, a.branch as string, searchRoot);
      }
      if (coversGuide) {
        if (kind === 'directory') {
          await grepWalk(
            fs,
            searchRoot,
            re,
            out,
            max,
            0,
            gate,
            (p) => notifyAgentRead(agentAccessGate, ctx, a.branch as string, p),
            docs,
            (p) => p === guidePath,
          );
        }
        const lines = (await guideAt(a.branch as string, ctx, guidePath)).split('\n');
        for (let i = 0; i < lines.length && out.length < max; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i]!)) out.push({ path: guidePath, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      } else if (kind === 'directory') {
        await grepWalk(
          fs,
          searchRoot,
          re,
          out,
          max,
          0,
          gate,
          (p) => notifyAgentRead(agentAccessGate, ctx, a.branch as string, p),
          docs,
        );
      } else {
        // Not a directory: the permission verdict comes BEFORE every other
        // one, and it is `read_file`'s own gate on the same path — so grep
        // answers a path the caller may not read exactly as read_file does,
        // and can never confirm the existence of one read_file would hide.
        // That ordering holds even when the stat itself failed: a denied path
        // gets the 403, never the filesystem's complaint about it.
        await assertCanRead(gate, searchRoot);
        if (kind === 'missing') throw notFound(searchRoot, 'Nothing to search');
        // A named FILE is searched directly: routing it through the walk would
        // fail its readdir and answer an empty match list, which the caller
        // cannot tell from "the pattern is not in this file".
        const outcome = await orNotFound(
          searchRoot,
          () => grepOneFile(fs, searchRoot, re, out, max, docs),
          'Nothing to search',
        );
        if (outcome === 'no-text') {
          fileNote =
            `"${displayPath(searchRoot)}" has no searchable text — it is an image, binary content, or a document ` +
            'whose text could not be extracted. There were no matches because there was nothing to search, not ' +
            'because the pattern is absent.';
        }
      }
      const note =
        fileNote ??
        (docs.skippedUncached > 0
          ? `${docs.skippedUncached} document(s) (office/PDF/email files) were not searched: their text was not yet ` +
            `extracted and this call's extraction budget (${UNCACHED_DOCS_PER_GREP}) ran out. Re-run the ` +
            'same grep to extract and search the next batch.'
          : undefined);
      return {
        matches: out,
        truncated: out.length >= max,
        ...(note !== undefined ? { note } : {}),
      };
    },
  });

  // ── writes (through the lock/commit pipeline) ───────────────────────────
  mount({
    name: 'write_file',
    // A mode that is not one of the three answers `bad_mode`, which lists them.
    refusesItself: ['mode'],
    gated: true,
    description:
      'Write a workspace TEXT file. The change is committed + pushed as you. Returns `{ path, bytes, outcome }`, where `outcome` is ' +
      '`created`, `replaced` or `updated`.' +
      UPLOAD_ROUTE_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path'),
        content: str('Full file content.'),
        mode: WRITE_MODE_INPUT,
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path', 'content'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: str('The path written (echoes the input).'),
        bytes: int('Number of bytes written.'),
        outcome: {
          type: 'string',
          enum: ['created', 'replaced', 'updated'],
          description: 'What the write did: `created` (nothing was there), `replaced` (`mode: overwrite` over an existing file), `updated` (`mode: update`).',
        },
        warnings: SAVE_WARNINGS_OUTPUT,
      },
      required: ['path', 'bytes', 'outcome'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      assertNotDocumentEdit(readers, a.path as string);
      // NB: this is a no-op for chat + `ontology_ingest` — it only bites when a
      // routine executor has explicitly restricted THIS session's `ctx.sessionId`
      // (today only `watchlist_check`, to `.html`). Unrestricted sessions pass straight
      // through (see `assertPathWritable`), so it does not limit other agents.
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertAgentWriteAllowed(agentAccessGate, ctx, a.branch as string, a.path as string);
      const mode = modeOf(a);
      const fs = await ctx.getFilesystem(a.branch as string);
      await assertNotBinaryOverwrite(readers,a.path as string, fs);
      // The mode is judged AFTER the content gates, so a file the tools may
      // not write as text is still answered with the capability refusal that
      // names the tool to use instead — not with "it already exists".
      const decide = async (): Promise<WriteOutcome> =>
        decideWrite(mode, a.path as string, (await kindOf(fs, a.path as string)) !== null);
      // Judged twice, on purpose. This first verdict is the cheap one, taken
      // before any lock so an ordinary refusal never contends for one — but it
      // is a verdict about a path anyone may still change. The one the answer
      // carries is taken again inside `writeFile`, with the path's lock HELD
      // (`write: true` guarantees the locking filesystem, as the batch cast
      // below does): only there can `create` be sure it is not about to
      // replace a file a human editor saved a moment ago, and `update` sure it
      // is not recreating one somebody just deleted. A filesystem without the
      // hook runs no second verdict, so the preflight one stands.
      const preflight = await decide();
      let locked: WriteOutcome | null = null;
      const locking = fs as unknown as {
        writeFile(
          path: string,
          content: string,
          options: undefined,
          check: () => Promise<void>,
        ): Promise<void>;
      };
      await locking.writeFile(a.path as string, a.content as string, undefined, async () => {
        locked = await decide();
      });
      return {
        path: a.path,
        bytes: Buffer.byteLength(a.content as string, 'utf8'),
        outcome: (locked ?? preflight) as WriteOutcome,
        ...(await saveWarnings(ctx, a.path as string, a.content as string)),
      };
    },
  });

  mount({
    name: 'write_files',
    // A mode that is not one of the three answers `bad_mode`, which lists them.
    refusesItself: ['mode'],
    gated: true,
    description:
      'Batch-write many files in ONE commit — far faster than calling write_file once per file when ' +
      'creating many files at once (e.g. seeding a knowledge base). Each entry is `{ path, content }`, and the files it ' +
      'writes are committed + pushed together as you. Prefer this over many write_file ' +
      'calls. Text files only. ' +
      'Returns `{ count, files }`: one entry per REQUESTED path, in the order you gave them, each `{ path, outcome }` — ' +
      '`created` / `replaced` / `updated` for a path it wrote, or `refused` with `error` (the code) and `message` (why) for a ' +
      'path it could not. `count` is how many were written. A path it refuses — the mode said no, or the file is not text — ' +
      'does not stop the others; read `files` to see what landed.' +
      UPLOAD_ROUTE_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        files: {
          type: 'array',
          description: 'Files to write; `mode` decides what each one may do at its path.',
          items: {
            type: 'object',
            properties: { path: wsPath(kbDirName, 'Path'), content: str('Full file content.') },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        mode: WRITE_MODE_INPUT,
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'files'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        count: int('Number of files written — the entries in `files` whose `outcome` is not `refused`.'),
        files: {
          type: 'array',
          description: 'One entry per REQUESTED path, in input order.',
          items: {
            type: 'object',
            properties: {
              path: str('The requested path (echoes the input).'),
              outcome: {
                type: 'string',
                enum: ['created', 'replaced', 'updated', 'refused'],
                description: 'What happened at this path. `refused` means nothing was written there and the file is untouched.',
              },
              error: str('Present when `outcome` is `refused`: the refusal code — `exists`, `missing` or `binary_not_writable`.'),
              message: str('Present when `outcome` is `refused`: the full refusal, the same one write_file would have given.'),
            },
            required: ['path', 'outcome'],
          },
        },
        warnings: BATCH_SAVE_WARNINGS_OUTPUT,
      },
      required: ['count', 'files'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      const files = (a.files as Array<{ path: string; content: string }>) ?? [];
      // The mode is judged before anything else, so an empty batch with a mode
      // that is not one answers `bad_mode` like any other call would.
      const mode = modeOf(a);
      if (files.length === 0) return { count: 0, files: [] };
      // The POLICY gate still judges the whole batch: a restricted run is a
      // call that should not have been made at all, not a per-path outcome.
      // The write hook is asked PER PATH, below, so a path it refuses is that
      // path's outcome and the rest of the batch still lands. What a single
      // FILE is (not text) or what its path already holds (the mode) is
      // decided per path too.
      for (const f of files) writePolicy.assertPathWritable(ctx.sessionId, f.path);
      const fs = await ctx.getFilesystem(a.branch as string);
      // `write: true` guarantees a LockingFilesystem here; `writeFiles` lands the
      // batch as one commit. Structural cast avoids a workflow-internal import.
      const batching = fs as unknown as {
        writeFiles(
          writes: { path: string; content: string }[],
          summary: string,
          deletes: string[],
          check: (
            pending: readonly { path: string; content: string }[],
          ) => Promise<{ path: string; content: string }[]>,
        ): Promise<void>;
      };
      const writes: { path: string; content: string }[] = [];
      const outcomes: Record<string, unknown>[] = [];
      /** The `files` entry for `writes[i]`, so the re-judgement can revise it. */
      const entryOf: Record<string, unknown>[] = [];
      /** Record on `entry` that this path was refused, as write_file would say it. */
      const refuse = (entry: Record<string, unknown>, err: unknown): void => {
        if (!(err instanceof ToolError)) throw err;
        const details = (err.details ?? {}) as { code?: string; kind?: string };
        entry.outcome = 'refused';
        entry.error = details.code ?? details.kind ?? 'refused';
        entry.message = err.message;
      };
      for (const f of files) {
        const entry: Record<string, unknown> = { path: f.path };
        outcomes.push(entry);
        try {
          await assertAgentWriteAllowed(agentAccessGate, ctx, a.branch as string, f.path);
        } catch (err) {
          // A DELIBERATE refusal by the deployment's write hook is this path's
          // outcome and no more: its message is what the caller is meant to
          // read, and one refused path must not take the others down. Anything
          // else the hook throws is not a verdict — it is the gate itself
          // failing — so `refuse` rethrows it and the whole batch fails loudly,
          // exactly as it does in `write_file`.
          refuse(entry, err);
          continue;
        }
        try {
          assertNotDocumentEdit(readers, f.path);
          await assertNotBinaryOverwrite(readers, f.path, fs);
          // An earlier entry in this same batch counts as existing: two `create`
          // entries for one path are a mistake the commit would otherwise hide.
          const exists = writes.some((w) => w.path === f.path) || (await kindOf(fs, f.path)) !== null;
          entry.outcome = decideWrite(mode, f.path, exists);
          writes.push({ path: f.path, content: f.content });
          entryOf.push(entry);
        } catch (err) {
          refuse(entry, err);
        }
      }
      // The same mode gate again, run by `writeFiles` once EVERY path's lock is
      // held — the verdict the answer carries, for the reason write_file states
      // above. `pending` is this batch's writes in the order they were handed
      // over, so `pending[i]` is `writes[i]` and `entryOf[i]` is its `files`
      // entry. A path whose verdict changed under the lock is dropped from the
      // batch and reported refused, leaving the rest of the batch to land.
      const recheck = async (
        pending: readonly { path: string; content: string }[],
      ): Promise<{ path: string; content: string }[]> => {
        const kept: { path: string; content: string }[] = [];
        for (let i = 0; i < pending.length; i++) {
          const entry = entryOf[i];
          try {
            const exists =
              kept.some((k) => k.path === pending[i].path) || (await kindOf(fs, pending[i].path)) !== null;
            entry.outcome = decideWrite(mode, pending[i].path, exists);
            kept.push(pending[i]);
          } catch (err) {
            refuse(entry, err);
          }
        }
        return kept;
      };
      if (writes.length > 0) {
        await batching.writeFiles(writes, `Write ${writes.length} file(s)`, [], recheck);
      }
      // Only the content that actually landed is checked: a refused entry wrote
      // nothing, and a path the batch names twice (which `overwrite` allows) is
      // judged by its LAST landed entry — the earlier one is not in the branch,
      // so warning about it would describe text nobody can find. `outcomes[i]`
      // is the entry for `files[i]`. One catalog read for the whole batch.
      const landed: number[] = [];
      for (let i = 0; i < files.length; i++) {
        if (outcomes[i].outcome === 'refused') continue;
        if (files.some((f, j) => j > i && f.path === files[i].path && outcomes[j].outcome !== 'refused')) continue;
        landed.push(i);
      }
      const warnings: (SkillSaveWarning & { path: string })[] = [];
      if (skillSaveCheck && landed.length > 0) {
        const perFile = await skillSaveCheck.checkSaves(ctx.user.email, landed.map((i) => files[i]));
        landed.forEach((i, k) => {
          warnings.push(...(perFile[k] ?? []).map((w) => ({ path: files[i].path, ...w })));
        });
      }
      return {
        count: outcomes.filter((o) => o.outcome !== 'refused').length,
        files: outcomes,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  });

  mount({
    name: 'edit_file',
    gated: true,
    description:
      'Replace an exact string in a workspace TEXT file. `old_string` must appear exactly once unless `replace_all`. Committed + pushed as you.' +
      UPLOAD_ROUTE_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path'),
        old_string: str('Exact text to replace (include enough context to be unique).'),
        new_string: str('Replacement text.'),
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { path: str('The path edited (echoes the input).'), replaced: int('Number of occurrences replaced.'), warnings: SAVE_WARNINGS_OUTPUT },
      required: ['path', 'replaced'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      assertNotDocumentEdit(readers, a.path as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertAgentWriteAllowed(agentAccessGate, ctx, a.branch as string, a.path as string);
      const fs = await ctx.getFilesystem(a.branch as string);
      const path = a.path as string;
      const oldStr = a.old_string as string;
      const newStr = a.new_string as string;
      // Everything the tool decides about ONE reading of the file: may these
      // bytes be edited as text at all, is `old_string` there, is it unique,
      // and what the file becomes. One function, because the file is read
      // twice — before the lock and under it — and a reading that skipped any
      // of these questions would let bytes land that were never judged.
      // `split`/`join`, not `String.replace`, which reads `$&`, `$'`, `` $` ``
      // and `$$` in `new_string` as patterns and writes something the caller
      // never sent.
      const edit = (existing: Buffer): { updated: string; replaced: number } => {
        assertBytesTextEditable(readers, path, existing);
        const text = asText(existing);
        const pieces = oldStr ? text.split(oldStr) : [text];
        const count = pieces.length - 1;
        if (count === 0) throw new ToolError('old_string not found in the file.', 400);
        if (count > 1 && a.replace_all !== true) {
          throw new ToolError(`old_string appears ${count} times — add more context to make it unique, or set replace_all.`, 400);
        }
        return { updated: pieces.join(newStr), replaced: count };
      };
      // A first verdict before any lock is taken, so an ordinary refusal costs
      // no lock cycle. It is a verdict about a file anyone may still change.
      let result = edit(await orNotFound(path, async () => asBytes(await fs.readFile(path))));
      // The one the answer carries is taken again with the path's lock HELD,
      // over the bytes read there (`write: true` guarantees the locking
      // filesystem): read, verdict and write are one step nobody can get
      // between. Taken before the lock only, two callers replacing the same
      // text — two runners claiming a work item by filling its empty owner
      // field — were BOTH told their edit landed, and the second silently
      // overwrote the first. A filesystem without the method has no lock to
      // read under, so the first verdict stands.
      const locking = fs as unknown as {
        rewriteFile?(path: string, rewrite: (current: Buffer | null) => string): Promise<void>;
      };
      if (typeof locking.rewriteFile === 'function') {
        await locking.rewriteFile(path, (current) => {
          if (current === null) throw notFound(path);
          result = edit(current);
          return result.updated;
        });
      } else {
        await fs.writeFile(path, result.updated);
      }
      return { path, replaced: result.replaced, ...(await saveWarnings(ctx, path, result.updated)) };
    },
  });

  mount({
    name: 'delete_file',
    gated: true,
    description:
      'Delete ONE workspace file. Committed + pushed as you. Its folder stays, even when this was its last file. Files only: a folder is refused with a pointer to `delete_folder`.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path to the file'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { path: str('The path deleted (echoes the input).'), deleted: { type: 'boolean', description: 'Always true on success.' } },
      required: ['path', 'deleted'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      // A delete carries no bytes from anywhere else — it removes a node — so
      // it goes to the READ hook, like a read, not the write hook. The
      // extension policy DOES apply though: a dashboard-only run must not
      // delete graph `.md` nodes.
      const path = a.path as string;
      const branch = a.branch as string;
      writePolicy.assertPathWritable(ctx.sessionId, path);
      await notifyAgentRead(agentAccessGate, ctx, branch, path);
      const fs = await ctx.getFilesystem(branch);
      assertPlainPath(path);
      const root = await workspaceRoot(branch, ctx);
      if (await isSymlinkAt(root, path)) throw new ToolError(linkRefusal(path), 400);
      if ((await kindOf(fs, path)) === 'folder') {
        throw new ToolError(`"${path}" is a folder, not a file — use delete_folder to delete it and the files under it.`, 400);
      }
      const onDisk = await onDiskSpelling(root, path);
      const refused = fileDeleteRefusal(onDisk);
      if (refused !== undefined) throw new ToolError(refused, 400);
      await assertNoSymlinkOnPath(root, path, true);
      if ((await writeBlocked(branch, ctx, [path])).length > 0) throw await writeRefusal(branch, path);
      await orNotFound(path, () => fs.deleteFile(path), 'Nothing to delete');
      // Deleting content is not deleting structure: an emptied folder stays.
      await keepFolderOf(fs, ctx, branch, path, kbDirName);
      return { path, deleted: true };
    },
  });

  mount({
    name: 'delete_folder',
    gated: true,
    description:
      'Delete a workspace FOLDER and every file under it, at any depth; the whole folder lands as ONE committed + pushed change as you — all of it or none of it — then the empty folder is removed. This is the one way a folder goes away: the folder that held it stays, even if this was all it had, and a folder holding nothing but its empty-folder placeholder counts as empty. ' +
      'The dry run answers `{ path, kind: "folder", descendants, files, filesTruncated, allowed, reason? }` — `descendants` is ' +
      'the file count, `files` names up to 100 of them — and a non-empty folder wants `confirm: true`. ' +
      'Beyond what the shared rules refuse, a folder HOLDING a symbolic link, or any file you may not write, is refused ' +
      '(the link itself is never removed), and a path that is a FILE ' +
      'is refused with a pointer to `delete_file`. You must be able to write the folder\'s own platform files too: they go ' +
      'with it in that same one change, so its files are never left ungoverned part-way.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Folder to delete'),
        dryRun: { type: 'boolean', description: 'Answer with the impact and change nothing.' },
        confirm: { type: 'boolean', description: 'Required to delete a non-empty folder. Set it only after a dry run.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: str('The folder (echoes the input).'),
        kind: str('Always `folder`.'),
        descendants: int('Files under the folder at any depth.'),
        files: { type: 'array', items: { type: 'string' }, description: 'Up to 100 of those files.' },
        filesTruncated: { type: 'boolean', description: 'True when `files` does not name every file.' },
        allowed: { type: 'boolean', description: 'Whether the delete may run.' },
        reason: str('Why it may not, when `allowed` is false.'),
        dryRun: { type: 'boolean', description: 'True on a dry run.' },
        confirmationRequired: { type: 'boolean', description: 'True when the call stopped for want of `confirm: true`.' },
        message: str('One sentence on what happened (or did not).'),
        deleted: { type: 'boolean', description: 'True once the folder is gone.' },
      },
      required: ['path', 'kind', 'descendants', 'allowed'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      const path = (a.path as string).replace(/\/+$/, '');
      const branch = a.branch as string;
      // The normaliser has already placed the path inside the repository; this
      // is the check that it really is in there before a folder is walked.
      assertInsideRepo(path, kbDirName);
      await notifyAgentRead(agentAccessGate, ctx, branch, path);
      const fs = await ctx.getFilesystem(branch);
      const kind = await kindOf(fs, path);
      if (kind === null) throw new ToolError(`"${path}" does not exist.`, 404);
      if (kind === 'file') {
        throw new ToolError(`"${path}" is a file, not a folder — use delete_file to delete it.`, 400);
      }
      const root = await workspaceRoot(branch, ctx);
      await assertNoSymlinkOnPath(root, path);
      /**
       * Everything the delete is judged on. `files` is every file that goes,
       * the empty-folder placeholders included; `content` leaves those out,
       * because a placeholder is never content — a folder holding nothing but
       * its placeholder is EMPTY, needs no confirmation, and reports no files.
       */
      const judge = async () => {
        const { files, links } = await filesUnder(fs, path);
        const content = files.filter((f) => !isFolderPlaceholder(f));
        // A restricted run is judged on what it would actually delete: the files.
        for (const f of files) writePolicy.assertPathWritable(ctx.sessionId, f);
        const managed = managedReason(await onDiskSpelling(root, path), 'folder');
        const blocked = managed !== undefined ? [] : await writeBlocked(branch, ctx, [path, ...files]);
        const linked = managed === undefined && links.length > 0 ? linksRefusal(path, links) : undefined;
        const reason = managed ?? linked ?? (blocked.length > 0
          ? `You may not write ${blocked.length === 1 ? `"${blocked[0]}"` : `${blocked.length} of the paths, e.g. "${blocked[0]}"`}, so the folder cannot be deleted.`
          : undefined);
        const impact = {
          path,
          kind: 'folder' as const,
          descendants: content.length,
          files: content.slice(0, LISTED_FILES_CAP),
          filesTruncated: content.length > LISTED_FILES_CAP,
          allowed: reason === undefined,
          ...(reason !== undefined ? { reason } : {}),
        };
        return { files, content, managed, linked, blocked, impact };
      };
      if (a.dryRun === true) return { ...(await judge()).impact, dryRun: true };

      // The real delete runs in the folder's TURN, judged again inside it: an
      // emptied folder being kept (`keepFolderOf`, which takes the turn of
      // the folder it keeps) can never write its placeholder into this folder
      // after the files below were enumerated, and so bring it back.
      const outcome = await ctx.workspaceService.withFolderTurn(workspaceIdForBranch(branch), path, async () => {
        const { files, content, managed, linked, blocked, impact } = await judge();
        if (managed !== undefined) throw new ToolError(managed, 400);
        if (linked !== undefined) throw new ToolError(linked, 400);
        if (blocked.length > 0) throw await writeRefusal(branch, blocked[0], blocked[0] === path ? 'dir' : 'file');
        if (content.length > 0 && a.confirm !== true) {
          return {
            ...impact,
            confirmationRequired: true,
            deleted: false,
            message: `Nothing was deleted: "${path}" holds ${content.length} ${content.length === 1 ? 'file' : 'files'}, so deleting it requires confirm: true.`,
          };
        }
        // ONE commit for the whole folder. `write: true` guarantees a
        // LockingFilesystem here, and its `writeFiles` takes every path's lock
        // BEFORE touching disk, deletes inside those locks and commits the set
        // as a single change (fail-closed: a refusal commits nothing). A folder
        // therefore never half-disappears, and its own `access.md` needs no
        // ordering trick to keep the rest governed on the way — nothing lands
        // until all of it does. The placeholders go too: this is the one
        // operation that removes a folder. Structural cast, as `write_files`
        // does, to avoid importing the workflow-internal class here.
        if (files.length > 0) {
          const batch = fs as unknown as {
            writeFiles(
              writes: { path: string; content: string }[],
              summary: string,
              deletes: string[],
            ): Promise<unknown>;
          };
          await batch.writeFiles([], `Delete ${path} and its ${content.length} file(s)`, files);
        }
        // Git tracks no folders: once the files are gone, the shells left on
        // disk are swept so the folder stops appearing in listings. Only empty
        // folders go, so a file a concurrent writer just dropped in survives.
        await removeEmptyDirs(join(root, path));
        return {
          ...impact,
          deleted: true,
          message: `Deleted "${path}" and its ${content.length} ${content.length === 1 ? 'file' : 'files'}.`,
        };
      });
      // The folder that HELD this one is not being deleted: if this was all it
      // had, it stays, with its placeholder. Outside the turn above — the
      // parent's turn overlaps it, and a folder turn is never nested.
      if (outcome.deleted) await keepFolderOf(fs, ctx, branch, path, kbDirName);
      return outcome;
    },
  });

  mount({
    name: 'mkdir',
    gated: true,
    description: 'Create a directory (recursive). It lists as an empty folder and persists in git until it is deleted explicitly.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Directory to create'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { path: str('The directory created (echoes the input).'), created: { type: 'boolean', description: 'Always true on success.' } },
      required: ['path', 'created'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertAgentWriteAllowed(agentAccessGate, ctx, a.branch as string, a.path as string);
      await (await ctx.getFilesystem(a.branch as string)).mkdir(a.path as string, { recursive: true });
      return { path: a.path, created: true };
    },
  });

  mount({
    name: 'move_file',
    gated: true,
    // A plain string again: what refuses a move names the guide, and that is in
    // the shared rules now, which are rebuilt from the layout where they live.
    description:
      'Move or rename a workspace FILE or FOLDER; a folder moves recursively, with everything under it. `dest` is the full new path, not the folder to move into. Committed + pushed as you. ' +
      'The destination must not exist — a move never overwrites a file or merges into a folder. Access follows the ' +
      'DESTINATION folder, so a move can change what you (and others) may do with the file: the dry run answers ' +
      '`{ src, dest, kind, descendants, access: { before, after }, accessChanges, allowed, reason? }`, where `access` is your ' +
      'own `{ read, write, download, owner }` at the source and at the destination AS IT WILL BE once the move has landed, ' +
      'with every `access.md` inside a moved folder counted at its new place, and a move whose `accessChanges` is true wants `confirm: true`. ' +
      'Links are rewritten by default, in one commit with the move: those in the moved files and those in other markdown files pointing at them (`links` reports them). `rewriteLinks: false` turns that off. Path mentions in plain prose or code are never changed.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: wsPath(kbDirName, 'Source path (file or folder)'),
        dest: wsPath(kbDirName, 'Destination path — the full new path; must not exist yet'),
        dryRun: { type: 'boolean', description: 'Answer with the impact and change nothing.' },
        confirm: { type: 'boolean', description: 'Required when the move changes your access. Set it only after a dry run.' },
        rewriteLinks: { type: 'boolean', description: 'Rewrite the links into, out of and between the moved files (default true). `false` moves without touching any link.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'src', 'dest'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        src: str('Source path (echoes the input).'),
        dest: str('Destination path (echoes the input).'),
        kind: str('`file` or `folder`.'),
        descendants: int('Files that move: 1 for a file, the file count under a folder.'),
        access: { type: 'object', description: 'Your `{ read, write, download, owner }` at the source (`before`) and at the destination once the move has landed (`after`).' },
        accessChanges: { type: 'boolean', description: 'True when any of your verdicts differs between `before` and `after`.' },
        allowed: { type: 'boolean', description: 'Whether the move may run.' },
        reason: str('Why it may not, when `allowed` is false.'),
        dryRun: { type: 'boolean', description: 'True on a dry run.' },
        confirmationRequired: { type: 'boolean', description: 'True when the call stopped for want of `confirm: true`.' },
        message: str('One sentence on what happened (or did not).'),
        moved: { type: 'boolean', description: 'True once the move landed.' },
        links: {
          type: 'object',
          description:
            'The link rewrite, the same on a dry run and on the move: `{ filesEdited, linksRewritten, edits: [{ path, from, to }] (the first 100), ' +
            'notRewritten: [{ path, reason, links }], unsearched? }`. Absent with `rewriteLinks: false`.',
        },
      },
      required: ['src', 'dest', 'moved'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      // Without trailing slashes: every path under a folder is derived from
      // these by prefix, and `filesUnder` names children without the slash.
      const src = (a.src as string).replace(/\/+$/, '');
      const dest = (a.dest as string).replace(/\/+$/, '');
      const branch = a.branch as string;
      // A move CARRIES the source content into the destination, so BOTH ends
      // go to the write hook (unlike a plain delete, which moves no content).
      // Ask about both BEFORE touching disk, so a refused end can't leave the
      // source already deleted.
      await assertAgentWriteAllowed(agentAccessGate, ctx, branch, src);
      await assertAgentWriteAllowed(agentAccessGate, ctx, branch, dest);
      const fs = await ctx.getFilesystem(branch);
      const root = await workspaceRoot(branch, ctx);
      // Before the kind check, which stats THROUGH a link: a dangling link at
      // `src` would otherwise be answered "does not exist".
      await assertNoSymlinkOnPath(root, src);
      await assertNoSymlinkOnPath(root, dest);
      const kind = await kindOf(fs, src);
      if (kind === null) throw notFound(src, 'Nothing to move');
      const srcFiles = kind === 'folder' ? (await filesUnder(fs, src)).files : [src];
      // A restricted run is judged on what it would actually write: each file
      // at its old and its new path, not an extensionless folder path.
      for (const f of srcFiles) {
        writePolicy.assertPathWritable(ctx.sessionId, f);
        writePolicy.assertPathWritable(ctx.sessionId, dest + f.slice(src.length));
      }

      // `after` is the destination as it WILL be — with the `access.md` files
      // under `src` counted where they land. See `accessAfter`.
      const [before, after] = await Promise.all([
        accessAt(branch, ctx, src),
        accessAfter(branch, ctx, src, dest),
      ]);
      const accessChanges = verbsDiffer(before, after);
      // The placeholder moves with its folder, but it is never content.
      const descendants = srcFiles.filter((f) => !isFolderPlaceholder(f)).length;
      // Neither end may be the platform's own: a move neither takes a platform
      // item away nor makes one (a note renamed to `access.md` would start
      // governing its folder). The source end is judged here; the destination
      // end waits for the write verdict below, because reading it at all is
      // what the caller has to have earned.
      const srcManaged = managedReason(await onDiskSpelling(root, src), kind);
      // A folder move deletes every file under `src` and creates it again under
      // `dest`, so every one of them is judged at both paths — a file its own
      // rules deny you is not carried off because its folder is writable. The
      // lock gate locks only the two folder paths, so this is the check.
      const destFiles = srcFiles.map((f) => dest + f.slice(src.length));
      // The write verdict comes FIRST, before anything that looks at the
      // destination. "A file named Notes.md already exists in Sales." is a
      // fact about a folder, and on a protected branch a caller who may not
      // write there must not learn it from a refusal — answering existence
      // first would make this tool an existence oracle for folders whose
      // contents the caller cannot otherwise see. A source the platform owns
      // is refused on the source alone and needs no destination at all.
      const blocked = srcManaged !== undefined
        ? []
        : await writeBlocked(branch, ctx, [src, dest, ...srcFiles, ...destFiles]);
      const mayReadDestination = blocked.length === 0;
      const destOnDisk = mayReadDestination ? await onDiskSpelling(root, dest) : dest;
      const destManaged = mayReadDestination ? managedReason(destOnDisk, kind) : undefined;
      const occupiedBy = srcManaged === undefined && mayReadDestination
        ? await existingAt(root, dest, src)
        : null;
      const collision = occupiedBy !== null;
      // Checked after the collision: onto an existing platform file, "already
      // exists" is the plainer answer.
      const createsManaged = srcManaged !== undefined || collision || destManaged === undefined
        ? undefined
        : isGitMetadata(destOnDisk)
          ? destManaged
          : kind === 'file'
            ? platformFileCreationRefusal(destOnDisk)
            : `"${destOnDisk}" is a platform folder; a move cannot create one.`;
      const managedWhy = srcManaged ?? createsManaged;
      const managed = managedWhy !== undefined;
      // Same order as the checks above: the write refusal outranks every
      // answer that had to look at the destination to be written.
      const reason = managed
        ? managedWhy
        : blocked.length > 0
          ? `You may not write ${blocked.length === 1 ? `"${blocked[0]}"` : `${blocked.length} of the paths, e.g. "${blocked[0]}"`}, so the move cannot run.`
          : occupiedBy !== null
            ? entryExistsMessage(occupiedBy, dest)
            : undefined;
      // The links are planned only for a move that may run: a refused one
      // reads no page. The plan is the same on a dry run and on the move.
      const rewriteLinks = a.rewriteLinks !== false;
      const linkPlan = rewriteLinks && reason === undefined
        ? await planMoveLinks({
          src,
          dest,
          branch,
          kbDirName,
          allFiles: await (async () => {
            const { files, links } = await filesUnder(fs, kbDirName);
            const symlinks = new Set(links);
            return files.filter((f) => !symlinks.has(f));
          })(),
          canRead: (paths) => resolveReadableMap(
            (wid, email, rels) => accessControl.canReadBatch(wid, email, rels),
            workspaceIdForBranch(branch),
            ctx.user.email,
            kbDirName,
            paths,
          ),
          writeBlocked: (paths) => writeBlocked(branch, ctx, paths),
          // Through the guarded filesystem the tools read with, never the raw
          // disk: a page replaced by a link since the listing is refused there
          // instead of read through to wherever the link points.
          readText: async (p) => String(await fs.readFile(p, { encoding: 'utf8' })),
          // The read hook, for every page the answer would NAME — an edited
          // one, one left with its links listed — and for no page merely
          // searched: naming is the disclosure, and the hook's refusal makes
          // the page one the caller cannot read, covered by the one sentence.
          readRefused: async (path) => {
            try {
              await notifyAgentRead(agentAccessGate, ctx, branch, path);
              return false;
            } catch {
              return true;
            }
          },
          // The write hook, for a page the move would edit, at its post-move path.
          writeRefusal: async (_lockAt, path) => {
            try {
              await assertAgentWriteAllowed(agentAccessGate, ctx, branch, path);
              return null;
            } catch (err) {
              return `refused: ${err instanceof Error ? err.message : String(err)}`;
            }
          },
        })
        : undefined;
      const moveReason = reason ?? linkPlan?.overCap;
      const impact = {
        src,
        dest,
        kind,
        descendants,
        access: { before, after },
        accessChanges,
        allowed: moveReason === undefined,
        ...(moveReason !== undefined ? { reason: moveReason } : {}),
        ...(linkPlan ? { links: linkPlan.report } : {}),
      };
      if (a.dryRun === true) return { ...impact, dryRun: true, moved: false };
      if (managed) throw new ToolError(reason!, 400);
      // A folder move is judged on its two folder paths and every file under
      // them: a refusal on one of the folder paths says so, because a folder
      // directly under a root is proposable where a file there is not.
      if (blocked.length > 0) {
        const folderPath = kind === 'folder' && (blocked[0] === src || blocked[0] === dest);
        throw await writeRefusal(branch, blocked[0], folderPath ? 'dir' : 'file');
      }
      if (collision) throw new ToolError(reason!, 409);
      if (linkPlan?.overCap !== undefined) throw new ToolError(linkPlan.overCap, 400);
      if (accessChanges && a.confirm !== true) {
        return {
          ...impact,
          confirmationRequired: true,
          moved: false,
          message: `Nothing was moved: your access at "${dest}" differs from "${src}", so this move requires confirm: true.`,
        };
      }
      // The look above is what produces the sentence; the filesystem's own
      // no-replace move is what guarantees it. A destination created between
      // the two — by another agent, or by the sidebar, which moves without
      // taking this lock — comes back here as a refusal, not an overwrite.
      if (linkPlan === undefined) {
        await asEntryExists(() => fs.moveFile(src, dest));
      } else {
        // The move and every link edit, one commit. Under the locks, each page
        // is checked to still hold the bytes its edit was computed from.
        const edits = linkPlan.edits.map((e) => ({ path: e.path, lockAt: e.lockAt, content: e.content }));
        const check = async () => {
          for (const e of linkPlan.edits) {
            const now = await fs.readFile(e.lockAt, { encoding: 'utf8' }).then(String, () => null);
            if (now !== e.original) {
              throw new ToolError(`"${e.lockAt}" changed while the move was being planned, so nothing was moved. Run the move again.`, 409);
            }
          }
        };
        const summary = `Move ${src} to ${dest}`.slice(0, 200);
        const locking = fs as LocalFilesystem & { moveWithEdits?: LockingFilesystem['moveWithEdits'] };
        try {
          if (typeof locking.moveWithEdits === 'function') {
            await asEntryExists(() => locking.moveWithEdits!(src, dest, edits, summary, check));
          } else {
            // A filesystem without the one-commit move (none the agent is
            // handed for writing): the move, then each edit.
            await check();
            await asEntryExists(() => fs.moveFile(src, dest));
            for (const e of edits) await fs.writeFile(e.path, e.content);
          }
        } catch (err) {
          if (err instanceof MoveLockedError || err instanceof MoveRacedError) throw new ToolError(err.message, 409);
          throw err;
        }
      }
      // Moving the last file — or a whole folder — out leaves the folder it
      // came from in place, like a delete.
      await keepFolderOf(fs, ctx, branch, src, kbDirName);
      return { ...impact, moved: true };
    },
  });

  mount({
    name: 'copy_file',
    gated: true,
    description:
      'Copy a workspace FILE to a new path. The destination must not exist — like a move, a copy never overwrites a file or a folder; to change what is in a file that already exists, write it. Committed + pushed as you. ' +
      'Preflight first: `dryRun: true` changes nothing and answers `{ src, dest, kind, descendants, access: { before, after }, accessChanges, allowed, reason? }` — `access` is your own `{ read, write, download, owner }` at the source and at the destination AS IT WILL BE once the copy has landed, with every `access.md` inside a copied folder counted at its new place. ' +
      'One exception to that shape: when the destination is one you may not write, the answer is the refusal alone — `allowed: false` with `reason`, and no `kind` and no `descendants`, because nothing about the source is read before that verdict.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: wsPath(kbDirName, 'Source path'),
        dest: wsPath(kbDirName, 'Destination path — must not exist yet'),
        dryRun: { type: 'boolean', description: 'Answer with the impact and change nothing.' },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'src', 'dest'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        src: str('Source path (echoes the input).'),
        dest: str('Destination path (echoes the input).'),
        kind: str('`file` or `folder` (dry run only; absent when `allowed` is false because you may not write the destination).'),
        descendants: int('Files the copy would carry: 1 for a file, the file count under a folder (dry run only; absent when `allowed` is false because you may not write the destination).'),
        access: { type: 'object', description: 'Your `{ read, write, download, owner }` at the source (`before`) and at the destination once the copy has landed (`after`) — dry run only.' },
        accessChanges: { type: 'boolean', description: 'True when any of your verdicts differs between `before` and `after` (dry run only).' },
        allowed: { type: 'boolean', description: 'Whether the copy may run (dry run only).' },
        reason: str('Why it may not, when `allowed` is false.'),
        dryRun: { type: 'boolean', description: 'True on a dry run.' },
        copied: { type: 'boolean', description: 'True once the copy landed; false on a dry run.' },
      },
      required: ['src', 'dest', 'copied'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      // A copy CARRIES the source content into the destination, so BOTH ends
      // go to the write hook. Ask about both before touching disk.
      writePolicy.assertPathWritable(ctx.sessionId, a.src as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.dest as string);
      const branch = a.branch as string;
      await assertAgentWriteAllowed(agentAccessGate, ctx, branch, a.src as string);
      await assertAgentWriteAllowed(agentAccessGate, ctx, branch, a.dest as string);
      const src = a.src as string;
      const dest = a.dest as string;
      // A copy lands bytes at a name of its own, so it is refused by the same
      // rule a move is: nothing already at `dest` is replaced. To put new
      // content into a file that exists, write it.
      //
      // The same plain-path rule a move applies to both its ends, applied
      // here because the look at the destination comes before the filesystem's
      // own containment check: a path with a `..` segment must not reach
      // `lstat` outside the workspace, even to be told a name is taken.
      assertPlainPath(dest);
      if (a.dryRun === true) return copyImpact(branch, ctx, src, dest);
      // The write verdict comes FIRST, for the reason `move_file` gives at
      // length: "already exists" is a fact about the destination folder, and a
      // caller who may not write there must not be told it. The lock gate
      // refuses this copy anyway — but only after the copy had already
      // answered, which is exactly the oracle.
      const blockedDest = await writeBlocked(branch, ctx, [dest]);
      if (blockedDest.length > 0) throw await writeRefusal(branch, blockedDest[0]);
      const occupiedBy = await existingAt(await workspaceRoot(branch, ctx), dest);
      if (occupiedBy !== null) throw new ToolError(entryExistsMessage(occupiedBy, dest), 409);
      // The copy itself lands exclusively (`COPYFILE_EXCL`, under the
      // destination's lock), so a name taken between the look and the landing
      // is refused with the same sentence rather than overwritten.
      //
      // Absence is only asked about once the copy has FAILED, and after the
      // write verdict above: a caller who may not write here gets the same
      // `write-denied` whether the source is there or not, exactly as from
      // write_file, edit_file, move_file and delete_file. Probing the source up
      // front would put a 404 in front of that 403 and make the refusal report
      // whether a path the caller could not copy from exists.
      //
      // WHICH end the absence belongs to is then decided by probing the
      // SOURCE, as move_file probes its own. A copy has exactly two ends, and
      // the filesystem blames the source for both: `LocalFilesystem.copyFile`
      // re-throws every ENOENT as `FileNotFoundError(src)`, and a destination
      // segment that is a file escapes raw as ENOTDIR from the parent mkdir
      // (`existingAt` above reads that as "nothing there" and lets the copy
      // go on to say so). So a source that is really gone gets the 404 naming
      // the source; a source sitting right there means the absence was the
      // DESTINATION's, and it gets the same 404 naming the destination.
      // Neither may escape as a 500 — that is the answer whose message carries
      // the server's own absolute path. Anything that is not absence travels
      // on as it always did.
      const fs = await ctx.getFilesystem(branch);
      try {
        await asEntryExists(() => fs.copyFile(src, dest));
      } catch (err) {
        // The filesystem's own "that is a directory" becomes the sentence the
        // dry run predicts, instead of escaping as a 500 carrying the
        // server's absolute path.
        if ((err as { name?: string } | null)?.name === 'IsDirectoryError') {
          throw new ToolError(folderCopyRefusal(src), 400);
        }
        const missing = isAbsence(err) || (err as { name?: string }).name === 'FileNotFoundError';
        if (missing) {
          throw (await kindOf(fs, src)) === null
            ? notFound(src, 'Nothing to copy')
            : notFound(dest, 'Nowhere to copy to');
        }
        throw err;
      }
      return { src, dest, copied: true };
    },
  });

  mount({
    name: 'unzip',
    gated: true,
    description:
      'Extract a .zip already in the workspace (defaults to the zip\'s parent). Returns extracted files + skipped entries. Existing files are overwritten.',
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path to the .zip archive'),
        destination: wsPath(kbDirName, "Directory to extract into (default: the zip's parent)"),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        destination: str('Directory the archive was extracted into.'),
        extracted: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths of the files written.' },
        skipped: {
          type: 'array',
          description: 'Entries that were not extracted, with the reason.',
          items: {
            type: 'object',
            properties: { path: str('Entry path inside the archive.'), reason: str('Why it was skipped (e.g. unsafe path, size cap).') },
            required: ['path', 'reason'],
          },
        },
      },
      required: ['destination', 'extracted', 'skipped'],
    },
    write: true,
    handler: async (a, ctx: ToolContext) => {
      const zipPath = a.path as string;
      // Opening the archive is a read of the archive, so the read hook hears
      // about it before a single entry is extracted out of it.
      await notifyAgentRead(agentAccessGate, ctx, a.branch as string, zipPath);
      // A .zip that is not there is a missing PATH, not an unreadable archive:
      // the service now says so (PathNotFoundError) and the helper turns it
      // into the same 404 every other file tool answers. Only that declared
      // answer maps — a failure part-way through an extraction is not the
      // archive going missing.
      return orDeclaredNotFound(
        () =>
          ctx.workspaceService.unzipFile(
            workspaceIdForBranch(a.branch as string),
            zipPath,
            typeof a.destination === 'string' ? a.destination : undefined,
            // Each extracted file is a write of its own: an entry the write
            // hook refuses is skipped (not extracted), so an archive can't be
            // a way around it — the extension policy applies per entry too, so
            // a restricted run can't unzip a `.md` into the graph.
            (wsRelPath) => {
              // An entry that would land beside the repository is skipped with the
              // corrected-path reason, like any other refused entry.
              assertInsideRepo(wsRelPath, kbDirName);
              // Extraction writes straight to disk, past the filesystem's roles.yaml
              // gate — so an archive may not carry one at all.
              if (isRolesYamlPath(wsRelPath, kbDirName)) {
                throw new ToolError(
                  'roles.yaml is never extracted from an archive — change it with edit_file or write_file, where the change is checked.',
                  422,
                );
              }
              writePolicy.assertPathWritable(ctx.sessionId, wsRelPath);
              return assertAgentWriteAllowed(agentAccessGate, ctx, a.branch as string, wsRelPath);
            },
          ),
        'Nothing to extract',
      );
    },
  });

  // ── uploads (bytes that never pass through the model) ───────────────────
  //
  // The pair exists because MCP tool arguments are JSON. Every byte an agent
  // sends through `write_file` is first typed out by the model, which
  // truncates long files, mangles backslash and `\u` escapes, and cannot carry
  // a PNG at all. `request_file_upload` answers an address; the agent POSTs
  // the file (or one zip holding many) there with any HTTP client;
  // `apply_file_upload` lands it on a branch in one commit. The bytes go from
  // the agent's disk to the server's and never enter a prompt.
  //
  /**
   * Why one of an upload's paths may not be landed, judged on the path ALONE —
   * or undefined when nothing about the name itself refuses it.
   *
   * The platform files are the whole of it. `access.md` governs who may read
   * and write the folder it sits in, `roles.yaml` says which roles exist, and
   * the agent guide is read as instructions: each is configuration the platform
   * obeys, and each has a write path that CHECKS the change (the roles gate
   * refuses an edit that would lock every admin out; a folder's access rules
   * are judged against who is asking). Bytes arriving by upload meet none of
   * those gates — they are a buffer the sender chose — so an upload never
   * lands one, whatever else the caller may write. `unzip` has refused
   * `roles.yaml` from an archive for the same reason; this is that rule, over
   * all four names.
   */
  const platformFileReason = (wsPath: string): string | undefined => {
    const rel = toKbRelative(wsPath, kbDirName);
    return rel !== null && isPlatformFile(rel, kb.layout) ? platformFileUploadRefusal(rel) : undefined;
  };

  /**
   * `apply_file_upload`'s handler: resolve the stored bytes into one path per
   * file, judge each path the way `write_files` judges its own, and land the
   * survivors as ONE commit.
   *
   * The judging is deliberately the same shape as `write_files`, down to the
   * second verdict under the lock, because the promise the ticket makes is
   * that an upload is judged "exactly as `write_file` would judge it". Three
   * gates run per path and a path that fails one is that path's outcome and no
   * more: the deployment's write hook, the platform-file rule above, and the
   * `mode`. What is judged ONCE for the whole call is the destination — a
   * caller who may not write the folder at all gets one refusal naming the
   * change-request route, rather than the same refusal repeated per entry.
   */
  const applyFileUpload = async (
    a: Record<string, unknown>,
    ctx: ToolContext,
    uploads: AgentUploadStore,
  ): Promise<unknown> => {
    const branch = a.branch as string;
    const token = a.token;
    if (typeof token !== 'string' || token === '') {
      throw new ToolError(
        'Name the `token` `request_file_upload` answered with, after POSTing the file to its `uploadUrl`.',
        400,
        { code: 'token-required' },
      );
    }
    const mode = modeOf(a);
    const destination = (a.destination as string).replace(/\/+$/, '');
    assertInsideRepo(destination, kbDirName);
    // CLAIMED, not consumed: an apply refused whole (a protected destination,
    // an archive that will not open) leaves the token alive so the caller can
    // retry somewhere else rather than send the bytes again. The claim is what
    // keeps it single-use meanwhile — a second apply finds the token in use.
    const upload = uploads.claim(token, ctx.user.id);
    let spent = false;
    try {
      const fs = await ctx.getFilesystem(branch);
      const root = await workspaceRoot(branch, ctx);
      // The destination, once, for the whole call. On a protected branch a
      // caller who may not write the folder gets the lock gate's own refusal —
      // which `rethrowAsWriteDenial` turns into `write-denied` with the
      // change-request steps — and nothing lands.
      const blockedDest = await writeBlocked(branch, ctx, [destination]);
      if (blockedDest.length > 0) throw await writeRefusal(branch, blockedDest[0], 'dir');
      if ((await kindOf(fs, destination)) === 'file') {
        throw new ToolError(
          `"${displayPath(destination)}" is a file, not a folder — \`destination\` names the folder the upload lands in.`,
          409,
          { code: 'not_a_folder' },
        );
      }

      const planned = await planUpload(upload, destination, kbDirName);
      const paths = planned.filter((p) => p.content !== undefined).map((p) => p.path as string);
      // One batched access read for every path, like `write_files` — empty on
      // a draft branch, where changes reach a protected branch only through a
      // change request.
      const blocked = new Set(await writeBlocked(branch, ctx, paths));

      const writes: { path: string; content: Buffer }[] = [];
      const outcomes: Record<string, unknown>[] = [];
      /** The `files` entry for `writes[i]`, so the under-lock verdict can revise it. */
      const entryOf: Record<string, unknown>[] = [];
      for (const item of planned) {
        const entry: Record<string, unknown> = { path: item.path };
        outcomes.push(entry);
        if (item.content === undefined) {
          entry.outcome = 'refused';
          entry.error = item.error;
          entry.message = item.message;
          continue;
        }
        const wsPathOf = item.path;
        try {
          if (blocked.has(wsPathOf)) throw await writeRefusal(branch, wsPathOf);
          const platform = platformFileReason(wsPathOf);
          if (platform !== undefined) throw new ToolError(platform, 422, { code: 'platform_file' });
          // The git folder is never a workspace path, in any spelling. A ZIP
          // entry's name has already met this rule in `zipEntryNameRefusal`; a
          // SINGLE uploaded file's has not — `.git` is a name the upload
          // route's `validateFilename` accepts — and the preflight that reads
          // the caller's own arguments never sees it either, because the name
          // came from the upload, not from the call. Asked here so that path
          // is REFUSED like any other, with the rest of the upload landing,
          // rather than failing the whole apply from inside `writeFiles`.
          assertNoGitInternalsSegment(wsPathOf);
          assertRepoRootNameFree(wsPathOf, kbDirName);
          // A link already on disk under the destination must not redirect
          // these bytes — the rule `unzip` applies per entry, applied here on
          // the path the write will take.
          const link = await symlinkOnPath(root, wsPathOf);
          if (link !== undefined) {
            throw new ToolError(
              `"${wsPathOf}" goes through the symbolic link "${link}"; an upload never follows links.`,
              400,
              { code: 'symlink' },
            );
          }
          writePolicy.assertPathWritable(ctx.sessionId, wsPathOf);
          await assertAgentWriteAllowed(agentAccessGate, ctx, branch, wsPathOf);
          // An earlier entry of this same upload counts as existing, as it
          // does in `write_files`: two `create` entries for one path are a
          // mistake the commit would otherwise hide.
          const exists =
            writes.some((w) => w.path === wsPathOf) || (await kindOf(fs, wsPathOf)) !== null;
          entry.outcome = decideWrite(mode, wsPathOf, exists);
          writes.push({ path: wsPathOf, content: item.content });
          entryOf.push(entry);
        } catch (err) {
          refuseEntry(entry, err);
        }
      }

      // The mode gate again, with every path's lock held — the verdict the
      // answer carries, for the reason `write_file` states at length. A path
      // whose verdict changed under the lock is dropped from the batch and
      // reported refused, leaving the rest to land.
      const recheck = async (
        pending: readonly { path: string; content: Buffer }[],
      ): Promise<{ path: string; content: Buffer }[]> => {
        const kept: { path: string; content: Buffer }[] = [];
        for (let i = 0; i < pending.length; i++) {
          const entry = entryOf[i];
          try {
            const exists =
              kept.some((k) => k.path === pending[i].path) || (await kindOf(fs, pending[i].path)) !== null;
            entry.outcome = decideWrite(mode, pending[i].path, exists);
            kept.push(pending[i]);
          } catch (err) {
            refuseEntry(entry, err);
          }
        }
        return kept;
      };
      if (writes.length > 0) {
        // `write: true` guarantees a LockingFilesystem here; `writeFiles` lands
        // the whole set as ONE commit and takes a Buffer as content, so bytes
        // reach disk exactly as they were sent — no text decode anywhere on
        // the way, which is what makes a PNG and a backslash-heavy page land
        // with the checksum they were uploaded with.
        const batching = fs as unknown as {
          writeFiles(
            writes: { path: string; content: Buffer }[],
            summary: string,
            deletes: string[],
            check: (
              pending: readonly { path: string; content: Buffer }[],
            ) => Promise<{ path: string; content: Buffer }[]>,
          ): Promise<void>;
        };
        // In the DESTINATION folder's TURN, which `delete_folder` takes over the
        // same subtree (and `keepFolderOf` with it). `writeFiles` creates the
        // destination, and any folder above a zip entry on the way to it, as
        // part of landing the batch — and a folder delete running between that
        // creation and the commit enumerates the folder's files BEFORE these
        // exist and then removes the folder they are landing in, which is an
        // answer saying `created` for bytes that are already gone. The turn is
        // taken OUTSIDE `writeFiles`, so it is held across the under-lock
        // recheck and the commit both, and in the same order the delete takes
        // its own (the folder's turn first, then each path's lock), which is
        // what keeps two callers from waiting on each other's half.
        await ctx.workspaceService.withFolderTurn(workspaceIdForBranch(branch), destination, async () => {
          await batching.writeFiles(writes, `Apply upload of ${writes.length} file(s)`, [], recheck);
        });
      }
      // The token is spent once an ANSWER exists, even an answer in which
      // every path was refused: the apply ran and said what happened at each
      // path, and re-running it would say the same. Only a refusal that landed
      // nothing AND answered nothing (thrown above) gives the token back.
      spent = true;
      await uploads.consume(token);
      const listed = a.all === true ? outcomes : outcomes.slice(0, APPLY_ANSWER_CAP);
      return {
        destination,
        count: outcomes.filter((o) => o.outcome !== 'refused').length,
        total: outcomes.length,
        files: listed,
        ...(listed.length < outcomes.length ? { truncated: true } : {}),
      };
    } finally {
      if (!spent) uploads.release(token);
    }
  };

  // Mounted only when the composition supplied a store — see the `uploads`
  // parameter. Core always does.
  if (uploads) {
    mount({
      name: 'request_file_upload',
      fileTool: false,
      description:
        // Within the description cap (`tool-registry/description-length.ts`):
        // why a file goes this way is one of the shared rules, and the header
        // spelling of the token is on the `uploadUrl` output, where the
        // address it changes is.
        'Ask for a one-time address to send FILE BYTES to, so their content never passes through this conversation. ' +
        'Use it for anything `write_file` cannot carry faithfully: a large file, a file full of backslashes or `\\u` ' +
        'escapes, a binary file (a PNG, a PDF, a zip), or many files at once (zip them). ' +
        'Returns `{ uploadUrl, token, expiresAt, expiresInSeconds, maxBytes }`. THEN: ' +
        '(1) POST the file as the raw request body to `uploadUrl` with `?filename=<name>` — ' +
        '`curl -X POST --data-binary @skill.zip "<uploadUrl>?filename=skill.zip"` — which answers what it received; ' +
        '(2) call `apply_file_upload` with the same `token`, a `branch` and a destination folder. ' +
        'One token carries one file or one zip, is bound to you and expires at `expiresAt`: an upload nobody applies ' +
        'by then is deleted, and one over `maxBytes` is refused when you send it, naming the limit.',
      inputs: { type: 'object', properties: {}, additionalProperties: false },
      outputs: {
        type: 'object',
        properties: {
          uploadUrl: str(
            'The absolute URL to POST the bytes to. Carries the token; add `?filename=<name>`. To keep the token out ' +
              'of a URL — when the command line you send from is logged or shared — POST to this address without its ' +
              'last (token) segment and send the token in an `x-upload-token` header instead.',
          ),
          token: str(
            'The token itself — what `apply_file_upload` takes, and what an `x-upload-token` header carries when you ' +
              'would rather it not sit in a URL. Treat it as a credential.',
          ),
          expiresAt: str('ISO-8601 instant after which the token, and any bytes sent with it, are gone.'),
          expiresInSeconds: int('Seconds from now until `expiresAt`.'),
          maxBytes: int('The largest upload this deployment accepts, in bytes.'),
        },
        required: ['uploadUrl', 'token', 'expiresAt', 'expiresInSeconds', 'maxBytes'],
      },
      // A read-scoped caller has nothing to do with an upload token: the only
      // thing it unlocks is a write. Refused at the handler factory, by scope,
      // before the token is minted.
      write: true,
      handler: async (_a, ctx: ToolContext) => uploads.issue(ctx.user),
    });

    mount({
      name: 'apply_file_upload',
      // A mode that is not one of the three answers `bad_mode`, which lists them.
      refusesItself: ['mode'],
      gated: true,
      description:
        'Land a file you have already uploaded (see `request_file_upload`) in a folder on a branch, in ONE commit, as you. ' +
        'A single file lands under the name it was sent with; a zip lands as its entries, keeping their folder structure. ' +
        'Returns `{ destination, count, total, files }`: one entry per path, each `{ path, outcome }` — `created` / ' +
        '`replaced` / `updated`, or `refused` with `error` (the code) and `message` (why). `count` is how many landed and ' +
        '`total` how many paths there were; `files` is cut to the first 25 unless you pass `all: true`. ' +
        'Every path is judged one by one — by your write access, the platform-file rules and what is already there — ' +
        'exactly as `write_file` judges it, and a refused path does not stop the others. ' +
        'The token is single-use: it is spent by the apply that lands it, and refused if you use it twice, let it ' +
        'expire, or present one issued to somebody else. `mode` means what it means on `write_file`.',
      inputs: {
        type: 'object',
        properties: {
          branch: BRANCH_INPUT,
          token: str('The `token` from `request_file_upload`, after you have POSTed the file to its `uploadUrl`.'),
          destination: wsPath(kbDirName, 'Folder the upload lands in (created if it is not there yet)'),
          mode: WRITE_MODE_INPUT,
          all: {
            type: 'boolean',
            description:
              'List EVERY path in `files` instead of the first 25. `total` always says how many there were, so ask for ' +
              'all only when you need to read each outcome.',
          },
          sessionId: SESSION_ID_INPUT,
        },
        required: ['branch', 'token', 'destination'],
        additionalProperties: false,
      },
      outputs: {
        type: 'object',
        properties: {
          destination: str('The folder the upload was applied to (echoes the input).'),
          count: int('How many paths landed — the entries in `files` whose `outcome` is not `refused`.'),
          total: int('How many paths the upload held, whether or not `files` lists them all.'),
          files: {
            type: 'array',
            description: 'One entry per path, in the order the upload held them. Cut to 25 unless `all` was true.',
            items: {
              type: 'object',
              properties: {
                path: str('The workspace path this entry was judged at.'),
                outcome: {
                  type: 'string',
                  enum: ['created', 'replaced', 'updated', 'refused'],
                  description: 'What happened at this path. `refused` means nothing was written there.',
                },
                error: str('Present when `outcome` is `refused`: the refusal code — e.g. `exists`, `missing`, `invalid_entry`, `platform_file`, `write-denied`.'),
                message: str('Present when `outcome` is `refused`: the full refusal, the same one `write_file` would have given.'),
              },
              required: ['path', 'outcome'],
            },
          },
          truncated: { type: 'boolean', description: 'True when `files` was cut: `total` is larger than what it lists. Pass `all: true` for the rest.' },
        },
        required: ['destination', 'count', 'total', 'files'],
      },
      write: true,
      // So a protected-branch refusal arrives as `write-denied`, with the
      // change-request steps, exactly as it does from write_file.
      proposable: true,
      handler: async (a, ctx: ToolContext) => applyFileUpload(a, ctx, uploads),
    });
  }

  // ── downloads (bytes that never pass through the model, the other way) ──
  // The twin of the upload pair: `read_file` answers content INTO the
  // conversation, so an agent that needs exact bytes on its own disk had no
  // way to get them. `request_file_download` judges every file on its own,
  // captures the ones that pass, and answers a one-time link per file (and a
  // zip per requested folder) that any HTTP client can fetch.

  /** The type a file's link answers with: the reader's, as `file_stat` reports it — but never active content. */
  const downloadContentType = (p: string, bytes: Buffer): string => {
    const reader = readers.readerFor(p);
    const mime = fileTypeOf(reader, p, needsContent(reader) ? bytes : undefined).mime;
    // SVG and HTML run scripts wherever they are opened — saved to disk and
    // re-opened under `file://`, too — so they go out as bytes, as the app's
    // own Download button sends them.
    return ACTIVE_CONTENT_TYPES.has(mime) ? 'application/octet-stream' : mime;
  };

  if (downloads) {
    mount({
      name: 'request_file_download',
      gated: true,
      description:
        'Copy knowledge-base files onto your own disk without their content passing through the conversation — the ' +
        'way out, as `request_file_upload` is the way in. Give `branch` and `paths` (files or folders). Every file, ' +
        'each one inside a folder too, is included only if you may read AND download that file. Returns ' +
        '`{ expiresAt, expiresInSeconds, files: [{ path, bytes, sha256, downloadUrl }], folders: [{ path, bytes, ' +
        'downloadUrl, files }], refused: [{ path, reason }] }`: a link per file, with its own content type, and per ' +
        `folder a zip at full repository paths (\`apply_file_upload\` it at \`${kbDirName}/\` to put every file back). ` +
        'Fetch with any HTTP client (`curl -o <name> "<downloadUrl>"`, or the address without its last segment and an ' +
        '`x-download-token` header). Each link works ONCE, for 15 minutes, and serves the files as they are now. ' +
        'Refused: `not found` (missing or named-but-unreadable; folders omit unreadable files), ' +
        '`download permission required`; no link when nothing is included. At most 500 MB per request.',
      inputs: {
        type: 'object',
        properties: {
          branch: BRANCH_INPUT,
          paths: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: `Files and folders to download, under \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash — a path without that prefix is placed under \`${kbDirName}/\`.`,
          },
          sessionId: SESSION_ID_INPUT,
        },
        required: ['branch', 'paths'],
        additionalProperties: false,
      },
      outputs: {
        type: 'object',
        properties: {
          expiresAt: {
            type: ['string', 'null'],
            description: 'ISO-8601 instant after which every link of this answer is gone; null when no link was issued.',
          },
          expiresInSeconds: int('Seconds until `expiresAt`; 0 when no link was issued.'),
          files: {
            type: 'array',
            description: 'One entry per included file, each named once however many times it was asked for.',
            items: {
              type: 'object',
              properties: {
                path: str('The workspace path.'),
                bytes: int('Size in bytes.'),
                sha256: str('SHA-256 of the bytes the link serves, hex.'),
                downloadUrl: str('One-time link to the file itself.'),
              },
              required: ['path', 'bytes', 'sha256', 'downloadUrl'],
            },
          },
          folders: {
            type: 'array',
            description: 'One entry per requested folder that kept at least one file.',
            items: {
              type: 'object',
              properties: {
                path: str('The folder, as requested.'),
                bytes: int('Uncompressed total of the files in its zip.'),
                downloadUrl: str('One-time link to the zip.'),
                files: { type: 'array', items: { type: 'string' }, description: 'The workspace paths the zip holds.' },
              },
              required: ['path', 'bytes', 'downloadUrl', 'files'],
            },
          },
          refused: {
            type: 'array',
            description: 'Every path left out, with why.',
            items: {
              type: 'object',
              properties: { path: str('The path left out.'), reason: str('Why: `not found`, `download permission required`, or the deployment\'s own words.') },
              required: ['path', 'reason'],
            },
          },
        },
        required: ['expiresAt', 'expiresInSeconds', 'files', 'folders', 'refused'],
      },
      // A download is a READ: a read-only deployment still serves it. A
      // read-only CREDENTIAL may not take bytes out, though.
      write: false,
      writeScope: true,
      handler: async (a, ctx: ToolContext) => requestFileDownload(a, ctx, downloads),
    });
  }

  /** `request_file_download`'s handler: judge, capture, and issue the links. */
  async function requestFileDownload(
    a: Record<string, unknown>,
    ctx: ToolContext,
    store: IAgentDownloadStore,
  ): Promise<unknown> {
    const branch = a.branch as string;
    const raw = a.paths;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((p) => typeof p !== 'string' || p.trim() === '')) {
      throw new ToolError('Name at least one path to download in `paths`: an array of file and folder paths.', 400);
    }
    // At the cap, say so before a branch is resolved; the slot below counts again.
    store.assertCanIssue(ctx.user);
    // Resolves (clones, if need be) the branch's workspace, as a read does —
    // so an unknown branch is the call's refusal, not every path's.
    await ctx.getFilesystem(branch);
    const workspaceId = workspaceIdForBranch(branch);
    const refusedSpelling: { path: string; reason: string }[] = [];
    const requested: string[] = [];
    for (const p of raw as string[]) {
      try {
        // As written: a name may begin or end with a space, and trimming it
        // would ask for another file. A trailing slash is the one spelling
        // folded, so `Shared/` and `Shared` are one request, not two zips.
        requested.push(normalizeWorkspacePath(p, kbDirName).replace(/\/+$/, ''));
      } catch (err) {
        if (!hasHttpStatus(err)) throw err;
        refusedSpelling.push({ path: p, reason: err.message });
      }
    }
    // A slot is taken before anything is built (a caller at the cap is told
    // so at once) and given back when nothing is issued.
    return store.withRequestSlot(ctx.user, async (issue) => {
      const built = await buildDownload(requested, {
        kbDirName,
        maxBytes: ZIP_DOWNLOAD_MAX_BYTES,
        maxFiles: DOWNLOAD_MAX_FILES,
        candidatesAt: (p) => ctx.workspaceService.downloadCandidatesAt(workspaceId, p, DOWNLOAD_MAX_FILES),
        canReadBatch: (paths) => accessControl.canReadBatch(workspaceId, ctx.user.email, paths),
        canDownloadBatch: (paths) => accessControl.canDownloadBatch(workspaceId, ctx.user.email, paths),
        // The folder-level gate the app's zip route applies, before the files.
        canDownloadFolder: (p) =>
          accessControl.canDownload(workspaceId, ctx.user.email, toKbRelative(p, kbDirName) ?? p),
        notifyRead: (p) => notifyAgentRead(agentAccessGate, ctx, branch, p),
        readFile: (p) => ctx.workspaceService.readFileBinary(workspaceId, p),
        contentTypeOf: downloadContentType,
      });
      const refused = [...refusedSpelling, ...built.refused];
      if (built.artifacts.length === 0) {
        return { expiresAt: null, expiresInSeconds: 0, files: [], folders: [], refused };
      }
      const issued = await issue(built.artifacts);
      const urls = issued.downloadUrls;
      return {
        expiresAt: issued.expiresAt,
        expiresInSeconds: issued.expiresInSeconds,
        files: built.files.map((f, i) => ({ ...f, downloadUrl: urls[i]! })),
        folders: built.folders.map((f, i) => ({
          path: f.path,
          bytes: f.bytes,
          downloadUrl: urls[built.files.length + i]!,
          files: f.files,
        })),
        refused,
      };
    });
  }

  // ── shell (internal-only) ───────────────────────────────────────────────
  mount({
    name: 'execute_command',
    gated: true,
    description:
      'Run a shell command in the workspace directory. Returns `{ stdout, stderr, exitCode }` (output capped). Use for git status/log, grep/rg, build/test commands.',
    internalOnly: true,
    fileTool: false,
    // The one tool the mount's branch check skips: the handler below resolves an
    // omitted `branch` to the internal caller's focused branch before refusing.
    resolvesBranchItself: true,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        command: str('The shell command line to run.'),
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Timeout in ms (default 30000).' },
        sessionId: SESSION_ID_INPUT,
      },
      // `branch` stays REQUIRED here on purpose, and must not be relaxed to make
      // the handler's focused-branch fallback "reachable". This list is the
      // contract the model is TAUGHT — declaring it required is what makes the
      // caller always name its branch, which is the fix for the workspace this
      // tool used to resolve as "undefined". It is not a runtime gate: nothing in
      // the tool route validates inputs against this schema, so a branch-less call
      // still reaches the handler and still hits the `ctx.focusedBranch` fallback
      // (covered by "falls back to the session focused branch when branch is
      // omitted"). The fallback is a safety net for a model that disobeys the
      // contract — not a sanctioned calling convention to advertise.
      required: ['branch', 'command'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        stdout: str('Captured standard output (truncated to 50,000 chars).'),
        stderr: str('Captured standard error (truncated to 50,000 chars).'),
        exitCode: int('Process exit code; -1 if it was killed (timeout/abort) or failed to spawn.'),
      },
      required: ['stdout', 'stderr', 'exitCode'],
    },
    write: true,
    handler: async (a, ctx: ToolContext) => {
      // Resolve the branch FIRST — before the policy gates below — so a malformed
      // call always gets the 400 that names what is missing, rather than a 403
      // from a restricted session masking it. Unlike the file tools (which route
      // through `getOrCreateForUser` and fall back to the default branch),
      // execute_command turns `branch` straight into a workspace — so a bad value
      // would `encodeURIComponent(undefined)` to the string "undefined", then try
      // to CLONE a branch literally named "undefined", 500ing and leaving an
      // `<workspaces>/undefined/` shell behind.
      //
      // Two distinct cases:
      //  - branch OMITTED (`undefined`): the in-app chat agent may leave it off a
      //    call. For an internal session we fall back to the caller's own focused
      //    branch (`ctx.focusedBranch`, from its signed token), so the command runs
      //    against the workspace the session is on (e.g. `main`) end to end. An
      //    external caller carries no focused branch, so it stays absent → 400.
      //  - branch PRESENT but invalid (the literal "undefined"/"null", empty, or
      //    malformed): a broken value, never a real branch — fail closed, never
      //    silently reinterpret it as the focused branch.
      const raw = a.branch;
      const branch = raw === undefined ? ctx.focusedBranch : raw;
      if (typeof branch !== 'string' || branch.length === 0) {
        throw new ToolError(
          'execute_command requires a `branch`: pass the branch (draft) whose workspace to run the command in — the one you are currently working on.',
          400,
          // The same discriminator every other KB tool answers a branch-less
          // call with, so a client switches on one kind across the surface.
          // The MESSAGE stays this tool's own: it can name the focused-branch
          // fallback that only applies here.
          { kind: 'branch-required' },
        );
      }
      // A stringified absent value. Both are syntactically valid git branch names,
      // so `assertValidBranchName` below happily accepts them — and accepting one
      // is the whole bug this tool is guarded for: `getOrCreateForBranch("undefined")`
      // clones a branch literally named "undefined" into `<workspaces>/undefined/`
      // and 500s. Reject them by name, ahead of the shape check.
      if (branch === 'undefined' || branch === 'null') {
        throw new ToolError(
          `execute_command got the literal string "${branch}" as \`branch\` — that is a stringified absent value, not a branch. ` +
            'Pass the real branch (draft) whose workspace to run the command in.',
          400,
          { kind: 'branch-required' },
        );
      }
      // Then the SHAPE, via the one canonical validator every other branch path
      // uses — no hand-maintained list of suspicious literals, which would both
      // miss malformed refs (`..`, `-x`, `foo/.lock`) and reserve names git
      // considers perfectly valid. Runs on the RAW string, so a whitespace-padded
      // `" main "` is refused rather than silently trimmed into a different
      // branch than the caller passed.
      try {
        assertValidBranchName(branch);
      } catch (err) {
        throw new ToolError(
          `execute_command got an invalid \`branch\`: ${(err as Error).message} — ` +
            'pass the exact branch (draft) whose workspace to run the command in.',
          400,
        );
      }
      // Shell is a write path with no single target path to check, so the
      // write hook is asked once for the call itself, with no path — and the
      // run must not be restricted to a file type either, since shell could
      // write anything.
      writePolicy.assertUnrestricted(ctx.sessionId);
      await assertAgentWriteAllowed(agentAccessGate, ctx, branch);
      // Canonical per-branch bootstrap entry point — it owns the workspace-id
      // encoding and the single-flight clone, so the shell never derives a
      // workspace path by hand.
      const cwd = (await ctx.workspaceService.getOrCreateForBranch(branch)).absolutePath;
      const timeoutMs = typeof a.timeout_ms === 'number' ? a.timeout_ms : 30_000;
      // cwd is the workspace ROOT so shell paths match the workspace-relative
      // paths every other file tool uses — but the git clone lives one level
      // deeper, at <workspace>/<kbDirName>/.git. For a bare `git status` /
      // `git diff` (what the agent prompt teaches) point git there explicitly so
      // it resolves the KB clone instead of failing with "not a git repository".
      //
      // Because the command runs under `shell: true`, GIT_DIR/GIT_WORK_TREE
      // apply to the WHOLE shell, so restrict the override to a *standalone* bare
      // `git …` invocation. Otherwise the KB repo context would (a) leak into a
      // chained step that spawns its own git — `git commit && npm ci` — and (b)
      // override a caller's explicit `git -C …` / `--git-dir` / `--work-tree`.
      const command = (a.command as string).trim();
      const isStandaloneGit =
        /^git(\s|$)/.test(command) &&
        !/[;&|`\n]|\$\(/.test(command) &&
        !/(?:^|\s)(?:-C|--git-dir|--work-tree)(?:[=\s]|$)/.test(command);
      const env = isStandaloneGit
        ? {
            ...process.env,
            GIT_DIR: join(cwd, kbDirName, '.git'),
            GIT_WORK_TREE: join(cwd, kbDirName),
          }
        : process.env;
      return new Promise((resolve) => {
        // Own process group on POSIX, so a timeout or abort kills the WHOLE
        // tree. `shell: true` puts an `sh` between us and the command; killing
        // only that shell left whatever it had started running on — orphaned,
        // unreaped, still holding the workspace and its memory. A self-hosted
        // deployment leaked ~4,500 tasks that way before nothing could fork.
        const detached = process.platform !== 'win32';
        const child = spawn(a.command as string, { cwd, shell: true, env, detached });
        let stdout = '';
        let stderr = '';
        const killTree = () => {
          try {
            if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              // Already gone.
            }
          }
        };
        const timer = setTimeout(killTree, timeoutMs);
        // If the caller disconnects (request aborted), kill the tree instead of
        // letting it run to the timeout; the resulting `close`/`error` settles
        // the promise through `finish`.
        const onAbort = killTree;
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        const finish = (value: unknown) => {
          clearTimeout(timer);
          ctx.abortSignal.removeEventListener('abort', onAbort);
          resolve(value);
        };
        // Cap accumulation while streaming so a verbose command can't exhaust
        // memory before `close`; the final slice keeps the output bound.
        const OUTPUT_CAP = 50_000;
        child.stdout.on('data', (d) => {
          if (stdout.length < OUTPUT_CAP) stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
          if (stderr.length < OUTPUT_CAP) stderr += d.toString();
        });
        child.on('close', (code) => {
          finish({ stdout: stdout.slice(0, 50_000), stderr: stderr.slice(0, 50_000), exitCode: code ?? -1 });
        });
        child.on('error', (err) => {
          finish({ stdout, stderr: `${stderr}\n${String(err)}`.slice(0, 50_000), exitCode: -1 });
        });
      });
    },
  });

  // The one read `open_page` borrows — see `readForTool` above.
  return { readForTool };
}
