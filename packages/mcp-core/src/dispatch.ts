import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { CallTemplate } from '@utcp/sdk';
import type { ProxiedTool } from './proxied-tool.js';
import { toCallToolResult, toolError, describeToolFailure, renderProgress } from './results.js';
import { installCallGuards } from './call-guards.js';
import { installGetHasNoBody } from './get-has-no-body.js';
import {
  callRedactor,
  installSubstitutionCapture,
  recordingSubstitutions,
  rememberManualSecrets,
  valuesReadOnEveryCall,
} from './call-secrets.js';
import { utcpManualName } from './utcp-namespace.js';
import { DownstreamToolError } from './downstream-tool-errors.js';
import { removeExcludedTools } from './excluded-tools.js';

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
  // A tool must be registered before it can be called, so registration is the
  // one point every tool of every surface passes through — and therefore where
  // the client's guards are installed. A deployment that registers manuals of
  // its own gets the argument check and the GET-sends-no-body rule for its
  // tools without writing a line for either. Both are idempotent.
  //
  // The client checks the tools with no route HERE — a connected server's, and
  // an http tool that calls another service. A tool this server hosts as a
  // route is checked in that route's own handler instead, so every caller gets
  // the same answer and the route's answer is what comes back
  // (`call-guards.ts`).
  installGetHasNoBody();
  installCallGuards(client);
  // The values this registration fills into the manual are what its calls
  // carry, so they are kept for the manual (`call-secrets.ts`): a downstream
  // error quoted back is redacted against them.
  installSubstitutionCapture(client);
  const manualName = utcpManualName(String(manual.name ?? ''));
  const resolved = new Map<string, Set<string>>();
  // A failure is the server's or the transport's words, which can quote what
  // the registration sent: redacted before anyone logs or shows it.
  const failed = (error: string) => ({ ok: false as const, error: callRedactor(resolved, manual, false).redact(error) });
  try {
    const result = await recordingSubstitutions(resolved, () => client.registerManual(manual));
    if (result && result.success === false) {
      return failed(Array.isArray(result.errors) ? result.errors.join('; ') : 'unknown error');
    }
    rememberManualSecrets(client, manualName, resolved);
    // The same one point is where the tools a manual leaves out
    // (`excludeTools`) come off the client: a session recovery or a catalog
    // refresh registers through here too, so none of them can bring one back.
    await removeExcludedTools(client, manual);
    const toolNames = (result?.manual?.tools ?? []).map((tool) => tool.name);
    const readAgain = await valuesReadOnEveryCall(client, manualName, toolNames, resolved);
    if (readAgain.length > 0) {
      await client.deregisterManual(manualName);
      // Our own words, naming variables only: nothing in them to redact.
      return {
        ok: false,
        error: `The value of ${readAgain.map((name) => `\${${name}}`).join(', ')} contains \`$\` followed by a name, which every call would read as another variable, so this server cannot be called with that value.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
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
  /** See {@link toCallToolResult}'s `structured`. */
  options?: { structured?: boolean },
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
    // The downstream server answered and said the call failed: pass its own
    // answer on, marked as the failure it is.
    if (err instanceof DownstreamToolError) return err.toCallToolResult();
    return toolError(`The "${tool.mcpName}" tool failed: ${describeToolFailure(err)}`);
  }

  // A stream that closes without ever yielding is a transport fault, not an
  // empty result — every tool kind yields at least its final value (see above).
  // Say so, instead of serializing the never-assigned `prev` into a "null".
  if (!hasPrev) {
    return toolError(`The "${tool.mcpName}" tool produced no output: its stream ended without a result.`);
  }

  return toCallToolResult(prev, options);
}
