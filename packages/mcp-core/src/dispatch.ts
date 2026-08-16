import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { CallTemplate } from '@utcp/sdk';
import type { ProxiedTool } from './proxied-tool.js';
import { toCallToolResult, toolError, describeToolFailure, renderProgress } from './results.js';

/**
 * Register one manual on a client, reduced to a verdict.
 *
 * Deliberately NOT a loop over every manual: the two surfaces disagree about
 * what a failure means. The hosted proxy memoizes per (user, manual) so a
 * broken credential doesn't re-dial its provider on every session rebuild; the
 * local server has one user and one process and just logs. Sharing the
 * per-manual mechanics without sharing the retry policy keeps both honest.
 *
 * Never throws: a registration failure is a runtime problem (network, dead
 * credential), not a schema one — the templates were validated before they got
 * here — so it comes back as `{ ok: false }` for the caller to police.
 */
export async function registerManual(
  client: CodeModeUtcpClient,
  manual: CallTemplate,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await client.registerManual(manual);
    if (result && result.success === false) {
      const errors = Array.isArray(result.errors) ? result.errors.join('; ') : 'unknown error';
      return { ok: false, error: errors };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run one tool call through `callToolStreaming` with a one-chunk lookahead:
 * every chunk except the last becomes a progress notification, the last is the
 * result.
 *
 * Dispatch always uses `callToolStreaming`, which is uniform across tool kinds:
 * a plain `http` tool yields exactly one chunk (its final result, emitted as
 * the tool result with no progress), while a `streamable_http` tool yields many.
 * Because of that, adding — or later upgrading a tool to streaming — never
 * touches this function.
 *
 * Continuity is the caller's: a tool that supports it (e.g. `ask`) returns its
 * `sessionId` in the result verbatim, and the caller echoes it back per the
 * tool's own schema — nothing here rewrites args. Args pass through to UTCP
 * verbatim; each communication protocol does its own serialization (http reads
 * the template's `body_field` out of the args, mcp forwards them untouched as
 * MCP `arguments`), and the advertised schema is the tool's UTCP `inputs`
 * verbatim too, so any reshaping here would be wrong for at least one protocol.
 */
export async function dispatchToolCall(
  client: CodeModeUtcpClient,
  tool: ProxiedTool,
  args: Record<string, unknown>,
  onProgress?: (progress: number, message: string) => Promise<void>,
): Promise<CallToolResult> {
  let prev: unknown;
  let hasPrev = false;
  let progress = 0;

  try {
    for await (const chunk of client.callToolStreaming(tool.utcpName, args)) {
      if (hasPrev && onProgress) {
        progress += 1;
        await onProgress(progress, renderProgress(prev)).catch((err) =>
          console.warn('[mcp] progress notification failed:', err),
        );
      }
      prev = chunk;
      hasPrev = true;
    }
  } catch (err) {
    return toolError(`The "${tool.mcpName}" tool failed: ${describeToolFailure(err)}`);
  }

  // A stream that closes without ever yielding is a transport fault, not an
  // empty result — every tool kind yields at least its final value (see above).
  // Say so, instead of serializing the never-assigned `prev` into a "null".
  if (!hasPrev) {
    return toolError(`The "${tool.mcpName}" tool produced no output: its stream ended without a result.`);
  }

  return toCallToolResult(prev);
}
