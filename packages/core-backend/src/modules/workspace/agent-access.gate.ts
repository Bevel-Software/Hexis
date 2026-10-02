/**
 * Agent access gate — the per-call seam every gated agent tool runs through.
 *
 * It decides nothing of its own. It calls the hooks a DEPLOYMENT registered
 * (`WorkflowHooks`): one before an agent read of a knowledge-base path, one
 * before an agent write. A hook that throws refuses the operation and the
 * caller sees that hook's own message and status. With no hook registered —
 * every core-only deployment — nothing is refused and nothing is recorded, and
 * a call that carries no `sessionId` is an ordinary call.
 *
 * The gate owns exactly two skips, and they are the ones core can decide on
 * its own identity model: the caller is not an agent (a person in the app, a
 * browser JWT), or the caller is the recovery/merge bot. Everything else —
 * which paths matter, whether a session id is required, what the refusal says
 * — belongs to the hook.
 *
 * Lives beside `assertCanRead` in the workspace tools; it does NOT touch
 * `acquireLock` (that gate is protected-branch-only, and this one applies on
 * all branches and to reads).
 */

import type { JsonSchema } from '../tool-registry/tool.contract.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import type { WorkflowHooks } from '../workflow/workflow-hooks.js';

/**
 * What the `sessionId` input says on its own, before any deployment note. The
 * id is the CONVERSATION's id: the in-process agent supplies its thread id
 * automatically (via its per-run internal token), and an external agent mints
 * one with `start_session` and passes it explicitly, because the MCP proxy is
 * a pure passthrough and never injects args. The same id is the one `ask`
 * takes, so a run's reads and its questions share one conversation.
 */
export const SESSION_ID_DESCRIPTION =
  "This conversation's id, so the server can tell one run's calls apart. External agents (direct MCP calls and `call_tool_chain` alike): call the `start_session` tool ONCE at the very start of your work to obtain it, then pass that id here — the same id `ask` takes. The in-process agent runtime supplies this automatically (do not set it yourself).";

/**
 * The `sessionId` input every gated tool declares. The description a MOUNTED
 * tool ends up advertising is {@link ToolDescriptionNotes.sessionIdDescription},
 * which appends whatever note the deployment registered; this constant is the
 * unadorned default the notes are applied on top of.
 */
export const SESSION_ID_INPUT: JsonSchema = {
  type: 'string',
  description: SESSION_ID_DESCRIPTION,
};

/**
 * The registration point for the wording a DEPLOYMENT wants agents to read
 * about the gated tools — the counterpart of the hooks, which carry its rule.
 * A deployment that refuses some calls can say so here; core registers
 * nothing, so a core-only deployment advertises the plain descriptions.
 *
 * Registration may land AFTER the tools are mounted (an overlay registers from
 * the tool-surface hook), so mounted tools subscribe with {@link onChange} and
 * rewrite their own description and `sessionId` input when a note arrives.
 */
export class ToolDescriptionNotes {
  private gatedTool = '';
  private sessionId = '';
  private readonly listeners = new Set<() => void>();

  /** Append `note` to the description of every gated tool. */
  registerGatedToolNote(note: string): void {
    this.gatedTool = note;
    this.announce();
  }

  /** Append `note` to the description of the `sessionId` input. */
  registerSessionIdNote(note: string): void {
    this.sessionId = note;
    this.announce();
  }

  /** The registered gated-tool note, `''` when none is registered. */
  gatedToolNote(): string {
    return this.gatedTool;
  }

  /** The `sessionId` input's description, with any registered note appended. */
  sessionIdDescription(): string {
    return SESSION_ID_DESCRIPTION + this.sessionId;
  }

  /** Re-run `listener` whenever a note is registered (mounted tools re-describe). */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The per-deployment configuration the gate needs, built once in the composition root. */
export interface AgentAccessGate {
  /** Lowercased email of the recovery/merge bot, which never reaches the hooks. */
  recoveryBotEmail: string;
  /**
   * The workflow lifecycle-hook registry holding the BLOCKING `agentRead` and
   * `preWrite` hooks. Core registers none; a deployment registers against
   * `workflowService.hooks` — pass that same instance here.
   */
  hooks: WorkflowHooks;
  /** The notes a deployment adds to what agents read about these tools. */
  notes: ToolDescriptionNotes;
}

/** Only agent callers are gated; `session` (browser JWT) and humans are not. */
function agentSourceOf(ctx: ToolContext): 'internal' | 'external' | null {
  return ctx.source === 'internal' || ctx.source === 'external' ? ctx.source : null;
}

/**
 * The hook context for this call, or `null` when the call never reaches a hook:
 * the caller is a person rather than an agent, or is the recovery/merge bot,
 * which legitimately spans everything.
 */
function operationContext(
  gate: AgentAccessGate,
  ctx: ToolContext,
  branch: string,
  wsPath?: string,
): { sessionId?: string; wsPath?: string; branch: string; user: ToolContext['user']; source: 'internal' | 'external' } | null {
  const source = agentSourceOf(ctx);
  if (source === null) return null;
  if (ctx.user.email.toLowerCase() === gate.recoveryBotEmail) return null;
  return { sessionId: ctx.sessionId, wsPath, branch, user: ctx.user, source };
}

/**
 * Tell the registered read hooks about an agent read of `wsPath`. A hook that
 * throws refuses the read with its own message and status; with none
 * registered this is a no-op.
 */
export async function notifyAgentRead(
  gate: AgentAccessGate,
  ctx: ToolContext,
  branch: string,
  wsPath: string,
): Promise<void> {
  const op = operationContext(gate, ctx, branch, wsPath);
  if (op === null) return;
  await gate.hooks.runAgentRead(op);
}

/**
 * Ask the registered write hooks whether an agent write may proceed. A hook
 * that throws refuses it with its own message and status; with none registered
 * this is a no-op.
 *
 * `wsPath` is omitted by the one write-capable tool with no resolvable target,
 * `execute_command` — the hook then decides at the coarser session level.
 */
export async function assertAgentWriteAllowed(
  gate: AgentAccessGate,
  ctx: ToolContext,
  branch: string,
  wsPath?: string,
): Promise<void> {
  const op = operationContext(gate, ctx, branch, wsPath);
  if (op === null) return;
  await gate.hooks.runPreWrite(op);
}
