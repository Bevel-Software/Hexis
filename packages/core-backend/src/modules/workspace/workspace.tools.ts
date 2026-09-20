import { spawn } from 'node:child_process';
import nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { Router, RequestHandler } from 'express';
import type { LocalFilesystem } from '@mastra/core/workspace';
import type { IToolRegistry, JsonSchema } from '../tool-registry/tool.contract.js';
import { ToolError, type ToolContext, type ToolHandler } from '../tool-helpers/tool.contract.js';
import { BRANCH_INPUT, toolDef } from '../tool-helpers/tool-def.js';
import {
  recordOntologyRead,
  assertOntologyWriteAllowed,
  assertShellAllowedWithinOntology,
  ONTOLOGY_BOUNDARY_NOTE,
  SESSION_ID_INPUT,
  type SessionOntologyGate,
} from './session-ontology.gate.js';
import type { IRoutineWritePolicy } from './routine-write-policy.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import { requireInternalSource, requireExternalSource } from '../tool-auth/tool-auth.middleware.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
// Leaf-level shared primitive (same exception `workspace.service.ts` already
// relies on) — not a workflow service, so this stays inside the module boundary.
import { assertValidBranchName } from '../kb-fs/branch-name.js';
import { assertInsideRepo, normalizePathArgs } from '../kb-fs/repo-path.js';
import { GitGuardedFilesystem } from '../kb-fs/git-guarded-filesystem.js';
import { assertNoGitInternalsSegment, hasGitInternalsSegment } from '../../shared/git-internals.js';
import { isRolesYamlPath } from '../access-model/roles-yaml-guard.js';
import type { ISessionSink } from './session-sink.js';
import { isAbsence } from '../../shared/fs.contract.js';
import type { AccessDecisionSource, AccessTargetKind, IAccessControl } from '../access/access-control.interface.js';
import { accessRoster, resolveAccessView } from '../access/access-view.js';
import { accessMdPathForFolder, fileCarriesAccessRules, governingFolderOf } from '../access/access-mutation.service.js';
import { toKbRelative, resolveReadableMap } from '../access-model/kb-read-filter.js';
import type { SpillStore } from './spill-store.js';
import type { DocExtractService } from './file-readers/doc-extract.service.js';
import { displayPath, type FileKind, type FileReaderRegistry } from './file-readers/file-reader.js';
import { fileTypeOf, needsContent } from './file-readers/content-mode.js';
import { createFileReaderRegistry } from './file-readers/file-reader.registry.js';
import { DocumentReader } from './file-readers/document-reader.js';
import { mcpImageResult } from '@bevel-software/platform-mcp-core';
import {
  folderPlaceholderPath,
  isFolderPlaceholder,
  isPlatformFile,
  isPlatformFolder,
  isProtectedBranch,
  platformFileCreationRefusal,
  platformFileRefusal,
  platformFolderRefusal,
  entryExistsMessage,
  type ExistingEntryKind,
} from '@bevel-software/platform-shared';
import { AccessDeniedError } from '../access-model/access-errors.js';
import { removeEmptyDirs } from './empty-dirs.js';
import { PROPOSAL_ROUTE_NOTE, rethrowAsWriteDenial } from './write-denial.js';
import type { IChangeReadGate } from '../access-model/change-gate.js';
import { notFound, orDeclaredNotFound, orNotFound } from './not-found.js';
import { logger } from '../../shared/logging.js';
import { printable } from '../../shared/printable.js';
import { DestinationTakenError, inspectDestination } from '../../shared/rename-no-replace.js';

const log = logger('workspace-tools');

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

/**
 * Appended (centrally, in `mount`) to EVERY workspace tool description. A KB
 * author can drop an `AGENTS.md` at the workspace root to document conventions
 * for that knowledge base; agents (ours and external) should consult it before
 * touching files. It rides on every entrypoint — reads (grep/list_files/
 * file_stat) included — because any of them can be a session's first touch.
 *
 * `CLAUDE.md` is named as a fallback because knowledge bases seeded before the
 * rename still carry one, and the seeder never deletes a file it did not
 * expect. Naming both means an agent finds the conventions either way, instead
 * of reading none because it looked for the newer name and stopped.
 */
const KB_CONVENTIONS_NOTE =
  ' Before your first read or change in a workspace, read `AGENTS.md` at the KB root — or `CLAUDE.md` on a knowledge base seeded before it was renamed — if either exists: it holds the author\'s conventions for this knowledge base, and you should follow them.';

const int = (description: string): JsonSchema => ({ type: 'integer', description });

const str = (description: string): JsonSchema => ({ type: 'string', description });

/**
 * Where pictures go, on the two tools that write pages. An agent in core cannot
 * upload bytes yet (TODOS.md), but it can write the page with the link a person
 * will satisfy, and this sentence is what keeps every page it writes on the
 * README's convention: images beside the page, linked relatively.
 */
const IMAGE_CONVENTION_NOTE =
  ' Images: keep them in an `assets/` folder next to the page that uses them and link them with a relative path, e.g. `![Approval screen](./assets/approval-screen.png)`; the page renders them inline.';

/**
 * A path input that names the clone folder. The tools are rooted at the
 * WORKSPACE dir, one level above the git clone, so a path only reaches git
 * when it starts with that folder; an agent that reads `KnowledgeBase/Foo.md`
 * in a URL or a doc and passes it verbatim would otherwise write beside the
 * repository. Saying so in the input itself, not only in prose, is what the
 * agent actually sees when it fills the argument. `refused` is false for the
 * inputs that may legitimately name a stray (a source to rescue, a file to
 * remove).
 */
const wsPath = (kbDirName: string, what: string, refused = true): JsonSchema =>
  str(
    `${what}: starts with \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash (\`/${kbDirName}/…\` is the same path).` +
      (refused ? ' A path without that prefix is outside the repository and is refused.' : ''),
  );

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

/**
 * THE binary capability contract, stated once and appended (in `mount`) to
 * every file tool's description — which is also what `tools_info` returns.
 * The split it states is enforced by the reader registry: the text tools
 * refuse what their reader marks not `textEditable` (and binary content under
 * any name) with a `binary_not_writable` refusal; the byte tools never look.
 */
export const CONTENT_RULE =
  ' Content rule (the same on every file tool): read_file returns text for text files and extracted text for documents (.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf, .eml/.msg); write_file, write_files and edit_file accept TEXT only — they refuse documents, images, archives and other binary files (legacy .doc/.ppt/.xls included) with kind `binary_not_writable`, naming the file\'s kind and the tool to use instead; copy_file, move_file, delete_file and unzip act on bytes of any kind; new binary content arrives through upload (`request_upload_token` + `apply_upload` where offered, otherwise Upload in the app). file_stat reports `contentMode` (`text` | `document` | `binary`) so you can decide before acting.';

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
      'Use upload for new bytes (`request_upload_token` + `apply_upload` where offered, otherwise Upload in the app), ' +
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
 * Returns the bytes it read (so a caller that needs the content next —
 * `edit_file` — does not read the file a second time), or undefined when it
 * had no reason to read or nothing existed.
 */
async function assertNotBinaryOverwrite(
  readers: FileReaderRegistry,
  path: string,
  fs: { readFile(p: string): Promise<string | Buffer> },
): Promise<Buffer | undefined> {
  const reader = readers.readerFor(path);
  if (reader.editRefusalForExisting === undefined) return undefined;
  let existing: Buffer;
  try {
    existing = asBytes(await fs.readFile(path));
  } catch (err) {
    // Only a MISSING file is a create (both raw Node errors and Mastra's
    // FileNotFoundError carry the disk's absence codes). Any other failure —
    // permissions, I/O — means the existing content could not be inspected:
    // propagate it rather than let the write destroy bytes the gate never saw.
    if (isAbsence(err)) return undefined; // nothing there yet
    throw err;
  }
  const refusal = reader.editRefusalForExisting(existing, path);
  if (refusal !== null) throw binaryNotWritable('binary', refusal);
  return existing;
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

/** The same three modes, said once, for both tool descriptions. */
const WRITE_MODE_NOTE =
  ' `mode` decides what may happen at a path and DEFAULTS TO `create`: `create` writes a new file and refuses a path that ' +
  'already exists (`exists`, with the path — pass `mode: overwrite` to replace it), `overwrite` replaces what is there ' +
  '(creating it if there is nothing), `update` replaces an existing file and refuses a path that does not exist (`missing`). ' +
  'A refused path is left exactly as it was.';

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
  recordOntologyRead: (path: string) => Promise<void>,
  docs: DocGrepState,
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
      await grepWalk(fs, p, re, out, max, depth + 1, gate, recordOntologyRead, docs);
    } else {
      // Opening a file under a named ontology is a read of that ontology — even
      // for a root-level grep that resolves to a neutral root. Record it so a
      // cross-ontology grep poisons later writes (closes the read-leak).
      await recordOntologyRead(p);
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
  kbDirName: string,
  sessionOntologyGate: SessionOntologyGate,
  writePolicy: IRoutineWritePolicy,
  sessionSink: ISessionSink,
  /**
   * Read-before-write, for the `write-denied` answer's "may you propose this
   * instead?" — the same verdict the lock applies on the draft the proposal
   * would be made on. Optional so tool harnesses need not wire it; the read
   * verdict alone then decides, which differs only at a root.
   */
  changeGate?: IChangeReadGate,
): void {
  /**
   * The one extension→reader registry every read-shaped decision routes
   * through: read_file dispatches on it, grep asks it for searchable text,
   * and the write-refusal consults its `textEditable`. Built once per mount
   * around the shared extraction cache.
   */
  const readers = createFileReaderRegistry(docExtract);

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
   * here would happen before the handler's access and ontology gates. A branch
   * not cloned yet (or that does not resolve) is left to the handler; the
   * filesystem refuses again underneath regardless.
   */
  const assertToolPathsNotGitInternals = async (args: Record<string, unknown>, ctx: ToolContext): Promise<void> => {
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
    for (const p of paths) assertNoGitInternalsSegment(p);
    const onDisk = paths.filter((p) => !spillStore.isSpillRef(p));
    if (onDisk.length === 0 || typeof args.branch !== 'string' || args.branch === '') return;
    let fs: LocalFilesystem;
    try {
      if (!(await ctx.workspaceService.hasBootstrappedWorkspace(workspaceIdForBranch(args.branch)))) return;
      fs = await ctx.getFilesystem(args.branch);
    } catch {
      return;
    }
    if (!(fs instanceof GitGuardedFilesystem)) return;
    for (const p of onDisk) await fs.assertNotGitInternals(p);
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

  /**
   * The paths among `paths` the caller may NOT write, judged exactly as the
   * lock gate judges them (`WorkflowService.acquireLock`): on a protected
   * branch only, against the access tree at HEAD, with no rules at HEAD
   * meaning allow. Empty on a draft branch — changes there reach a protected
   * branch only through a change request.
   */
  const writeBlocked = async (branch: string, ctx: ToolContext, paths: string[]): Promise<string[]> => {
    if (!isProtectedBranch(branch)) return [];
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
  const writeRefusal = async (branch: string, path: string): Promise<AccessDeniedError> => {
    const rel = toKbRelative(path, kbDirName);
    const eligible = rel === null
      ? null
      : await accessControl.eligibleWritersAtRef(workspaceIdForBranch(branch), 'HEAD', rel);
    return new AccessDeniedError({
      path,
      eligibleRoles: eligible?.roles ?? [],
      eligibleUsers: eligible?.users ?? [],
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
      return rel !== null && isPlatformFile(rel) ? platformFileRefusal(rel) : undefined;
    }
    if (norm === '' || norm === kbDirName) return platformFolderRefusal('');
    const rel = toKbRelative(norm, kbDirName);
    return rel !== null && isPlatformFolder(rel) ? platformFolderRefusal(rel) : undefined;
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
    description: string;
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
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    const def = toolDef({
      name: spec.name,
      // Every workspace entrypoint carries the AGENTS.md reminder, every file
      // tool the one content rule, and every tool a permission can refuse the
      // proposal route — appended once here so no tool (especially the
      // read-only ones a session hits first) can miss them.
      description:
        spec.description +
        (spec.proposable ? PROPOSAL_ROUTE_NOTE : '') +
        (spec.fileTool === false ? '' : CONTENT_RULE) +
        KB_CONVENTIONS_NOTE,
      path,
      inputs: spec.inputs,
      outputs: spec.outputs,
      tags: spec.write ? ['workspace', 'write'] : ['workspace'],
    });
    registry.registerInternalTool(def);
    if (!spec.internalOnly) registry.registerExternalTool(def);
    // Internal-only tools (e.g. `execute_command`) keep their route mounted —
    // our agent calls it over the same loopback — but gate it to internal-source
    // callers so an external connection key can't invoke it by name.
    router.post(
      path.slice('/api'.length),
      toolAuth,
      ...(spec.internalOnly ? [requireInternalSource] : []),
      // A leading slash is the root-anchored form Copy path gives and names
      // the same workspace path — normalised once here, for every path input.
      toolHandler(
        async (args, ctx) => {
          const normalized = normalizePathArgs(args);
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
              kbDirName,
              changeGate,
            );
          }
        },
        { write: spec.write },
      ),
    );
  };

  // ── session bootstrap (external agents) ─────────────────────────────────
  // Every read/write tool below scopes the ontology-session boundary off a
  // `sessionId`. The in-process agent carries its thread id, but an external
  // agent has no ambient run id and so cannot satisfy the gate until it has
  // one. This mints that id up front (called ONCE); the MCP proxy then threads
  // it onto every later gated call via its sessionId-output continuity
  // convention. EXTERNAL-ONLY (not registered internal): the in-process agent
  // already supplies its session id and ignores any body value.
  //
  // WHAT the minted id is backed by is the `ISessionSink` port's business
  // (session-sink.ts). In the enterprise app it is a REAL chat-thread id, so
  // the SAME id works end to end: KB reads scope the ontology boundary under
  // it, AND `ask` accepts it (its sessionId IS a chat thread, resolved via
  // getThread) — that unification is what stops a caller reading from one
  // ontology and then having `ask` write into another. In a core-only
  // deployment (no chat/ask) the default sink mints a bare id, which is all
  // the ontology gate needs.
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
      'Mint the KnowledgeBase session id this run needs to read or write the knowledge ontologies. Call this ONCE, before any other KnowledgeBase tool, and only once per run — every gated tool needs the `sessionId` it returns to enforce the one-ontology-per-conversation boundary, and minting a new id mid-run resets that boundary. The id is also a chat session in the app, so you can hand the SAME id to the `ask` tool: reads and ask then share one ontology boundary. Pass the returned id explicitly as `sessionId` on every subsequent KnowledgeBase tool call (direct MCP calls and inside `call_tool_chain` alike). RETRYING IS SAFE: a call that fails created nothing, so retry it — there is no half-made session to clean up. If a retry lands after a success you simply hold two independent ids, which is harmless: keep passing the one id you have already used for the rest of the run and ignore the other. Returns `{ sessionId }`.',
    path: '/api/agent/tools/start_session',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: { sessionId: str('The minted session id — pass it as `sessionId` on subsequent KnowledgeBase tool calls and to `ask`.') },
      required: ['sessionId'],
    },
    tags: ['workspace'],
  });
  registry.registerExternalTool(startSessionDef);
  // Mint the session id via the sink and return it (see comment above: one id
  // spans start_session -> reads -> ask, closing the ontology-pollution gap).
  router.post(
    '/agent/tools/start_session',
    toolAuth,
    // External-only: an internal token already carries its run's sessionId, so
    // minting a new thread mid-run would reset the ontology boundary. Note
    // "external" includes the MCP proxy's `externalProxy` loopback tokens
    // (OAuth/JWT MCP sessions) — the verifier resolves those to
    // `source: 'external'`, and one such session may legitimately mint several
    // per-chat sessionIds over its lifetime.
    requireExternalSource,
    toolHandler(async (_args, ctx) => {
      const { sessionId } = await sessionSink.createSession(ctx.user.id, new Date());
      return { sessionId };
    }),
  );

  // ── reads ──────────────────────────────────────────────────────────────
  mount({
    name: 'read_file',
    description:
      'Read a workspace file as text. Returns `{ path, content }`. Images (.png/.jpg/.jpeg/.gif/.webp) return the IMAGE ITSELF as native MCP image content (plus a one-line text note naming the file), so you can look at the picture — up to 3.5 MB of raw image data; a larger image gets an honest refusal asking for a locally downscaled copy or a smaller export (`.svg` is text and reads as text). Images come back only on a DIRECT call: inside `call_tool_chain` an image read yields an `{ image_omitted, note }` stub instead. Office and OpenDocument files (.docx/.pptx/.xlsx, .odt/.odp/.ods) and PDFs return their EXTRACTED text under an honest `[extracted text of …]` header, with `[slide N]`/`[sheet: Name]`/`[page N]` markers — the extraction is READ-ONLY (layout/images omitted; such files cannot be edited as text, only replaced by uploading a new version). Email files (.eml/.msg) return their EXTRACTED text the same way: a `[from]`/`[to]`/`[subject]`/`[date]` header block, the body (plain-text part preferred; an HTML-only body is stripped to text), and an `[attachments]` name list — attachments are listed, never extracted. Other binary files return a one-line description instead of raw bytes. Optional `offset`/`limit` slice the content (characters for a file, bytes for a `__tool_chain_spill__/…` ref; ignored for an image) — use them to page through large files or a `call_tool_chain` spill rather than reading multi-MB in full. A spill ref is workspace-independent: `branch` is ignored for it.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str(`Path to read, starting with \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), with or without a leading slash, or a \`__tool_chain_spill__/…\` ref from a truncated \`call_tool_chain\`.`),
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
      await recordOntologyRead(sessionOntologyGate, ctx, p);
      await assertCanRead(readGateFor(a.branch as string, ctx), p);
      const fs = await ctx.getFilesystem(a.branch as string);
      // Reading (extraction, image and binary handling included) happens AFTER
      // the access gate and the ontology-read recording above — a document
      // read is still a KB read. ONE registry dispatch picks the reader by
      // extension; everything below just maps its ReadResult onto the tool's
      // result shape.
      const bytes = await orNotFound(p, async () => asBytes(await fs.readFile(p)));
      const result = await readers.readerFor(p).read(bytes, p);
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
      const start = offset && offset > 0 ? offset : 0;
      const sliced = offset !== undefined || limit !== undefined
        ? content.slice(start, limit !== undefined ? start + limit : undefined)
        : content;
      return { path: p, content: sliced };
    },
  });

  mount({
    name: 'list_files',
    description:
      `List a directory. Returns \`{ path, entries: [{ name, type, size? }] }\`. Omit \`path\` for the workspace root, which holds the repository as the \`${kbDirName}/\` folder: every content path starts with it (e.g. \`${kbDirName}/KnowledgeBase\`).` +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str(`Directory to list, starting with \`${kbDirName}/\`, with or without a leading slash (default: the workspace root, where the repository is the \`${kbDirName}/\` folder).`),
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
      await recordOntologyRead(sessionOntologyGate, ctx, dir);
      const fs = await ctx.getFilesystem(a.branch as string);
      const entries = withoutPlaceholder((await fs.readdir(dir || '.')) as DirEntry[]);
      const filtered = await filterReadableEntries(readGateFor(a.branch as string, ctx), dir, entries);
      return { path: a.path ?? '', entries: filtered };
    },
  });

  mount({
    name: 'file_stat',
    description:
      'Get a file/directory\'s metadata (name, type, size, …) without returning content. A file also reports `contentMode`: `text` (read, write and edit it as text), `document` (read returns an extraction; replace it by upload) or `binary` (bytes: copy, move, delete, or replace by upload), plus `kind` (`text` | `document` | `image` | `binary`), `mime`, `mimeSource` and `textEditable` — decided by the same file readers read_file, grep and the write tools use, so an extensionless text file is `text/plain`.' +
      ' Every entry also reports what you may DO with it. ' +
      '`managed` is true for a platform item — a platform file (`access.md`, `roles.yaml`, `.bevelignore`, `AGENTS.md`) or a platform folder (the repository root or a reserved root folder such as `KnowledgeBase/`); managed items are never movable or deletable through these tools. ' +
      '`access: { read, write, download, owner }` is your own verdict under the access rules; pass `explainAccess: true` to learn why, and who else holds each verb. `movable` and `deletable` say whether `move_file` / `delete_file` / `delete_folder` would be allowed for you, judged like their dry runs: not managed, no symbolic link, and on a protected branch you hold write on the item AND on every file under a folder (on a draft branch writes are not gated). `movable` judges the source side only; the destination is judged by a `move_file` dry run. ' +
      'For a folder, `descendants` is the number of files under it at any depth; counting stops at 10000 and `descendantsTruncated` says so, and past that point `movable` and `deletable` are false because a folder that large was not judged in full — run the `move_file` or `delete_folder` dry run for the real verdict. ' +
      'Call this before a move or delete to see what it would touch.' +
      ONTOLOGY_BOUNDARY_NOTE,
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
      },
      required: ['managed', 'movable', 'deletable', 'access'],
      additionalProperties: true,
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      const p = a.path as string;
      const branch = a.branch as string;
      await recordOntologyRead(sessionOntologyGate, ctx, p);
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
      const managed = managedReason(await onDiskSpelling(root, p), kind) !== undefined;
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
      const decided = managed || link;
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
        movable: open,
        // delete_folder also refuses a folder holding a link.
        deletable: open && links.length === 0,
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
    description:
      'Regex content search across the workspace. Returns `{ matches: [{ path, line, text }] }` (capped). Use to find where something is defined/referenced. `path` may name a DIRECTORY (searches the subtree) or a single FILE (searches just that file); a path with nothing at it is an error, never an empty result. Searches INSIDE Office and OpenDocument files (.docx/.pptx/.xlsx, .odt/.odp/.ods), PDFs and email files (.eml/.msg) via their extracted text — matches there carry the extraction\'s line numbers, and the `[slide N]`/`[sheet: Name]`/`[page N]`/`[from]`/`[subject]` marker lines locate them; a bounded number of not-yet-extracted documents is extracted per call, and the result notes how many were skipped (re-run to cover them).' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        pattern: str('JavaScript regular expression.'),
        path: str('Subtree to search, or a single file to search on its own, with or without a leading slash (default: whole workspace).'),
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
      const searchRoot = typeof a.path === 'string' ? a.path : '';
      // The search root itself is checked here (fail-closed for an agent grep on
      // a named subtree with no sessionId); each file the walk actually opens is
      // recorded per-file below, so a root-level grep that reaches into multiple
      // ontologies still records each one (and can poison later writes).
      await recordOntologyRead(sessionOntologyGate, ctx, searchRoot);
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
      if (kind === 'directory') {
        await grepWalk(
          fs,
          searchRoot,
          re,
          out,
          max,
          0,
          gate,
          (p) => recordOntologyRead(sessionOntologyGate, ctx, p),
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
    description:
      'Write a workspace TEXT file. The change is committed + pushed as you. Returns `{ path, bytes, outcome }`, where `outcome` is ' +
      '`created`, `replaced` or `updated`.' +
      WRITE_MODE_NOTE +
      IMAGE_CONVENTION_NOTE +
      ONTOLOGY_BOUNDARY_NOTE,
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
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.path as string);
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
      };
    },
  });

  mount({
    name: 'write_files',
    description:
      'Batch-write many files in ONE commit — far faster than calling write_file once per file when ' +
      'creating many files at once (e.g. seeding a knowledge base). Each entry is `{ path, content }`, and the files it ' +
      'writes are committed + pushed together as you. Prefer this over many write_file ' +
      'calls. All files must be in the SAME ontology (the boundary below applies to the batch). Text files only. ' +
      'Returns `{ count, files }`: one entry per REQUESTED path, in the order you gave them, each `{ path, outcome }` — ' +
      '`created` / `replaced` / `updated` for a path it wrote, or `refused` with `error` (the code) and `message` (why) for a ' +
      'path it could not. `count` is how many were written. A path it refuses — the mode said no, or the file is not text — ' +
      'does not stop the others; read `files` to see what landed.' +
      WRITE_MODE_NOTE +
      IMAGE_CONVENTION_NOTE +
      ONTOLOGY_BOUNDARY_NOTE,
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
      },
      required: ['count', 'files'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      const files = (a.files as Array<{ path: string; content: string }>) ?? [];
      if (files.length === 0) return { count: 0, files: [] };
      const mode = modeOf(a);
      // The POLICY gates still judge the whole batch: a restricted run or a
      // cross-ontology batch is a call that should not have been made at all,
      // not a per-path outcome, and the ontology gate must see every path
      // before anything lands. What a single FILE is (not text) or what its
      // path already holds (the mode) is decided per path, below.
      for (const f of files) writePolicy.assertPathWritable(ctx.sessionId, f.path);
      for (const f of files) await assertOntologyWriteAllowed(sessionOntologyGate, ctx, f.path);
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
      return { count: outcomes.filter((o) => o.outcome !== 'refused').length, files: outcomes };
    },
  });

  mount({
    name: 'edit_file',
    description:
      'Replace an exact string in a workspace TEXT file. `old_string` must appear exactly once unless `replace_all`. Committed + pushed as you.' +
      ONTOLOGY_BOUNDARY_NOTE,
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
      properties: { path: str('The path edited (echoes the input).'), replaced: int('Number of occurrences replaced.') },
      required: ['path', 'replaced'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      assertNotDocumentEdit(readers, a.path as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.path as string);
      const fs = await ctx.getFilesystem(a.branch as string);
      const path = a.path as string;
      const oldStr = a.old_string as string;
      const newStr = a.new_string as string;
      // The overwrite gate already read the file when its reader asked the
      // binary question — reuse those bytes instead of reading twice.
      const content = await orNotFound(path, async () => {
        const existing = await assertNotBinaryOverwrite(readers, path, fs);
        return asText(existing ?? (await fs.readFile(path)));
      });
      const count = oldStr ? content.split(oldStr).length - 1 : 0;
      if (count === 0) throw new ToolError('old_string not found in the file.', 400);
      if (count > 1 && a.replace_all !== true) {
        throw new ToolError(`old_string appears ${count} times — add more context to make it unique, or set replace_all.`, 400);
      }
      const updated = a.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      await fs.writeFile(path, updated);
      return { path, replaced: a.replace_all === true ? count : 1 };
    },
  });

  mount({
    name: 'delete_file',
    description:
      'Delete ONE workspace file (a symbolic link is refused: links are never followed or removed). Committed + pushed as you. Its folder stays, even when this was its last file. Files only: a folder is refused with a pointer to `delete_folder`. ' +
      'A platform file (`access.md` or `.bevelignore` in any folder, `roles.yaml` or `AGENTS.md` at the repository root) and git metadata are refused.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path to the file', false),
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
      // A delete propagates no cross-ontology information (it removes a node, it
      // doesn't carry bytes from elsewhere), so it is NOT ontology-write-gated — it
      // only records the ontology it touched, like a read. The extension policy
      // DOES apply though: a dashboard-only run must not delete graph `.md` nodes.
      const path = a.path as string;
      const branch = a.branch as string;
      writePolicy.assertPathWritable(ctx.sessionId, path);
      await recordOntologyRead(sessionOntologyGate, ctx, path);
      const fs = await ctx.getFilesystem(branch);
      assertPlainPath(path);
      const root = await workspaceRoot(branch, ctx);
      if (await isSymlinkAt(root, path)) throw new ToolError(linkRefusal(path), 400);
      if ((await kindOf(fs, path)) === 'folder') {
        throw new ToolError(`"${path}" is a folder, not a file — use delete_folder to delete it and the files under it.`, 400);
      }
      const onDisk = await onDiskSpelling(root, path);
      if (isGitMetadata(onDisk)) throw new ToolError(managedReason(onDisk, 'file')!, 400);
      if (managedReason(onDisk, 'file') !== undefined) {
        throw new ToolError(`${onDisk.slice(onDisk.lastIndexOf('/') + 1)} is a platform file and cannot be deleted through the agent tools.`, 400);
      }
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
    description:
      'Delete a workspace FOLDER and every file under it, at any depth; the whole folder lands as ONE committed + pushed change as you — all of it or none of it — then the empty folder is removed. This is the one way a folder goes away: the folder that held it stays, even if this was all it had, and a folder holding nothing but its empty-folder placeholder counts as empty. ' +
      'Preflight first: `dryRun: true` changes nothing and answers `{ path, kind: "folder", descendants, files, filesTruncated, allowed, reason? }` — `descendants` is the file count, `files` names up to 100 of them. ' +
      'A non-empty folder is deleted only with `confirm: true`; without it the call deletes nothing and returns the same impact with `confirmationRequired: true`. Do NOT set `confirm: true` on your first call — dry-run, check the impact, then confirm. ' +
      'Refused (in a dry run as `allowed: false` with the `reason`): a platform folder (the repository root or a reserved root folder such as `KnowledgeBase/`), git metadata, a folder holding a symbolic link (links are never removed), and a folder holding any file you may not write. A path that is a file is refused with a pointer to `delete_file`, and a path through a symbolic link is refused (links are never followed). ' +
      'The folder\'s own platform files (`access.md`, `.bevelignore`) go with it in that same one change, so its files are never left ungoverned part-way; you must be able to write those platform files too.' +
      ONTOLOGY_BOUNDARY_NOTE,
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
      assertInsideRepo(path, kbDirName);
      await recordOntologyRead(sessionOntologyGate, ctx, path);
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
        if (blocked.length > 0) throw await writeRefusal(branch, blocked[0]);
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
    description: 'Create a directory (recursive). It lists as an empty folder and persists in git until it is deleted explicitly.' + ONTOLOGY_BOUNDARY_NOTE,
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
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.path as string);
      await (await ctx.getFilesystem(a.branch as string)).mkdir(a.path as string, { recursive: true });
      return { path: a.path, created: true };
    },
  });

  mount({
    name: 'move_file',
    description:
      'Move or rename a workspace FILE or FOLDER; a folder moves recursively, with everything under it. `dest` is the full new path, not the folder to move into. Lands as a delete + create, committed + pushed as you. ' +
      'Rules: the destination must not exist — a move never overwrites a file or merges into a folder; a platform file (`access.md` or `.bevelignore` in any folder, `roles.yaml` or `AGENTS.md` at the repository root) is refused with "<name> is a platform file and stays in its folder." — a folder that moves takes its own platform files along, still in their folder; a platform folder (the repository root or a reserved root folder such as `KnowledgeBase/`) and git metadata are refused; a move cannot create a platform file or folder at `dest` either (renaming a note to `access.md` is refused); a path through a symbolic link is refused, since links are never followed; on a protected branch you must be able to write both ends — for a folder, every file under it at its old and its new path. ' +
      'Access follows the destination folder. Preflight first: `dryRun: true` changes nothing and answers `{ src, dest, kind, descendants, access: { before, after }, accessChanges, allowed, reason? }` — `access` is your own `{ read, write, download, owner }` at the source and at the destination. ' +
      'A move whose `accessChanges` is true runs only with `confirm: true`; without it the call moves nothing and returns the same impact with `confirmationRequired: true`. Do NOT set `confirm: true` on your first call — dry-run, check the impact, then confirm.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: wsPath(kbDirName, 'Source path (file or folder)', false),
        dest: wsPath(kbDirName, 'Destination path — the full new path; must not exist yet'),
        dryRun: { type: 'boolean', description: 'Answer with the impact and change nothing.' },
        confirm: { type: 'boolean', description: 'Required when the move changes your access. Set it only after a dry run.' },
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
        access: { type: 'object', description: 'Your `{ read, write, download, owner }` at the source (`before`) and destination (`after`).' },
        accessChanges: { type: 'boolean', description: 'True when any of your verdicts differs between source and destination.' },
        allowed: { type: 'boolean', description: 'Whether the move may run.' },
        reason: str('Why it may not, when `allowed` is false.'),
        dryRun: { type: 'boolean', description: 'True on a dry run.' },
        confirmationRequired: { type: 'boolean', description: 'True when the call stopped for want of `confirm: true`.' },
        message: str('One sentence on what happened (or did not).'),
        moved: { type: 'boolean', description: 'True once the move landed.' },
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
      // A move CARRIES the source content into the destination — a genuine
      // cross-ontology flow if the two differ — so BOTH endpoints are write-gated
      // (unlike a plain delete, which moves no content). Check both BEFORE
      // touching disk so a blocked endpoint can't leave the source already deleted.
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, src);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, dest);
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

      const [before, after] = await Promise.all([accessAt(branch, ctx, src), accessAt(branch, ctx, dest)]);
      const accessChanges = (Object.keys(before) as (keyof AccessVerbs)[]).some((v) => before[v] !== after[v]);
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
      const impact = {
        src,
        dest,
        kind,
        descendants,
        access: { before, after },
        accessChanges,
        allowed: reason === undefined,
        ...(reason !== undefined ? { reason } : {}),
      };
      if (a.dryRun === true) return { ...impact, dryRun: true, moved: false };
      if (managed) throw new ToolError(reason!, 400);
      if (blocked.length > 0) throw await writeRefusal(branch, blocked[0]);
      if (collision) throw new ToolError(reason!, 409);
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
      await asEntryExists(() => fs.moveFile(src, dest));
      // Moving the last file — or a whole folder — out leaves the folder it
      // came from in place, like a delete.
      await keepFolderOf(fs, ctx, branch, src, kbDirName);
      return { ...impact, moved: true };
    },
  });

  mount({
    name: 'copy_file',
    description:
      'Copy a workspace file to a new path. The destination must not exist — like a move, a copy never overwrites a file or a folder; to change what is in a file that already exists, write it. Committed + pushed as you.'
      + ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: wsPath(kbDirName, 'Source path', false),
        dest: wsPath(kbDirName, 'Destination path — must not exist yet'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'src', 'dest'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { src: str('Source path (echoes the input).'), dest: str('Destination path (echoes the input).'), copied: { type: 'boolean', description: 'Always true on success.' } },
      required: ['src', 'dest', 'copied'],
    },
    write: true,
    proposable: true,
    handler: async (a, ctx: ToolContext) => {
      // A copy CARRIES the source content into the destination — a genuine
      // cross-ontology flow if the two differ — so BOTH endpoints are write-gated.
      // Check both before touching disk.
      writePolicy.assertPathWritable(ctx.sessionId, a.src as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.dest as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.src as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.dest as string);
      const branch = a.branch as string;
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
    description:
      'Extract a .zip already in the workspace (defaults to the zip\'s parent). Returns extracted files + skipped entries. Existing files are overwritten.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: wsPath(kbDirName, 'Path to the .zip archive', false),
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
      // Reading the source archive pins/records the source ontology, so a session
      // can't unzip from ontology A into ontology B without the A read counting.
      await recordOntologyRead(sessionOntologyGate, ctx, zipPath);
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
            // Each extracted file is a write: a cross-ontology or write-blocked entry
            // is skipped (not extracted), so an archive can't bypass the boundary — the
            // extension policy applies per entry too, so a restricted run can't unzip a
            // `.md` into the graph.
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
              return assertOntologyWriteAllowed(sessionOntologyGate, ctx, wsRelPath);
            },
          ),
        'Nothing to extract',
      );
    },
  });

  // ── shell (internal-only) ───────────────────────────────────────────────
  mount({
    name: 'execute_command',
    description:
      'Run a shell command in the workspace directory. Returns `{ stdout, stderr, exitCode }` (output capped). Use for git status/log, grep/rg, build/test commands.' +
      ONTOLOGY_BOUNDARY_NOTE,
    internalOnly: true,
    fileTool: false,
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
      // Shell is a write path with no single target path to check, so enforce the
      // boundary at the session level: refuse once the run is already write-blocked,
      // or when the run is restricted to a file type (shell could write anything).
      writePolicy.assertUnrestricted(ctx.sessionId);
      await assertShellAllowedWithinOntology(sessionOntologyGate, ctx);
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
}
