/**
 * A tool call that sends a file. A `.tool`'s http call sends one input field
 * as the request body (`body_field`, `body` by default) and the tool runtime
 * sends what the agent put there: text, as JSON. An upload wants the bytes of
 * a file instead, and an agent has no way to put bytes in an argument. So a
 * tool declares the body field as a path (`format: file-path` on that
 * property's schema), the agent calls it with a knowledge-base path or a
 * staged file's `__tmp__/…` ref, and this wrapper swaps the path for the
 * file's bytes before the call leaves, read as the person (their own access;
 * a staged file is theirs alone). The template's `content_type` goes with it.
 *
 * Some APIs take a file only as one part of a form, beside the fields that
 * describe it. Such a tool declares `content_type: multipart/form-data` and a
 * body that is an object: each property is one part of the form, and a
 * property declared `format: file-path` is the part that carries a file. The
 * wrapper then swaps the whole object for the form, the file parts read the
 * same way.
 *
 * Installed on a code-mode client before its manuals are registered, so the
 * call guards registration installs sit over it: they check the arguments as
 * the agent gave them (a string where the schema says string) before the swap.
 * The MCP endpoint installs it on every caller's client; a distribution's own
 * in-process agent installs it on its client the same way. Nothing else about
 * the call changes: a tool without either declaration passes through
 * untouched, and so does a whole-body call with no path in that field, or a
 * form call whose body is not an object. (A form call whose body is an object
 * always goes out as the form, with or without its file parts.)
 */
import type { IAccessControl } from '../access/index.js';
import { canReadWorkspacePath } from '../access-model/index.js';
import { isTmpRef, normalizeWorkspacePath } from '../kb-fs/index.js';
import { rawMimeFor, type WorkspaceService } from '../workspace/index.js';
import { PathNotFoundError, VersionControlDomainError } from '../../shared/domain-errors.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { logger } from '../../shared/logging.js';

const log = logger('code-mode');

/** The JSON-schema `format` a body property carries to say "a file's path, sent as its bytes". */
export const FILE_PATH_FORMAT = 'file-path';

/** The template `content_type` that makes the body a form: every property of the body object is one part of it. */
const FORM_CONTENT_TYPE = 'multipart/form-data';

/** Marks the client's call methods as already wrapped here, so installing twice is free. */
const INSTALLED = Symbol.for('bevel.codeMode.fileBodies');

/** Reads the bytes a path or a `__tmp__/…` ref names, as the person the client runs for; throws `FileBodyError` when it cannot. */
export type FileBodyRead = (ref: string) => Promise<Uint8Array>;

/** The refusal a call gets when its file cannot be read: shaped like the platform's typed tool refusals, so the agent reads the reason. */
export class FileBodyError extends Error {
  status = 400;
  kind = 'file-body';
  data: { error: string; kind: string; status: number };
  response: { status: number; data: { error: string; kind: string; status: number } };
  constructor(message: string) {
    super(message);
    this.name = 'FileBodyError';
    this.data = { error: message, kind: this.kind, status: 400 };
    this.response = { status: 400, data: this.data };
  }
}

/** Where a body's file is read from: the workspace the agent's file tools read, and the person's read access to it. */
export interface FileBodySource {
  workspaces: Pick<WorkspaceService, 'readFileBinary' | 'readTmpFile'>;
  access: Pick<IAccessControl, 'canRead'>;
  /** The workspace of the default branch, asked on each read. */
  workspaceId(): string;
  /** The folder the knowledge base sits in, which a path may or may not carry. */
  kbDirName: string;
}

/** The person a file is read for: a staged ref resolves in their own tmp folder (by id), a repository path by their read access (by email). */
export interface FileBodyOwner {
  id: string;
  email: string;
}

/** The answer for a file the person may not read, or that is not there: one refusal for both, so probing discloses nothing. */
const notReadable = (ref: string) => new FileBodyError(`"${ref}" is not a file you can read, so it cannot be sent`);

/**
 * Whether a read failed because no file is at the path: nothing there (the shared `isAbsence`, or core's own
 * `PathNotFoundError`), or a folder (`EISDIR`), which is no file to send either. The file system's own error names
 * the path on disk, so it never reaches the agent.
 */
const isMissing = (err: unknown) =>
  isAbsence(err) || err instanceof PathNotFoundError || (err as { code?: unknown } | null)?.code === 'EISDIR';

/** `read`, with a missing file answered as the one refusal. */
async function orNotReadable(ref: string, read: () => Promise<Uint8Array>): Promise<Uint8Array> {
  try {
    return await read();
  } catch (err) {
    if (isMissing(err)) throw notReadable(ref);
    throw err;
  }
}

/**
 * The file a `.tool` call names as its body, read as the person: a staged file of theirs (`__tmp__/…`, read from
 * their own tmp folder only), or a knowledge-base file their access lets them read. A repository path is judged and
 * read as ONE path: put in its canonical form by core's normaliser (which refuses `..`, a backslash or a control
 * character), judged by `canReadWorkspacePath` (the single-path read verdict core's content routes share), then read,
 * so no spelling of a closed file passes on the root's grant.
 */
export function fileBodyReader(source: FileBodySource): { read(owner: FileBodyOwner | null, ref: string): Promise<Uint8Array> } {
  return {
    // A caller whose account is gone (`owner` null) reads nothing: the same refusal.
    read: async (owner, ref) => {
      if (!owner) throw notReadable(ref);
      const workspaceId = source.workspaceId();
      if (isTmpRef(ref)) return orNotReadable(ref, () => source.workspaces.readTmpFile(workspaceId, owner.id, ref));
      const wsPath = normalizeWorkspacePath(ref, source.kbDirName);
      const canRead = (w: string, email: string, rel: string) => source.access.canRead(w, email, rel);
      if (!(await canReadWorkspacePath(canRead, workspaceId, owner.email, source.kbDirName, wsPath))) throw notReadable(ref);
      return orNotReadable(ref, () => source.workspaces.readFileBinary(workspaceId, wsPath));
    },
  };
}

interface ToolLike {
  inputs?: unknown;
  tool_call_template?: unknown;
}

/**
 * How a tool sends a file: its body IS one file (`bytes`), or its body is a form whose `fileParts` are files
 * (`form`). `field` is the input the template sends as the body.
 */
export type FileBodyPlan = { field: string; kind: 'bytes' } | { field: string; kind: 'form'; fileParts: string[] };

/** Whether a schema node declares "a file's path, sent as its bytes". */
const isFilePath = (schema: unknown): boolean =>
  !!schema && typeof schema === 'object' && (schema as { format?: unknown }).format === FILE_PATH_FORMAT;

/**
 * What `tool` sends from files, or null when it sends none. An http tool whose body property is declared
 * `format: file-path` sends that one file as the body. An http tool whose template says `multipart/form-data` and
 * whose body is an object with at least one `format: file-path` property sends a form, those properties as files.
 */
export function fileBodyPlan(tool: ToolLike | null | undefined): FileBodyPlan | null {
  const template = tool?.tool_call_template as { call_template_type?: unknown; body_field?: unknown; content_type?: unknown } | undefined;
  if (!template || template.call_template_type !== 'http') return null;
  const field = typeof template.body_field === 'string' && template.body_field ? template.body_field : 'body';
  const properties = (tool?.inputs as { properties?: Record<string, unknown> } | undefined)?.properties;
  const property = properties?.[field] as { properties?: unknown } | undefined;
  if (isFilePath(property)) return { field, kind: 'bytes' };
  // The media type alone decides, whatever its case and whatever parameters follow it.
  const mediaType = typeof template.content_type === 'string' ? template.content_type.split(';')[0]!.trim().toLowerCase() : '';
  if (mediaType !== FORM_CONTENT_TYPE) return null;
  const parts = property && typeof property === 'object' ? property.properties : undefined;
  if (!parts || typeof parts !== 'object') return null;
  const fileParts = Object.entries(parts as Record<string, unknown>)
    .filter(([, schema]) => isFilePath(schema))
    .map(([name]) => name);
  return fileParts.length > 0 ? { field, kind: 'form', fileParts } : null;
}

/** The name a file part carries: the last segment of the path the call named. */
const fileNameOf = (ref: string): string => ref.slice(ref.lastIndexOf('/') + 1) || 'file';

interface ClientLike {
  config: { tool_repository: { getTool(name: string): Promise<ToolLike | null | undefined> } };
  callTool?: (toolName: string, toolArgs: Record<string, unknown>) => Promise<unknown>;
  callToolStreaming?: (toolName: string, toolArgs: Record<string, unknown>) => AsyncGenerator<unknown>;
}

/** Install the swap on `client`: a call to a tool that sends a file goes out with the file's bytes, as the body or as parts of its form. */
export function installFileBodies(client: ClientLike, read: FileBodyRead): void {
  /** The bytes `ref` names, or the refusal the agent reads. */
  const readFile = async (ref: string): Promise<Uint8Array> => {
    try {
      return await read(ref);
    } catch (err) {
      if (err instanceof FileBodyError) throw err;
      // Core's own path refusals are written for the agent and name nothing on disk; any other error may, so it is
      // logged here and the agent gets the plain reason.
      if (err instanceof VersionControlDomainError) throw new FileBodyError(`"${ref}" could not be read as the file to send: ${err.message}`);
      log.warn(`a tool call's file "${ref}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
      throw new FileBodyError(`"${ref}" could not be read as the file to send. Try again, or send another file.`);
    }
  };
  /**
   * The form a call's body object goes out as: a file part carries the file's bytes under its own name and type, a
   * text value goes as written, and any other value as its JSON (what an API that takes a JSON part beside the file
   * expects). A part the call left out (absent or `null`) is left out of the form. A file part that is there holds
   * one path: anything else (a blank string, a list, a number) refuses the call, so a file the call meant to send is
   * never dropped from the form without a word. It works in two passes. Every file part is judged first, so a call
   * with one such part refuses with no file read, whichever part it is. Then every file is read before the form is
   * handed on, so a file that cannot be read refuses the call with nothing sent (files named before it in the call
   * have been read by then).
   */
  const formOf = async (parts: Record<string, unknown>, fileParts: string[]): Promise<FormData> => {
    const given = Object.entries(parts).filter(([, value]) => value !== undefined && value !== null);
    const refs = new Map<string, string>();
    for (const [name, value] of given) {
      if (!fileParts.includes(name)) continue;
      if (typeof value !== 'string' || !value.trim()) {
        throw new FileBodyError(`The form's "${name}" part takes the path of one file to send, and the call gave it none. Give it a path, or leave "${name}" out to send no file.`);
      }
      refs.set(name, value.trim());
    }
    const form = new FormData();
    for (const [name, value] of given) {
      const ref = refs.get(name);
      if (ref === undefined) {
        form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
        continue;
      }
      form.append(name, new Blob([Buffer.from(await readFile(ref))], { type: rawMimeFor(ref) }), fileNameOf(ref));
    }
    return form;
  };
  const withBytes = async (toolName: string, toolArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!toolArgs || typeof toolArgs !== 'object') return toolArgs;
    const plan = fileBodyPlan(await client.config.tool_repository.getTool(toolName).catch(() => null));
    if (!plan) return toolArgs;
    const body = toolArgs[plan.field];
    if (plan.kind === 'form') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return toolArgs;
      return { ...toolArgs, [plan.field]: await formOf(body as Record<string, unknown>, plan.fileParts) };
    }
    if (typeof body !== 'string' || !body.trim()) return toolArgs;
    return { ...toolArgs, [plan.field]: Buffer.from(await readFile(body.trim())) };
  };
  const callTool = client.callTool;
  if (typeof callTool === 'function' && (callTool as unknown as Record<symbol, unknown>)[INSTALLED] !== true) {
    const bound = callTool.bind(client);
    const wrapped = async function fileBodyCallTool(toolName: string, toolArgs: Record<string, unknown>) {
      return bound(toolName, await withBytes(toolName, toolArgs));
    };
    (wrapped as unknown as Record<symbol, unknown>)[INSTALLED] = true;
    client.callTool = wrapped;
  }
  const streaming = client.callToolStreaming;
  if (typeof streaming === 'function' && (streaming as unknown as Record<symbol, unknown>)[INSTALLED] !== true) {
    const bound = streaming.bind(client);
    const wrapped = async function* fileBodyCallToolStreaming(toolName: string, toolArgs: Record<string, unknown>) {
      yield* bound(toolName, await withBytes(toolName, toolArgs));
    };
    (wrapped as unknown as Record<symbol, unknown>)[INSTALLED] = true;
    client.callToolStreaming = wrapped;
  }
}
