import type { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  ARGUMENTS_DO_NOT_MATCH_KIND,
  argumentsDoNotMatchMessage,
  compileCheck,
  type CompiledCheck,
} from './tool-interface.js';
import { NOT_JSON_KIND, pageInsteadOfJson } from './results.js';

/**
 * The guards every tool call passes through, wherever it came from: the
 * arguments are checked against the tool's own input schema before anything is
 * sent or run, and an answer that is a web page where JSON was expected is cut
 * to something an agent can read.
 *
 * Installed on the UTCP client, which is the ONE place both call paths meet:
 * `callToolStreaming` is the MCP dispatch path and `callTool` is what
 * `call_tool_chain` bridges every in-isolate tool function to. A check in
 * either surface's own dispatcher would cover one of them and not the other.
 *
 * Nothing here changes a call. A call that matches its schema is passed on with
 * exactly the arguments that were given — no argument is added, removed,
 * renamed or coerced — because a checker that repaired calls would hide the
 * mistake it was built to report, and would be wrong for at least one protocol.
 */

/** Marks the client's call methods as already wrapped by THESE guards. */
const GUARDED = Symbol.for('bevel.mcp-core.callGuards');

/**
 * One compiled check per distinct input schema, kept for as long as the schema
 * object lives. The repository hands out shallow copies of a tool whose
 * `inputs` object is the stored one, so the same schema is the same key across
 * every call and every lookup — the check is compiled once per tool, not once
 * per call, and the guard adds a walk of the arguments and nothing else.
 */
const compiled = new WeakMap<object, CompiledCheck>();

/** Tools whose schema could not be used for checking, so the reason is logged once each. */
const unchecked = new Set<string>();

/**
 * The compiled check for one input schema, compiled at most once.
 *
 * Exported so the cache can be pinned by identity: the check a call pays for
 * is a walk of its arguments, never a re-compilation of the schema.
 */
export function checkFor(inputs: unknown): CompiledCheck {
  if (typeof inputs !== 'object' || inputs === null) return compileCheck(inputs);
  const hit = compiled.get(inputs);
  if (hit) return hit;
  const built = compileCheck(inputs);
  compiled.set(inputs, built);
  return built;
}

/**
 * The refusal a call that does not match its tool gets: a 400 carrying
 * `arguments-do-not-match`, the mismatches, the tool's interface and the call
 * example.
 *
 * Shaped like the typed refusals the platform's REST tools return, so it
 * reaches an agent the same way they do: `response.data` is what
 * `describeToolFailure` reads, and the enumerable `status` / `data` are what a
 * chain sees on the thrown error.
 */
export class ArgumentsDoNotMatchError extends Error {
  readonly status = 400;
  readonly kind = ARGUMENTS_DO_NOT_MATCH_KIND;
  readonly data: { error: string; kind: string; status: number };
  readonly response: { status: number; data: { error: string; kind: string; status: number } };

  constructor(message: string) {
    super(message);
    this.name = 'ArgumentsDoNotMatchError';
    this.data = { error: message, kind: ARGUMENTS_DO_NOT_MATCH_KIND, status: 400 };
    this.response = { status: 400, data: this.data };
  }
}

/** The error a tool's non-JSON answer becomes: short, with the page left behind. */
class NotJsonError extends Error {
  readonly kind = NOT_JSON_KIND;
  readonly data: { error: string; kind: string };
  readonly response: { data: { error: string; kind: string } };

  constructor(message: string) {
    super(message);
    this.name = 'NotJsonError';
    this.data = { error: message, kind: NOT_JSON_KIND };
    this.response = { data: this.data };
  }
}

/** The protocols whose answer is an HTTP response, and so can be a web page. */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http', 'streamable_http', 'sse']);

interface RepositoryTool {
  name: string;
  description?: string;
  inputs?: unknown;
  tool_call_template?: { call_template_type?: unknown };
}

/**
 * Check `args` against the tool registered as `toolName`, returning the
 * refusal message when they do not match and `null` when they do (or when the
 * tool's schema cannot be used for checking, which is logged once).
 *
 * Exported for the surfaces' tests; the guards below are the only caller in
 * production.
 */
export async function argumentRefusal(
  client: CodeModeUtcpClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const tool = (await client.config.tool_repository.getTool(toolName)) as RepositoryTool | undefined;
  // Not registered: the client's own "not found in the repository" is the
  // honest answer, and inventing a mismatch for a tool that does not exist
  // would bury it.
  if (!tool) return null;
  const check = checkFor(tool.inputs);
  if (!check.checkable) {
    // Once per tool, not once per call: a tool with an unusable schema is
    // called on every turn, and the reason is a property of the schema.
    if (!unchecked.has(toolName)) {
      unchecked.add(toolName);
      console.warn(
        `[mcp] calling "${toolName}" without checking its arguments — ${check.reason}. ` +
          'Its calls are passed through as they are.',
      );
    }
    return null;
  }
  const mismatches = check.check(args ?? {});
  if (mismatches.length === 0) return null;
  // The name the agent used is the bare tool name, not the `<manual>.<tool>`
  // the registry keys on — but the call example has to show the namespace, so
  // both go in: the sentence names the tool, the example names the call.
  const bare = toolName.includes('.') ? toolName.slice(toolName.lastIndexOf('.') + 1) : toolName;
  return argumentsDoNotMatchMessage(bare, toolName, tool.inputs, mismatches);
}

/**
 * Install the guards on `client`. Idempotent per client, and ORDER-PROOF: when
 * another layer (the downstream router, session recovery, the audit
 * instrumentation) has re-wrapped the call methods since, the guards are
 * wrapped around that one too, so they stay outermost and a routed call cannot
 * slip past them. Checking twice is free — the check is pure and compiled once.
 */
export function installCallGuards(client: CodeModeUtcpClient): void {
  // A client with no call methods cannot call a tool, so there is nothing to
  // guard. (A test double that only registers manuals is exactly that.)
  if (typeof client.callTool !== 'function' || typeof client.callToolStreaming !== 'function') return;
  if ((client.callTool as unknown as Record<symbol, unknown>)[GUARDED] === true) return;

  const callTool = client.callTool.bind(client);
  const callToolStreaming = client.callToolStreaming.bind(client);

  const protocolOf = async (toolName: string): Promise<string | undefined> => {
    const tool = (await client.config.tool_repository.getTool(toolName)) as RepositoryTool | undefined;
    const type = tool?.tool_call_template?.call_template_type;
    return typeof type === 'string' ? type : undefined;
  };

  const guardResult = async (toolName: string, value: unknown): Promise<void> => {
    if (typeof value !== 'string') return;
    const short = pageInsteadOfJson(value);
    if (!short) return;
    if (!HTTP_PROTOCOLS.has((await protocolOf(toolName)) ?? '')) return;
    const bare = toolName.includes('.') ? toolName.slice(toolName.lastIndexOf('.') + 1) : toolName;
    throw new NotJsonError(`The "${bare}" tool answered with a page, not JSON: ${short}`);
  };

  const guarded = async function guardedCallTool(toolName: string, toolArgs: Record<string, unknown>) {
    const refusal = await argumentRefusal(client, toolName, toolArgs);
    if (refusal) throw new ArgumentsDoNotMatchError(refusal);
    const result = await callTool(toolName, toolArgs);
    await guardResult(toolName, result);
    return result;
  };
  (guarded as unknown as Record<symbol, unknown>)[GUARDED] = true;
  client.callTool = guarded as typeof client.callTool;

  const guardedStreaming = async function* guardedCallToolStreaming(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): AsyncGenerator<unknown, void, unknown> {
    const refusal = await argumentRefusal(client, toolName, toolArgs);
    if (refusal) throw new ArgumentsDoNotMatchError(refusal);
    for await (const chunk of callToolStreaming(toolName, toolArgs)) {
      await guardResult(toolName, chunk);
      yield chunk;
    }
  };
  (guardedStreaming as unknown as Record<symbol, unknown>)[GUARDED] = true;
  client.callToolStreaming = guardedStreaming as typeof client.callToolStreaming;
}
