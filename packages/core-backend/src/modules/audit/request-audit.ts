import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { logger } from '../../shared/logging.js';
import type { AgentEventOutcome, AuditPrincipalRef, IAgentEventRecorder } from './audit.contract.js';
import {
  classifyToolCall,
  skillReadPath,
  type ClassifiedCall,
  type ClassifierContext,
  type SkillFolder,
} from './event-classifier.js';

const log = logger('audit');

/**
 * The Audit log's view of ONE MCP request: who is calling (the user and the
 * key or agent connection the request arrived through), and how to name what
 * they call. The MCP proxy creates one per request that has a principal and
 * routes every call through it; a request with none (a browser JWT, an
 * internal token minted before connections existed) gets no instance and
 * records nothing.
 *
 * Holds nothing that outlives the request. The skill catalog it may need to
 * tell a skill read from a file read is fetched at most once, and only when
 * a platform read names a path.
 */
export class RequestAudit {
  private skills: Promise<readonly SkillFolder[] | null> | undefined;

  constructor(
    private readonly recorder: IAgentEventRecorder,
    private readonly userId: string,
    private readonly principal: AuditPrincipalRef,
    private readonly ctx: {
      kbManualName: string;
      /** Read at classification time — the surface (and its catalog names) is built lazily. */
      catalogNames: () => ReadonlyMap<string, string>;
      /** The caller's skill catalog, for telling a skill read from a file read. */
      loadSkills: () => Promise<readonly SkillFolder[]>;
    },
  ) {}

  /** Record one already-classified call. Never throws. */
  emit(call: ClassifiedCall, outcome: AgentEventOutcome, durationMs: number | null): void {
    try {
      this.recorder.record({
        userId: this.userId,
        principal: this.principal,
        kind: call.kind,
        manual: call.manual,
        name: call.name,
        outcome,
        durationMs,
      });
    } catch (err) {
      log.warn('recording an agent event failed:', { err });
    }
  }

  /** What a UTCP call is logged as — fetching the skill catalog first when the call might be a skill read. */
  async classify(utcpName: string, args: Record<string, unknown>): Promise<ClassifiedCall> {
    const ctx: ClassifierContext = { kbManualName: this.ctx.kbManualName, catalogNames: this.ctx.catalogNames() };
    const wantsSkills = skillReadPath(utcpName, args, ctx.kbManualName) !== null;
    const skills = wantsSkills ? await this.skillCatalog() : null;
    return classifyToolCall(utcpName, args, ctx, skills);
  }

  /**
   * Run a UTCP call and record it: `error` when it throws or `isError` says
   * the result is one, `ok` otherwise. The result (or the throw) reaches the
   * caller unchanged — recording is a side effect, never a filter.
   *
   * The call starts FIRST and is classified alongside: naming a read may cost
   * a loopback fetch of the skill catalog, and that is the log's business,
   * not the tool's — a tool result never waits on its own bookkeeping.
   */
  async call<T>(
    utcpName: string,
    args: Record<string, unknown>,
    run: () => Promise<T>,
    isError: (result: T) => boolean,
  ): Promise<T> {
    const started = performance.now();
    const classified = this.classify(utcpName, args);
    try {
      const result = await run();
      const duration = elapsed(started);
      this.emit(await classified, isError(result) ? 'error' : 'ok', duration);
      return result;
    } catch (err) {
      const duration = elapsed(started);
      this.emit(await classified, 'error', duration);
      throw err;
    }
  }

  /** A call refused before it ran, because the caller's sign-in for its manual is missing. */
  async denied(utcpName: string, args: Record<string, unknown>): Promise<void> {
    this.emit(await this.classify(utcpName, args), 'denied', null);
  }

  /**
   * Record every tool call made from INSIDE `call_tool_chain`: the chain
   * bridges each in-isolate tool function to `client.callTool`, so wrapping
   * that one entry point catches them all. Installed after the downstream
   * routing wrapper so the timing covers the pool lease and any retry too.
   * The direct MCP path (`callToolStreaming`) is deliberately NOT wrapped —
   * the proxy's tool handler records those itself, with the result's
   * `isError` in hand.
   */
  instrumentChainCalls(client: CodeModeUtcpClient): void {
    const callTool = client.callTool.bind(client);
    client.callTool = (toolName: string, toolArgs: Record<string, unknown>) =>
      this.call(toolName, toolArgs, () => callTool(toolName, toolArgs), isErrorShaped);
  }

  private skillCatalog(): Promise<readonly SkillFolder[] | null> {
    // A failed fetch is remembered as "no catalog" for the rest of the
    // request: the read is then logged as a capability, and one hiccup does
    // not cost a loopback round-trip per subsequent call.
    this.skills ??= this.ctx.loadSkills().catch((err) => {
      log.warn('skill catalog unavailable for audit classification:', { err });
      return null;
    });
    return this.skills;
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

/**
 * A chain-internal result that is the tool saying it failed. A downstream
 * MCP server answers a failed call with `{ isError: true, content }` as a
 * VALUE (the UTCP mcp protocol hands it through rather than throwing), and
 * the direct path records that as an error — so must the chain path, or the
 * same failure would read `ok` inside a chain and `error` outside one.
 */
function isErrorShaped(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}
