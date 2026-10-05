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
  type SchemaDefect,
  inputSchemaDefect,
  schemaDefectMarker,
} from './schema-validity.js';

export {
  describeToolFailure,
  withTransportDetail,
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
  codeModeMetaTools,
  chainNamespaceExample,
  META_TOOL_NAMES,
  CALL_TOOL_CHAIN_MAX_OUTPUT,
  CALL_TOOL_CHAIN_NAME,
  CHAIN_FAILURES_RULE,
  CHAIN_LARGE_RESULTS_RULE,
  type CodeModeMetaToolsOptions,
  type SpillPort,
  dispatchMetaTool,
} from './meta-tools.js';

export {
  CHAIN_RUNTIME_PRELUDE,
  CHAIN_TIMEOUT_DEFAULT_MS,
  CHAIN_TIMEOUT_MAX_MS,
  CHAIN_TIMEOUT_MIN_MS,
  type ChainNamespaces,
  type ToolChainOutcome,
  chainNamespaces,
  chainOutOfMemoryMessage,
  chainTimeoutMessage,
  describeChainFailure,
  runToolChain,
  unknownNamespaceMessage,
  withChainRuntime,
} from './chain-runtime.js';

export {
  type ChainExample,
  type ChainExampleTool,
  chainExample,
} from './chain-example.js';

export { registerManual, dispatchToolCall } from './dispatch.js';

export {
  RETIRED_TOOL_MESSAGES,
  RETIRED_TOOL_NAMES,
  retiredToolMessage,
  retiredToolInFailure,
} from './retired-tools.js';

export {
  isSessionLoss,
  installSessionRecovery,
  noteManualReregistered,
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

export { printable } from './printable.js';
