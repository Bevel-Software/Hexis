/**
 * Ontology-session boundary — the per-call gate used by the agent tool handlers.
 *
 * One decision fn, called by every gated file/graph handler:
 *   READS  (isWrite=false) record the touched ontology and always allow.
 *   WRITES (isWrite=true)  run the registered BLOCKING `preWrite` hooks
 *                          (`WorkflowHooks`), then record. The core registers
 *                          no hook, so core alone only TRACKS; the enterprise
 *                          overlay registers the ontology block (see
 *                          `modules/kb/ontology-block.hook.ts`), restoring
 *                          "allowed only while the session is confined to a
 *                          single ontology; once it has touched ≥2, all
 *                          writes are blocked".
 *
 * Skips entirely when: the flag is off, the path is neutral (`ontologyOf` →
 * null), the caller is not an agent, or the caller is the recovery bot. Fails
 * CLOSED for an agent named-path operation that carries no `sessionId`.
 *
 * Lives beside `assertCanRead` in the workspace tools — it does NOT touch
 * `acquireLock` (that gate is protected-branch-only; this boundary applies on
 * all branches and to reads). See `docs/rp4-ontology-boundary-plan-v2.md`.
 */

import { ontologyOf } from '../../shared/kb-layout.js';
import type { JsonSchema } from '../tool-registry/tool.contract.js';
import { ToolError, type ToolContext } from '../tool-helpers/tool.contract.js';
import type { ISessionOntologyService } from '../workflow/session-ontology.service.js';
import type { WorkflowHooks } from '../workflow/workflow-hooks.js';

/**
 * The `sessionId` input the ontology-session boundary reads: the agent run /
 * conversation id. The in-process agent supplies its thread id automatically
 * (via its per-run internal token); an external agent has no ambient run id,
 * so it must first mint one with the `start_session` tool and then pass it
 * EXPLICITLY on every gated call — the MCP proxy is a pure passthrough and
 * never injects args.
 */
export const SESSION_ID_INPUT: JsonSchema = {
  type: 'string',
  description:
    'The KnowledgeBase session id that scopes this run to one ontology. External agents (direct MCP calls and `call_tool_chain` alike): call the `start_session` tool ONCE at the very start of your work to obtain it, then pass that id here on EVERY gated call. The in-process agent runtime supplies this automatically (do not set it yourself).',
};

/**
 * Boundary warning appended to ontology-gated tool descriptions so the agent
 * knows the restriction before it calls one. Action-then-why phrasing per
 * docs/glossary.md.
 */
export const ONTOLOGY_BOUNDARY_NOTE =
  ' Stay within one KnowledgeBase ontology per conversation: once this run has read or written files in two different ontologies, every later content write (write_file/edit_file/mkdir/unzip, and both endpoints of move_file/copy_file) is blocked with a 403 and no override. Reads and delete_file never block — but each one records the ontology it touched and can poison a later content write, so do broad cross-ontology exploration only when you do not intend to write. Note move_file/copy_file are blocked outright when source and destination are different ontologies, since they would carry content across.';

/** Thrown when a write is refused because the session has crossed ontologies. */
export class OntologyWriteBlockedError extends ToolError {
  constructor(touched: string[], attempted: string, reason: 'multi-ontology' | 'different-ontology') {
    const msg =
      reason === 'multi-ontology'
        ? `This conversation has already read across multiple ontologies (${touched.join(', ')}), so writing is no longer allowed. Start a new conversation to write to "${attempted}".`
        : `This conversation is working in ${touched.join(', ')}, so it can't write to a different ontology ("${attempted}"). Start a new conversation to work in "${attempted}".`;
    super(msg, 403);
    this.name = 'OntologyWriteBlockedError';
  }
}

/** Thrown when an agent op on a named ontology carries no session id (fail closed). */
export class MissingSessionError extends ToolError {
  constructor() {
    super(
      'This operation needs a KnowledgeBase session id and none was provided. Call the `start_session` tool once at the start of your work to obtain a sessionId, then pass it explicitly as `sessionId` on every gated call (direct MCP calls and `call_tool_chain` alike).',
      403,
    );
    this.name = 'MissingSessionError';
  }
}

export interface SessionOntologyGate {
  service: ISessionOntologyService;
  enabled: boolean;
  kbDirName: string;
  /** Lowercased email of the recovery/merge bot, which is exempt. */
  recoveryBotEmail: string;
  /**
   * The workflow lifecycle-hook registry whose BLOCKING `preWrite` hooks
   * decide whether a gated write/shell op proceeds. Core registers none (the
   * gate then only tracks); the enterprise composition root registers the
   * ontology block against `workflowService.hooks` — pass that same instance
   * here.
   */
  hooks: WorkflowHooks;
}

/** Only internal/external agent callers are gated; `session` (browser JWT) and humans are not. */
function isAgentSource(ctx: ToolContext): boolean {
  return ctx.source === 'internal' || ctx.source === 'external';
}

/**
 * Shared gate preamble for the two per-path operations below. Returns `'skip'`
 * when the boundary doesn't apply to this call (flag off, neutral path,
 * non-agent caller, or recovery bot), otherwise the session id to evaluate
 * against — throwing `MissingSessionError` (fail closed) when an agent op on a
 * named ontology carries none.
 */
function resolveGatedSession(gate: SessionOntologyGate, ctx: ToolContext, wsPath: string): string | 'skip' {
  if (!gate.enabled) return 'skip';
  // Neutral paths never pin/record/block — skip before any identity work.
  if (ontologyOf(wsPath, gate.kbDirName) === null) return 'skip';
  // Humans (UI routes) and browser-JWT callers never hit these tools; only
  // agent tool calls are gated.
  if (!isAgentSource(ctx)) return 'skip';
  // The recovery/merge bot legitimately spans ontologies — exempt by identity.
  if (ctx.user.email.toLowerCase() === gate.recoveryBotEmail) return 'skip';
  // Fail closed: an agent operation on a named ontology must carry a session id.
  if (!ctx.sessionId) throw new MissingSessionError();
  return ctx.sessionId;
}

/**
 * Record a read of `wsPath`'s ontology into the session's touched set. Reads are
 * always allowed — recording is the only effect — but each one widens the
 * touched set and so can poison a later write (see {@link assertOntologyWriteAllowed}).
 * Fails closed (`MissingSessionError`) for an agent read of a named ontology
 * with no session id.
 */
export async function recordOntologyRead(gate: SessionOntologyGate, ctx: ToolContext, wsPath: string): Promise<void> {
  const sessionId = resolveGatedSession(gate, ctx, wsPath);
  if (sessionId === 'skip') return;
  // checkOperation(isWrite=false) records the touch and always allows.
  await gate.service.checkOperation(sessionId, wsPath, false, gate.kbDirName);
}

/**
 * Assert a write to `wsPath` is allowed, then record it. A write that would
 * carry information into a second ontology is the thing the boundary blocks:
 * permitted only while the session stays confined to the target ontology, and
 * refused with `OntologyWriteBlockedError` once it has touched ≥2. Note `delete`
 * is NOT a write here — removing a node propagates no cross-ontology
 * information, so it goes through {@link recordOntologyRead}.
 *
 * The BLOCKING decision itself lives behind the `preWrite` hooks: the
 * enterprise-registered ontology block evaluates-and-records atomically via
 * `checkOperation(isWrite=true)` and throws to refuse (identical behavior to
 * the previous in-gate decision). Core registers no hook, so with none the
 * write is allowed and only the touch is recorded (tracking stays core). The
 * follow-up read-record after the hooks is idempotent — a no-op when a hook
 * already recorded the allowed write.
 */
export async function assertOntologyWriteAllowed(
  gate: SessionOntologyGate,
  ctx: ToolContext,
  wsPath: string,
): Promise<void> {
  const sessionId = resolveGatedSession(gate, ctx, wsPath);
  if (sessionId === 'skip') return;
  await gate.hooks.runPreWrite({ kind: 'file-write', sessionId, wsPath });
  // Tracking stays core: record the (now-allowed) write's ontology touch.
  // A blocked write never reaches this line, so it records nothing — same as
  // before the hook split.
  await gate.service.checkOperation(sessionId, wsPath, false, gate.kbDirName);
}

/**
 * Session-level write-eligibility gate for write-capable tools that have no
 * single resolvable target path to check per-call — currently `execute_command`
 * (arbitrary shell). Such a tool cannot be path-confined, so we enforce the
 * boundary at the coarser session level: once the run has crossed into ≥2
 * ontologies (the point at which EVERY path-checked write is already refused),
 * we refuse the tool outright, so shell can't become a write path around the
 * boundary. A fresh or single-ontology session is still allowed; a residual gap
 * remains (a single-ontology session could shell-write a *different* ontology),
 * accepted because arbitrary shell cannot be path-confined and blocking all
 * shell after one KB read would gut its read-style diagnostic use (git/grep/ls).
 *
 * Skips when: the flag is off, the caller is not an agent, the caller is the
 * recovery bot, or there is no session id — there is no named path here to fail
 * closed on, and with no session there is no touched set to evaluate.
 *
 * Like {@link assertOntologyWriteAllowed}, the refusal itself is the
 * enterprise-registered `preWrite` hook's (it evaluates the touched set and
 * throws); core registers none, so shell is never refused in a core-only
 * deployment.
 */
export async function assertShellAllowedWithinOntology(gate: SessionOntologyGate, ctx: ToolContext): Promise<void> {
  if (!gate.enabled) return;
  if (!isAgentSource(ctx)) return;
  if (ctx.user.email.toLowerCase() === gate.recoveryBotEmail) return;
  if (!ctx.sessionId) return;

  await gate.hooks.runPreWrite({ kind: 'shell', sessionId: ctx.sessionId });
}
