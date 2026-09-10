/**
 * @bevel-software/platform-mcp-core — the transport-agnostic half of Bevel's
 * MCP surface.
 *
 * Two surfaces re-expose the same UTCP tool catalog over MCP and differ only in
 * where they run and how they reach it:
 *
 *   - the HOSTED proxy (`platform-core-backend`) registers the KB manual over
 *     loopback plus each `.tool` the caller can read, resolves `${VAR}` from
 *     the Secrets Vault, and speaks streamable HTTP;
 *   - the LOCAL server (`@bevel-software/hexis-mcp`) registers the deployment's
 *     own MCP endpoint as one `mcp` manual plus the `remote: false` manuals the
 *     hosted endpoint cannot serve, resolves `${VAR}` from the process env, and
 *     speaks stdio.
 *
 * Everything between "a UTCP client with manuals registered" and "an MCP result"
 * is identical, and lives here: name flattening, the tool-name/schema guards
 * that stop one bad tool blanking a client's whole toolset, streaming dispatch,
 * the code-mode meta-tools, and recovery from a remote server that restarted
 * and forgot our session (see `session-recovery.ts`).
 *
 * What is NOT here, on purpose: manual DISCOVERY (who may see which manual is
 * an access-control question the hosted REST surface answers), credential
 * resolution (a vault loader server-side, `process.env` locally), and
 * REGISTRATION retry policy (see `registerManual`) — which is not the same
 * thing as session recovery, and stays each surface's own.
 */

export {
  type ProxiedTool,
  toListedTool,
  sanitizeInputSchema,
  flattenManualTool,
  flattenDiscoveredTool,
} from './proxied-tool.js';

export {
  describeToolFailure,
  toCallToolResult,
  renderProgress,
  toolError,
  needsAuthorizationResult,
  MCP_IMAGE_RESULT_KIND,
  type McpImageResult,
  mcpImageResult,
  isMcpImageResult,
  omitImagePayloads,
} from './results.js';

export {
  CODE_MODE_META_TOOLS,
  META_TOOL_NAMES,
  CALL_TOOL_CHAIN_MAX_OUTPUT,
  type SpillPort,
  dispatchMetaTool,
} from './meta-tools.js';

export { registerManual, dispatchToolCall } from './dispatch.js';

export {
  isSessionLoss,
  installSessionRecovery,
  type SessionRecoveryOptions,
} from './session-recovery.js';

export {
  type SkillSummary,
  type LoadedSkill,
  skillPromptText,
} from './skills.js';

export {
  utcpNamespacePrefix,
  utcpNamespacedKey,
  seedBevelHostedManualVars,
} from './utcp-namespace.js';

export {
  sanitizeIdentifier,
  utcpNameToTsInterfaceName,
  findToolByName,
  findToolsByNames,
  AmbiguousToolNameError,
} from './code-mode-names.js';
