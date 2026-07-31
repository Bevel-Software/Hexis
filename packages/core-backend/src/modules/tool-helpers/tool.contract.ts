import type { AuthUser, IWorkflowService } from '@bevel-software/shared';
import type { LocalFilesystem } from '@mastra/core/workspace';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { WorkflowEventBus } from '../workflow/event-bus.js';

/**
 * The hosting/execution contract a module works against when it lets `toolHelpers`
 * host its endpoint (`toolHandler`). It is NOT a registry concern — the registry
 * only cares that a tool is a valid UTCP `Tool`. A provider hosting its own
 * transport (websocket, its own server) never touches any of this.
 *
 * The normalized context every tool handler receives, regardless of whether the
 * caller authenticated with a connection key (external) or an internal token.
 * The route layer resolves it once via `resolveToolContext`; handlers never look
 * at the auth source.
 *
 * `branch` is passed BY THE TOOL — a KB tool declares a required `branch` input
 * the model fills, and hands it to `getFilesystem(branch)`. Internal and external
 * callers are identical: the credential is identity-only, so the workspace always
 * comes from this argument (the per-branch clone, `workspaceIdForBranch(branch)`).
 * A tool that never touches the KB never calls `getFilesystem`, so it never
 * resolves a workspace. Resolution is cached after the first call.
 */
export interface ToolContext {
  user: AuthUser;
  scope: 'read' | 'write';
  // `session` (browser JWT) only ever reaches the read-only manual endpoint, not
  // a tool handler, so in practice a built context is always internal/external —
  // the union just mirrors `ToolAuth.source`.
  source: 'internal' | 'external' | 'session';
  /** Connection-key id (external key callers only) — for daily-token metering. */
  tokenId?: string;
  /**
   * The agent run / conversation id this call belongs to (the agent thread id).
   * Supplied as a `sessionId` field on the tool's input body — the external MCP
   * proxy injects it via the `ask`-tool continuity convention, and the
   * in-process agent passes its thread id. Used to scope the ontology-session
   * boundary to one run. Absent for non-agent or unthreaded calls.
   */
  sessionId?: string;
  abortSignal: AbortSignal;
  workspaceService: WorkspaceService;
  workflowService: IWorkflowService;
  events: WorkflowEventBus;
  /** Build the lock-aware filesystem for `branch`'s workspace (cached). The tool supplies `branch` from its own input. */
  getFilesystem(branch: string): Promise<LocalFilesystem>;
}

/**
 * A tool's implementation: a pure function of `(args, ctx)`. Return a value for
 * a normal JSON tool, or an async-iterable to stream (the `toolHandler` wrapper
 * serializes each chunk as SSE and the last as the result). `args` is the flat
 * request body (the `{body}` envelope is already unwrapped by the route).
 */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<unknown> | AsyncIterable<unknown>;

/**
 * A failure a tool handler can throw to choose its own HTTP status. The route
 * maps any thrown value with a numeric `status` to that code — covering this
 * and `AgentAskService`'s `AgentAskError`.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function hasHttpStatus(err: unknown): err is { status: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599 &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}
