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
 * The retired-tool message for the first retired tool a code-mode chain
 * references, or undefined. Only consulted once a chain has FAILED, so a chain
 * that merely mentions the name in a string and succeeds is never rewritten.
 */
export function retiredToolInCode(code: string): string | undefined {
  for (const [retired, message] of Object.entries(RETIRED_TOOL_MESSAGES)) {
    if (new RegExp(`\\b${retired}\\b`).test(code)) return message;
  }
  return undefined;
}
