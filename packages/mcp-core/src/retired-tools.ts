/**
 * Agent tools that were removed on purpose, and what a caller still using the
 * old name is told instead of a bare "Unknown tool".
 *
 * An agent proposes and syncs; a person merges. `merge_change_request` let an
 * agent land a change request itself, so it is gone from every agent-facing
 * tool set — but models (and saved scripts) keep calling a name they learned,
 * and "Unknown tool" invites them to go looking for another way in. The answer
 * says who does it and where.
 *
 * One table, read by every surface that resolves a tool name: the hosted MCP
 * endpoint, the local `hexis-mcp` server, the code-mode `call_tool_chain`
 * runners, and the backend's own route for the old name.
 */
export const RETIRED_TOOL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  merge_change_request:
    '`merge_change_request` is no longer available to agents: a change request is merged by a person in the app. ' +
    'Ask the user to review and merge it there. To bring a draft up to date with its target, use `merge_branch` ' +
    'with the target as `source` and the draft as `target`.',
});

/**
 * The retired tool names themselves. A surface that PROXIES another
 * deployment needs these: an older deployment still advertises the tool, and a
 * discovered copy left in the registry is callable — directly and from a
 * code-mode chain — which would perform the very merge the removal forbids.
 * Purge by name, then answer the name from {@link retiredToolMessage}.
 */
export const RETIRED_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(RETIRED_TOOL_MESSAGES));

/**
 * The retired-tool message for `name`, or undefined when it is not retired.
 * Matches the bare name and any namespaced spelling of it (`manual.tool`,
 * `manual_tool` flattening aside — `manual__tool`, `a.b.tool`), since each
 * surface advertises tool names in its own shape.
 */
export function retiredToolMessage(name: string): string | undefined {
  for (const [retired, message] of Object.entries(RETIRED_TOOL_MESSAGES)) {
    if (name === retired || name.endsWith(`.${retired}`) || name.endsWith(`__${retired}`)) return message;
  }
  return undefined;
}

/**
 * The retired-tool message when `failure` — the text of a FAILED chain's
 * error, not its source — names a retired tool, or undefined.
 *
 * The failure text is the signal, deliberately. Scanning the chain's source
 * instead would rewrite any failure from a chain that merely MENTIONS the name
 * in a comment, a string or an unrelated call, hiding the real reason it died
 * behind a migration notice. The runtime names the callee it could not find
 * ("KNOWLEDGE_BASE.merge_change_request is not a function"), so the tool that
 * actually failed is right there in the message.
 *
 * Matched in the shape the runtime reports a missing callee — `<expr>.<name>
 * is not a function`, `<name> is not defined` — and not anywhere in the text:
 * a failure that merely QUOTES the name (a missing file whose path carries
 * it, a server's error echoing the request) died of something else, and the
 * migration notice would hide that.
 *
 * A chain that reaches the retired name through a computed property
 * (`KNOWLEDGE_BASE['merge_' + 'change_request']()`) is not recognised: the
 * runtime prints the expression, not the resolved name. It still fails — the
 * tool is gone from every registry — it just fails with the runtime's own
 * words instead of ours.
 */
export function retiredToolInFailure(failure: string): string | undefined {
  for (const [retired, message] of Object.entries(RETIRED_TOOL_MESSAGES)) {
    // The name as an identifier or a member (`X.name`), not as quoted text:
    // a server that echoes the sentence back inside quotes is a different
    // failure, and the quote mark before the name is what tells them apart.
    if (new RegExp(`(?:^|[\\s.])${retired} is not (?:a function|defined)\\b`).test(failure)) return message;
  }
  return undefined;
}

/** The log line `@utcp/code-mode` records when a chain's code fails. */
const CHAIN_FAILURE_LOG = '[ERROR] Code execution failed';

/**
 * The retired-tool message for a chain that FAILED on a retired tool, read
 * from what `callToolChain` returned. The runner does not throw when the code
 * fails — it resolves `{ result: null, logs }` with a `[ERROR] Code execution
 * failed: …` line (e.g. `KNOWLEDGE_BASE.merge_change_request is not a
 * function`) — so a caller's catch never sees it. Undefined for a chain that
 * succeeded, or one whose failure does not name a retired tool.
 */
export function retiredToolChainFailure(outcome: { result: unknown; logs?: unknown }): string | undefined {
  if (outcome.result !== null && outcome.result !== undefined) return undefined;
  const logs = Array.isArray(outcome.logs) ? outcome.logs : [];
  const failures = logs.filter((l): l is string => typeof l === 'string' && l.startsWith(CHAIN_FAILURE_LOG));
  for (const failure of failures) {
    const message = retiredToolInFailure(failure);
    if (message) return message;
  }
  return undefined;
}
