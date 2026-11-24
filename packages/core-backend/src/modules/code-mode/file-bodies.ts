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
 * Installed on a code-mode client before its manuals are registered, so the
 * call guards registration installs sit over it: they check the arguments as
 * the agent gave them (a string where the schema says string) before the swap.
 * The MCP endpoint installs it on every caller's client; a distribution's own
 * in-process agent installs it on its client the same way. Nothing else about
 * the call changes: a tool without the declaration, or a call with no path in
 * that field, passes through untouched.
 */
import type { IAccessControl } from '../access/index.js';
import { canReadWorkspacePath } from '../access-model/index.js';
import { isTmpRef, normalizeWorkspacePath } from '../kb-fs/index.js';
import type { WorkspaceService } from '../workspace/index.js';
import { PathNotFoundError, VersionControlDomainError } from '../../shared/domain-errors.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { logger } from '../../shared/logging.js';

const log = logger('code-mode');

/** The JSON-schema `format` a body property carries to say "a file's path, sent as its bytes". */
export const FILE_PATH_FORMAT = 'file-path';

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

/** The input field `tool` sends as a file's bytes, or null when it sends no file: an http tool whose body property is declared `format: file-path`. */
export function fileBodyField(tool: ToolLike | null | undefined): string | null {
  const template = tool?.tool_call_template as { call_template_type?: unknown; body_field?: unknown } | undefined;
  if (!template || template.call_template_type !== 'http') return null;
  const field = typeof template.body_field === 'string' && template.body_field ? template.body_field : 'body';
  const properties = (tool?.inputs as { properties?: Record<string, unknown> } | undefined)?.properties;
  const property = properties?.[field] as { format?: unknown } | undefined;
  return property && typeof property === 'object' && property.format === FILE_PATH_FORMAT ? field : null;
}

interface ClientLike {
  config: { tool_repository: { getTool(name: string): Promise<ToolLike | null | undefined> } };
  callTool?: (toolName: string, toolArgs: Record<string, unknown>) => Promise<unknown>;
  callToolStreaming?: (toolName: string, toolArgs: Record<string, unknown>) => AsyncGenerator<unknown>;
}

/** Install the swap on `client`: a call to a tool with a file body goes out with the file's bytes in that field. */
export function installFileBodies(client: ClientLike, read: FileBodyRead): void {
  const withBytes = async (toolName: string, toolArgs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!toolArgs || typeof toolArgs !== 'object') return toolArgs;
    const field = fileBodyField(await client.config.tool_repository.getTool(toolName).catch(() => null));
    if (!field) return toolArgs;
    const ref = toolArgs[field];
    if (typeof ref !== 'string' || !ref.trim()) return toolArgs;
    let bytes: Uint8Array;
    try {
      bytes = await read(ref.trim());
    } catch (err) {
      if (err instanceof FileBodyError) throw err;
      // Core's own path refusals are written for the agent and name nothing on disk; any other error may, so it is
      // logged here and the agent gets the plain reason.
      if (err instanceof VersionControlDomainError) throw new FileBodyError(`"${ref.trim()}" could not be read as the file to send: ${err.message}`);
      log.warn(`a tool call's file "${ref.trim()}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
      throw new FileBodyError(`"${ref.trim()}" could not be read as the file to send. Try again, or send another file.`);
    }
    return { ...toolArgs, [field]: Buffer.from(bytes) };
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
