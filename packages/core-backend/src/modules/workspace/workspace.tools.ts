import { spawn } from 'node:child_process';
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
import type { ISessionSink } from './session-sink.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { toKbRelative, resolveReadableMap } from '../access-model/kb-read-filter.js';
import type { SpillStore } from './spill-store.js';
import type { DocExtractService } from './file-readers/doc-extract.service.js';
import type { FileReaderRegistry } from './file-readers/file-reader.js';
import { createFileReaderRegistry } from './file-readers/file-reader.registry.js';
import { DocumentReader } from './file-readers/document-reader.js';
import { mcpImageResult } from '@bevel-software/platform-mcp-core';

/** A directory entry as returned by `LocalFilesystem.readdir`. */
interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
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
 * The write-refusal for office documents/PDFs on the agent TEXT-editing tools
 * (write_file / write_files / edit_file). `read_file` returns an EXTRACTION
 * for these types — their reader declares `textEditable: false` — so an agent
 * that "read" one and writes text back would
 * silently destroy the real document. Uploads and the plain HTTP write routes
 * are untouched — humans replacing a document is exactly the right move — and
 * `unzip` stays the raw-access escape hatch.
 */
function assertNotDocumentEdit(readers: FileReaderRegistry, path: string): void {
  const reader = readers.readerFor(path);
  if (reader.textEditable) return;
  throw new ToolError(
    reader.editRefusal?.(path) ??
      `"${path}" is an office document/PDF. read_file returns EXTRACTED text for it — not the file's real ` +
        'content — so text written back cannot round-trip and would corrupt the document. To change it, ' +
        'replace the document by uploading a new version.',
    400,
  );
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
    // FileNotFoundError carry code 'ENOENT'). Any other failure — permissions,
    // I/O — means the existing content could not be inspected: propagate it
    // rather than let the write destroy bytes the gate never saw.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return undefined; // nothing there yet
    throw err;
  }
  const refusal = reader.editRefusalForExisting(existing, path);
  if (refusal !== null) throw new ToolError(refusal, 400);
  return existing;
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
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.type === 'directory') {
      await grepWalk(fs, p, re, out, max, depth + 1, gate, recordOntologyRead, docs);
    } else {
      // Opening a file under a named ontology is a read of that ontology — even
      // for a root-level grep that resolves to a neutral root. Record it so a
      // cross-ontology grep poisons later writes (closes the read-leak).
      await recordOntologyRead(p);
      // What grep searches is the file's reader's business: text content for
      // the text reader (null on NUL bytes — binary is not searchable), the
      // EXTRACTION for a document reader (marker line included, so the
      // [slide N]/[sheet: …]/[page N] lines are themselves searchable and
      // line numbers match what read_file returns), nothing for images.
      const reader = docs.readers.readerFor(p);
      let content: string | null;
      try {
        const bytes = asBytes(await fs.readFile(p));
        content = reader.greppableText ? await reader.greppableText(bytes, p) : null;
        if (content === null && reader instanceof DocumentReader) {
          // Cold document (extraction not yet cached): cached ones above are
          // free, extracting draws on the per-walk budget (see
          // UNCACHED_DOCS_PER_GREP) — beyond it the walk skips and counts.
          if (docs.uncachedBudget <= 0) {
            docs.skippedUncached++;
            continue;
          }
          docs.uncachedBudget--;
          const res = await reader.read(bytes, p);
          // A non-text outcome is a corrupt document — nothing searchable.
          content = res.kind === 'text' ? res.text : null;
        }
      } catch {
        continue;
      }
      if (content === null) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && out.length < max; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) out.push({ path: p, line: i + 1, text: lines[i].slice(0, 300) });
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

  const mount = (spec: {
    name: string;
    description: string;
    inputs: JsonSchema;
    outputs?: JsonSchema;
    write: boolean;
    internalOnly?: boolean;
    handler: ToolHandler;
  }): void => {
    const path = `/api/agent/tools/${spec.name}`;
    const def = toolDef({
      name: spec.name,
      // Every workspace entrypoint carries the AGENTS.md reminder, appended once
      // here so no tool (especially the read-only ones a session hits first) can
      // miss it.
      description: spec.description + KB_CONVENTIONS_NOTE,
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
      toolHandler(spec.handler, { write: spec.write }),
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
  const startSessionDef = toolDef({
    name: 'start_session',
    description:
      'Mint the KnowledgeBase session id this run needs to read or write the knowledge ontologies. Call this ONCE, before any other KnowledgeBase tool, and only once per run — every gated tool needs the `sessionId` it returns to enforce the one-ontology-per-conversation boundary, and minting a new id mid-run resets that boundary. The id is also a chat session in the app, so you can hand the SAME id to the `ask` tool: reads and ask then share one ontology boundary. Pass the returned id explicitly as `sessionId` on every subsequent KnowledgeBase tool call (direct MCP calls and inside `call_tool_chain` alike). Returns `{ sessionId }`.',
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
        path: str('Workspace-relative path, or a `__tool_chain_spill__/…` ref from a truncated `call_tool_chain`.'),
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
      const result = await readers.readerFor(p).read(asBytes(await fs.readFile(p)), p);
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
      'List a directory. Returns `{ path, entries: [{ name, type, size? }] }`. Omit `path` for the workspace root.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative directory (default: root).'),
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
      const entries = (await fs.readdir(dir || '.')) as DirEntry[];
      const filtered = await filterReadableEntries(readGateFor(a.branch as string, ctx), dir, entries);
      return { path: a.path ?? '', entries: filtered };
    },
  });

  mount({
    name: 'file_stat',
    description:
      'Get a file/directory\'s metadata (name, type, size, …) without reading content.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative path.'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      description: "The filesystem entry's metadata.",
      properties: { name: str('Entry name.'), type: str('`file` or `directory`.'), size: int('Size in bytes.') },
      additionalProperties: true,
    },
    write: false,
    handler: async (a, ctx: ToolContext) => {
      const p = a.path as string;
      await recordOntologyRead(sessionOntologyGate, ctx, p);
      await assertCanRead(readGateFor(a.branch as string, ctx), p);
      return (await ctx.getFilesystem(a.branch as string)).stat(p);
    },
  });

  mount({
    name: 'grep',
    description:
      'Regex content search across the workspace. Returns `{ matches: [{ path, line, text }] }` (capped). Use to find where something is defined/referenced. Searches INSIDE Office and OpenDocument files (.docx/.pptx/.xlsx, .odt/.odp/.ods), PDFs and email files (.eml/.msg) via their extracted text — matches there carry the extraction\'s line numbers, and the `[slide N]`/`[sheet: Name]`/`[page N]`/`[from]`/`[subject]` marker lines locate them; a bounded number of not-yet-extracted documents is extracted per call, and the result notes how many were skipped (re-run to cover them).' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        pattern: str('JavaScript regular expression.'),
        path: str('Subtree to search (default: whole workspace).'),
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
        note: str('Present when some documents (office/PDF/email files) were not searched because their text was not yet extracted and the per-call extraction budget ran out — re-run grep to cover them.'),
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
      const out: { path: string; line: number; text: string }[] = [];
      const max = typeof a.max_results === 'number' ? Math.min(a.max_results, 1000) : 200;
      const docs: DocGrepState = { readers, uncachedBudget: UNCACHED_DOCS_PER_GREP, skippedUncached: 0 };
      await grepWalk(
        await ctx.getFilesystem(a.branch as string),
        searchRoot,
        re,
        out,
        max,
        0,
        readGateFor(a.branch as string, ctx),
        (p) => recordOntologyRead(sessionOntologyGate, ctx, p),
        docs,
      );
      return {
        matches: out,
        truncated: out.length >= max,
        ...(docs.skippedUncached > 0
          ? {
              note:
                `${docs.skippedUncached} document(s) (office/PDF/email files) were not searched: their text was not yet ` +
                `extracted and this call's extraction budget (${UNCACHED_DOCS_PER_GREP}) ran out. Re-run the ` +
                'same grep to extract and search the next batch.',
            }
          : {}),
      };
    },
  });

  // ── writes (through the lock/commit pipeline) ───────────────────────────
  mount({
    name: 'write_file',
    description:
      'Write (create or overwrite) a workspace file. The change is committed + pushed as you. Returns `{ path, bytes }`. Refuses document formats: Office/OpenDocument files and PDFs (.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf) and email files (.eml/.msg), whose reads are text EXTRACTIONS that cannot round-trip, and legacy binary Office files (.doc/.ppt/.xls), which cannot be extracted at all; replace such a file by uploading a new version instead.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative path.'),
        content: str('Full file content.'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'path', 'content'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { path: str('The path written (echoes the input).'), bytes: int('Number of bytes written.') },
      required: ['path', 'bytes'],
    },
    write: true,
    handler: async (a, ctx: ToolContext) => {
      assertNotDocumentEdit(readers, a.path as string);
      // NB: this is a no-op for chat + `ontology_ingest` — it only bites when a
      // routine executor has explicitly restricted THIS session's `ctx.sessionId`
      // (today only `watchlist_check`, to `.html`). Unrestricted sessions pass straight
      // through (see `assertPathWritable`), so it does not limit other agents.
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.path as string);
      const fs = await ctx.getFilesystem(a.branch as string);
      await assertNotBinaryOverwrite(readers, a.path as string, fs);
      await fs.writeFile(a.path as string, a.content as string);
      return { path: a.path, bytes: Buffer.byteLength(a.content as string, 'utf8') };
    },
  });

  mount({
    name: 'write_files',
    description:
      'Batch-write many files in ONE commit — far faster than calling write_file once per file when ' +
      'creating many files at once (e.g. seeding a knowledge base). Each entry is `{ path, content }`; all ' +
      'are created/overwritten and committed + pushed together as you. Prefer this over many write_file ' +
      'calls. All files must be in the SAME ontology (the boundary below applies to the batch). Refuses document formats: ' +
      'Office/OpenDocument files and PDFs (.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf) and email files (.eml/.msg), whose reads are text EXTRACTIONS that cannot ' +
      'round-trip, and legacy binary Office files (.doc/.ppt/.xls); replace such a file by uploading a new version instead. Returns `{ count }`.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        files: {
          type: 'array',
          description: 'Files to write; each created or overwritten.',
          items: {
            type: 'object',
            properties: { path: str('Workspace-relative path.'), content: str('Full file content.') },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'files'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { count: int('Number of files written.') },
      required: ['count'],
    },
    write: true,
    handler: async (a, ctx: ToolContext) => {
      const files = (a.files as Array<{ path: string; content: string }>) ?? [];
      if (files.length === 0) return { count: 0 };
      // Gate every path first (records ontology touches; a cross-ontology batch
      // is blocked exactly like the per-file write tools).
      for (const f of files) assertNotDocumentEdit(readers, f.path);
      for (const f of files) writePolicy.assertPathWritable(ctx.sessionId, f.path);
      for (const f of files) await assertOntologyWriteAllowed(sessionOntologyGate, ctx, f.path);
      // `write: true` guarantees a LockingFilesystem here; `writeFiles` lands the
      // whole batch as one commit. Structural cast avoids a workflow-internal import.
      const fs = (await ctx.getFilesystem(a.branch as string)) as unknown as {
        writeFiles(writes: { path: string; content: string }[], summary: string): Promise<void>;
        readFile(p: string): Promise<string | Buffer>;
      };
      for (const f of files) await assertNotBinaryOverwrite(readers, f.path, fs);
      await fs.writeFiles(
        files.map((f) => ({ path: f.path, content: f.content })),
        `Write ${files.length} file(s)`,
      );
      return { count: files.length };
    },
  });

  mount({
    name: 'edit_file',
    description:
      'Replace an exact string in a workspace file. `old_string` must appear exactly once unless `replace_all`. Committed + pushed as you. Refuses document formats: Office/OpenDocument files and PDFs (.docx/.pptx/.xlsx/.odt/.odp/.ods/.pdf) and email files (.eml/.msg), whose reads are text EXTRACTIONS that cannot round-trip, and legacy binary Office files (.doc/.ppt/.xls), which cannot be extracted at all; replace such a file by uploading a new version instead.' +
      ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative path.'),
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
      const existing = await assertNotBinaryOverwrite(readers, path, fs);
      const content = asText(existing ?? (await fs.readFile(path)));
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
    description: 'Delete a workspace file. Committed + pushed as you.' + ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative path.'),
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
    handler: async (a, ctx: ToolContext) => {
      // A delete propagates no cross-ontology information (it removes a node, it
      // doesn't carry bytes from elsewhere), so it is NOT ontology-write-gated — it
      // only records the ontology it touched, like a read. The extension policy
      // DOES apply though: a dashboard-only run must not delete graph `.md` nodes.
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await recordOntologyRead(sessionOntologyGate, ctx, a.path as string);
      await (await ctx.getFilesystem(a.branch as string)).deleteFile(a.path as string);
      return { path: a.path, deleted: true };
    },
  });

  mount({
    name: 'mkdir',
    description: 'Create a directory (recursive). An empty dir gets a `.gitkeep` so it persists in git.' + ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        path: str('Workspace-relative directory.'),
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
    handler: async (a, ctx: ToolContext) => {
      writePolicy.assertPathWritable(ctx.sessionId, a.path as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.path as string);
      await (await ctx.getFilesystem(a.branch as string)).mkdir(a.path as string, { recursive: true });
      return { path: a.path, created: true };
    },
  });

  mount({
    name: 'move_file',
    description: 'Move/rename a workspace file. Lands as a delete + create. Committed + pushed as you.' + ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: str('Source path.'),
        dest: str('Destination path.'),
        sessionId: SESSION_ID_INPUT,
      },
      required: ['branch', 'src', 'dest'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: { src: str('Source path (echoes the input).'), dest: str('Destination path (echoes the input).'), moved: { type: 'boolean', description: 'Always true on success.' } },
      required: ['src', 'dest', 'moved'],
    },
    write: true,
    handler: async (a, ctx: ToolContext) => {
      // A move CARRIES the source content into the destination — a genuine
      // cross-ontology flow if the two differ — so BOTH endpoints are write-gated
      // (unlike a plain delete, which moves no content). Check both BEFORE
      // touching disk so a blocked endpoint can't leave the source already deleted.
      writePolicy.assertPathWritable(ctx.sessionId, a.src as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.dest as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.src as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.dest as string);
      await (await ctx.getFilesystem(a.branch as string)).moveFile(a.src as string, a.dest as string);
      return { src: a.src, dest: a.dest, moved: true };
    },
  });

  mount({
    name: 'copy_file',
    description: 'Copy a workspace file to a new path. Committed + pushed as you.' + ONTOLOGY_BOUNDARY_NOTE,
    inputs: {
      type: 'object',
      properties: {
        branch: BRANCH_INPUT,
        src: str('Source path.'),
        dest: str('Destination path.'),
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
    handler: async (a, ctx: ToolContext) => {
      // A copy CARRIES the source content into the destination — a genuine
      // cross-ontology flow if the two differ — so BOTH endpoints are write-gated.
      // Check both before touching disk.
      writePolicy.assertPathWritable(ctx.sessionId, a.src as string);
      writePolicy.assertPathWritable(ctx.sessionId, a.dest as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.src as string);
      await assertOntologyWriteAllowed(sessionOntologyGate, ctx, a.dest as string);
      await (await ctx.getFilesystem(a.branch as string)).copyFile(a.src as string, a.dest as string);
      return { src: a.src, dest: a.dest, copied: true };
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
        path: str('Workspace-relative .zip path.'),
        destination: str("Directory to extract into (default: the zip's parent)."),
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
      return ctx.workspaceService.unzipFile(
        workspaceIdForBranch(a.branch as string),
        zipPath,
        typeof a.destination === 'string' ? a.destination : undefined,
        // Each extracted file is a write: a cross-ontology or write-blocked entry
        // is skipped (not extracted), so an archive can't bypass the boundary — the
        // extension policy applies per entry too, so a restricted run can't unzip a
        // `.md` into the graph.
        (wsRelPath) => {
          writePolicy.assertPathWritable(ctx.sessionId, wsRelPath);
          return assertOntologyWriteAllowed(sessionOntologyGate, ctx, wsRelPath);
        },
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
        const child = spawn(a.command as string, { cwd, shell: true, env });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        // If the caller disconnects (request aborted), kill the child instead of
        // letting it run to the timeout; the resulting `close`/`error` settles
        // the promise through `finish`.
        const onAbort = () => child.kill('SIGKILL');
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
