import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { ARGUMENTS_DO_NOT_MATCH_KIND, argumentsDoNotMatchMessage, checkFor } from './tool-interface.js';
import { NOT_JSON_KIND, pageInsteadOfJson } from './results.js';
import { isPlatformHostedUrl } from './utcp-namespace.js';

/**
 * The guards the tool client puts in front of a call to a tool THIS SERVER DOES
 * NOT HOST: its arguments are checked against the tool's own input schema before
 * anything leaves, and an answer that is a web page where JSON was expected is
 * cut to something an agent can read.
 *
 * The check lives where the tool lives. A tool the platform (or a deployment)
 * hosts as a route of its own is checked IN THAT ROUTE's handler, so every
 * caller gets the same answer — an agent over MCP, a chain, and a script
 * calling `POST /api/agent/tools/<name>` with a connection key alike. What is
 * left for the client are the tools with no route here: a connected server's
 * tools, and an http tool that calls another service directly. Those are
 * checked here, before the call leaves, and route-hosted tools are skipped so
 * they are not checked twice and so the route's own answer is what comes back.
 *
 * Installed on the UTCP client, which is the one place both of ITS call paths
 * meet: `callToolStreaming` is the MCP dispatch path and `callTool` is what
 * `call_tool_chain` bridges every in-isolate tool function to.
 *
 * Nothing here changes a call. A call that matches its schema is passed on with
 * exactly the arguments that were given — no argument is added, removed,
 * renamed or coerced — because a checker that repaired calls would hide the
 * mistake it was built to report, and would be wrong for at least one protocol.
 */

/** Marks the client's call methods as already wrapped by THESE guards. */
const GUARDED = Symbol.for('bevel.mcp-core.callGuards');

/** Tools whose schema could not be used for checking, so the reason is logged once each. */
const unchecked = new Set<string>();

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

/**
 * Where this server mounts the tools it hosts itself: one route per tool, under
 * one prefix, which is what `toolDef` builds every platform (and deployment)
 * tool's URL from.
 */
const AGENT_TOOL_ROUTE_PREFIX = '/api/agent/tools/';

/** The length of the `${API_URL}` origin template, so the path can be read past it. */
const PLATFORM_ORIGIN_TEMPLATE_LENGTH = '${API_URL}'.length;

interface RepositoryTool {
  name: string;
  description?: string;
  inputs?: unknown;
  outputs?: unknown;
  tool_call_template?: { call_template_type?: unknown; url?: unknown };
}

/**
 * Is this tool a route THIS server hosts? Such a tool is checked by its own
 * route handler — which sees the flat arguments the handler really takes and
 * answers every caller, not only the ones that came through a client — so the
 * client must leave it alone: checking it here would check it twice, and the
 * first refusal would replace the route's answer with one of our own.
 *
 * Decided on two things together: `${API_URL}` as the template's ORIGIN, which
 * expands to this server's own loopback and which a tool definition cannot fake
 * (a third-party `.tool` can put that literal in a path or a query but cannot
 * make it the authority without pointing the request back at us — the same rule
 * as the credential seeding in `utcp-namespace.ts`), AND the agent-tool route
 * prefix every such tool is served under. Both are needed: a `.tool` an
 * administrator wrote may legitimately point at some OTHER endpoint of this
 * same backend, and that one has no tool handler to check it, so the client
 * must.
 */
function isHostedAsARouteHere(tool: RepositoryTool): boolean {
  const template = tool.tool_call_template;
  if (!template) return false;
  const type = typeof template.call_template_type === 'string' ? template.call_template_type : '';
  if (!HTTP_PROTOCOLS.has(type)) return false;
  const url = template.url;
  if (typeof url !== 'string' || !isPlatformHostedUrl(url)) return false;
  return url.slice(PLATFORM_ORIGIN_TEMPLATE_LENGTH).startsWith(AGENT_TOOL_ROUTE_PREFIX);
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
  // Hosted here as a route: its handler does the checking, and its answer is
  // what the caller must get (see `isHostedAsARouteHere`).
  if (isHostedAsARouteHere(tool)) return null;
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
  // Each call method is guarded on its own: a client with only one of them
  // can still call tools through it, and that one path is checked all the
  // same. A client with neither cannot call a tool, so there is nothing to
  // guard. (A test double that only registers manuals is exactly that.)
  const hasCallTool = typeof client.callTool === 'function';
  const hasStreaming = typeof client.callToolStreaming === 'function';
  if (!hasCallTool && !hasStreaming) return;

  const repositoryTool = async (toolName: string): Promise<RepositoryTool | undefined> =>
    (await client.config.tool_repository.getTool(toolName)) as RepositoryTool | undefined;

  const guardResult = async (toolName: string, value: unknown): Promise<void> => {
    if (typeof value !== 'string') return;
    const short = pageInsteadOfJson(value);
    if (!short) return;
    const tool = await repositoryTool(toolName);
    const type = tool?.tool_call_template?.call_template_type;
    if (!HTTP_PROTOCOLS.has(typeof type === 'string' ? type : '')) return;
    // A tool that DECLARES a string answer may answer with markup: by the
    // time the value is here the transport has decoded it, and a JSON string
    // that holds a page looks exactly like a page. Only a tool that promised
    // structured data is held to it.
    if (declaresStringOutput(tool?.outputs)) return;
    const bare = toolName.includes('.') ? toolName.slice(toolName.lastIndexOf('.') + 1) : toolName;
    throw new NotJsonError(`The "${bare}" tool answered with a page, not JSON: ${short}`);
  };

  if (hasCallTool && (client.callTool as unknown as Record<symbol, unknown>)[GUARDED] !== true) {
    const callTool = client.callTool.bind(client);
    const guarded = async function guardedCallTool(toolName: string, toolArgs: Record<string, unknown>) {
      const refusal = await argumentRefusal(client, toolName, toolArgs);
      if (refusal) throw new ArgumentsDoNotMatchError(refusal);
      const result = await callTool(toolName, toolArgs);
      await guardResult(toolName, result);
      return result;
    };
    (guarded as unknown as Record<symbol, unknown>)[GUARDED] = true;
    client.callTool = guarded as typeof client.callTool;
  }

  if (hasStreaming && (client.callToolStreaming as unknown as Record<symbol, unknown>)[GUARDED] !== true) {
    const callToolStreaming = client.callToolStreaming.bind(client);
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
}

/** Does this output schema say the tool answers with a string? */
function declaresStringOutput(outputs: unknown): boolean {
  if (typeof outputs !== 'object' || outputs === null) return false;
  const type = (outputs as { type?: unknown }).type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}
