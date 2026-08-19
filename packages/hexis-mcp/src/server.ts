import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool as McpTool,
  type Prompt,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import '@utcp/http'; // side effect: registers the 'http' UTCP communication protocol
import '@utcp/mcp'; // side effect: registers the 'mcp' protocol (the deployment + native MCP `.tool`s)
import { UtcpClientConfigSerializer, type CallTemplate, type Tool as UtcpTool } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  CODE_MODE_META_TOOLS,
  META_TOOL_NAMES,
  dispatchMetaTool,
  dispatchToolCall,
  registerManual,
  flattenManualTool,
  toListedTool,
  toolError,
  seedBevelHostedManualVars,
  skillPromptText,
  type ProxiedTool,
  type SkillSummary,
  type LoadedSkill,
} from '@bevel-software/platform-mcp-core';
import type { HexisMcpConfig } from './config.js';
import {
  callKbTool,
  fetchAllManuals,
  fetchLocalOnlyManuals,
  resolveMcpUrl,
} from './deployment.js';
import { materializePlugin, prepareStdioSpec, type StdioServerSpec } from './materialize.js';
import { REMOTE_MANUAL_NAME, localManualTemplates, remoteManualTemplate } from './manuals.js';

/** Reported on `initialize`; the version is stamped at build time by the package. */
const SERVER_NAME = 'hexis-mcp';

/**
 * Build one UTCP client over both halves of the catalog.
 *
 * `${VAR}` resolution is where the two halves differ, and deliberately so.
 * Bevel-hosted manuals — the inline `.tool` sub-manuals whose discovery URL has
 * `${API_URL}` as its origin — are seeded the deployment address and the
 * caller's key, by the same shared rule the hosted proxy uses, which refuses to
 * seed anything else. Every other placeholder falls through UTCP's last
 * resolution tier, `process.env`: a local-only tool's credentials come from the
 * MCP client config that launched this process, and nothing here can read the
 * deployment's Secrets Vault. That is a property, not a gap — a vault value
 * reaching a laptop would be a wider exposure than the tools it unlocks.
 */
async function buildClient(
  config: HexisMcpConfig,
  manuals: CallTemplate[],
): Promise<CodeModeUtcpClient> {
  const variables = seedBevelHostedManualVars(
    manuals as unknown as { name?: unknown; url?: unknown }[],
    config.baseUrl,
    config.connectionKey,
  );
  const clientConfig = new UtcpClientConfigSerializer().validateDict({ variables });
  return CodeModeUtcpClient.create(process.cwd(), clientConfig);
}

/**
 * Register every manual, then flatten what was discovered.
 *
 * The deployment's own manual failing is fatal: without it there is no core
 * toolset and the client would come up looking empty for no stated reason. A
 * local manual failing is isolated and logged — one unreachable localhost
 * server must not cost the caller everything else.
 *
 * The deployment's copies of the code-mode meta-tools are removed from the
 * REGISTRY, not merely hidden from the MCP listing: `list_tools` and
 * `call_tool_chain` here reflect over the client's tool repository, so a copy
 * left registered would still be advertised to — and callable from — a chain,
 * which would run it against the remote registry that cannot see a local-only
 * tool. This process serves its own trio instead, over the merged registry.
 * Exported for the catalog tests.
 */
export async function discoverTools(
  client: CodeModeUtcpClient,
  remote: CallTemplate,
  local: CallTemplate[],
): Promise<ProxiedTool[]> {
  const remoteResult = await registerManual(client, remote);
  if (!remoteResult.ok) {
    throw new Error(
      `Could not load the workspace's tools: ${remoteResult.error}. ` +
        'Check the URL and that the connection key is still valid.',
    );
  }
  for (const name of META_TOOL_NAMES) {
    // A refused removal must not cost the startup: the listing filter below
    // still keeps the copy out of the MCP surface, so the degradation is
    // "chains can see it", not "the server never came up". Named, not silent.
    try {
      await client.config.tool_repository.removeTool(`${REMOTE_MANUAL_NAME}.${name}`);
    } catch (err) {
      console.error(
        `[hexis-mcp] could not remove the deployment's "${name}" from the registry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const manual of local) {
    const result = await registerManual(client, manual);
    if (!result.ok) {
      console.error(`[hexis-mcp] skipping local tool "${String(manual.name)}": ${result.error}`);
    }
  }
  const tools = await client.getTools();
  return tools.map((tool: UtcpTool) => flattenManualTool(tool, REMOTE_MANUAL_NAME));
}

/**
 * Belt to `discoverTools`'s registry removal: whatever a repository
 * implementation declined to remove must still never reach the MCP listing,
 * where a remote `list_tools` would shadow — or duplicate — the local trio.
 */
export function withoutRemoteMetaTools(tools: ProxiedTool[]): ProxiedTool[] {
  return tools.filter((t) => !META_TOOL_NAMES.has(t.mcpName));
}

/**
 * Validate + dedupe the discovered tools into MCP listing entries.
 *
 * Remote tools are added first and win a name collision, because a local `.tool`
 * shadowing `read_file` would silently redirect the core toolset. Every drop is
 * logged with its reason: a tool going missing is otherwise invisible, since a
 * client rejects the whole listing over one bad entry rather than telling
 * anyone which one.
 */
export function listedTools(tools: ProxiedTool[]): McpTool[] {
  const seen = new Set<string>(META_TOOL_NAMES);
  const listed: McpTool[] = [];
  const dropped: string[] = [];
  for (const tool of tools) {
    const entry = toListedTool(tool); // logs its own reason on a name/schema drop
    if (!entry) {
      dropped.push(tool.mcpName);
      continue;
    }
    if (seen.has(entry.name)) {
      dropped.push(`${entry.name} (duplicate)`);
      continue;
    }
    seen.add(entry.name);
    listed.push(entry);
  }
  if (dropped.length) {
    console.error(
      `[hexis-mcp] serving ${CODE_MODE_META_TOOLS.length + listed.length} tool(s); ` +
        `dropped ${dropped.length} non-listable: ${dropped.join(', ')}`,
    );
  }
  return [...CODE_MODE_META_TOOLS, ...listed];
}

/**
 * Ready the local manuals for registration. Only stdio MCP servers need work:
 * per the Agent Plugins runtime contract their plugin is MATERIALIZED locally
 * (fetched into `~/.hexis/plugins/...`), placeholders are expanded, and the
 * command is containment-checked — then `@utcp/mcp` spawns them like any other
 * server config. A manual whose preparation fails is dropped WITH its reason;
 * the rest of the toolset must not pay for one broken server.
 */
async function prepareLocalManuals(
  config: HexisMcpConfig,
  templates: CallTemplate[],
  localOnly: ReadonlyMap<string, string>,
): Promise<CallTemplate[]> {
  const out: CallTemplate[] = [];
  const materialized = new Map<string, Awaited<ReturnType<typeof materializePlugin>>>();
  for (const template of templates) {
    const config_ = (template as { config?: { mcpServers?: Record<string, StdioServerSpec & { transport?: string }> } })
      .config;
    const servers = config_?.mcpServers ?? {};
    const stdioNames = Object.keys(servers).filter((k) => servers[k]?.transport === 'stdio');
    if (stdioNames.length === 0) {
      out.push(template);
      continue;
    }
    try {
      // `Plugins/<folder>/mcp.json` → the plugin to materialize.
      const kbPath = localOnly.get(String(template.name)) ?? '';
      const folder = kbPath.split('/')[1];
      if (!folder) throw new Error(`cannot locate the plugin for "${String(template.name)}" (path "${kbPath}")`);
      let plugin = materialized.get(folder);
      if (!plugin) {
        plugin = await materializePlugin(config, folder);
        materialized.set(folder, plugin);
        console.error(`[hexis-mcp] materialized plugin "${folder}" at ${plugin.pluginRoot}`);
      }
      for (const name of stdioNames) {
        const prepared = await prepareStdioSpec(servers[name]!, plugin);
        servers[name] = { ...prepared, transport: 'stdio' };
      }
      out.push(template);
    } catch (err) {
      console.error(
        `[hexis-mcp] skipping local server "${String(template.name)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** The live server plus its teardown — see `createHexisMcpServer`. */
export interface HexisMcpHandle {
  server: Server;
  /**
   * Close the UTCP client — and with it every communication protocol it
   * holds, including @utcp/mcp's stdio transports, whose close() is what
   * actually terminates the spawned local server processes. Idempotent and
   * never throws: teardown runs on the way out, where nothing can act on an
   * error anyway.
   */
  shutdown: () => Promise<void>;
}

/**
 * Stand up the local MCP server: connect it to a transport and it is live.
 *
 * Discovery happens here, before the server is returned, so `tools/list` is
 * ready the moment a client asks — and so a bad URL or a dead key fails at
 * startup with a readable message instead of an empty toolset.
 *
 * Returned WITH its `shutdown`, because the spawned stdio servers are held by
 * the UTCP client, not the SDK `Server` — a caller that lets this process
 * exit without closing the client is relying on the stdin-EOF cascade to end
 * its grandchildren, and that cascade observably leaks (an orphaned server
 * then holds its plugin root hostage for every later instance).
 */
export async function createHexisMcpServer(
  config: HexisMcpConfig,
  version: string,
): Promise<HexisMcpHandle> {
  const mcpUrl = await resolveMcpUrl(config);
  const [allManuals, localOnly] = await Promise.all([
    fetchAllManuals(config),
    fetchLocalOnlyManuals(config),
  ]);
  const local = await prepareLocalManuals(
    config,
    localManualTemplates(allManuals, new Set(localOnly.keys())),
    localOnly,
  );
  const remote = remoteManualTemplate(mcpUrl, config.connectionKey);

  const client = await buildClient(config, [remote, ...local]);
  const tools = withoutRemoteMetaTools(await discoverTools(client, remote, local));

  console.error(
    `[hexis-mcp] ${config.baseUrl} — ${tools.length} tool(s) ready ` +
      `(${local.length} local-only manual(s) registered here, the rest served by the workspace).`,
  );

  const server = new Server(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(tools) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    if (META_TOOL_NAMES.has(name)) {
      // No spill store: this process has nowhere to park an oversized chain
      // result that `read_file` could read back, so the shared dispatcher
      // returns a truncation notice instead of a ref that resolves nowhere.
      return dispatchMetaTool(client, name, request.params.arguments ?? {});
    }
    const tool = tools.find((t) => t.mcpName === name);
    if (!tool) return toolError(`Unknown tool "${name}".`);
    const progressToken = request.params._meta?.progressToken;
    return dispatchToolCall(client, tool, request.params.arguments ?? {}, (progress, message) =>
      extra.sendNotification({
        method: 'notifications/progress',
        params: {
          ...(progressToken !== undefined ? { progressToken } : {}),
          progress,
          message,
        },
      } as never),
    );
  });

  /**
   * Prompts are skills, and they do NOT arrive through the remote manual: UTCP
   * carries tools, so registering the deployment's MCP endpoint brings its
   * tools and silently drops its prompts. We rebuild them from the same two KB
   * tools the hosted server uses, so a skill reads identically either way.
   */
  server.setRequestHandler(ListPromptsRequestSchema, async () => listSkillPrompts(config));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getSkillPrompt(config, request.params.name),
  );

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // `UtcpClient.close()` releases every registered communication protocol;
    // @utcp/mcp's close tears down its sessions AND the stdio transports,
    // which is the only thing that reliably ends the spawned children.
    await client.close().catch(() => {});
  };
  return { server, shutdown };
}

/**
 * The prompt list, rebuilt from the deployment's `list_skills`. An upstream
 * failure PROPAGATES: a dead key or unreachable deployment must surface as the
 * request's error, not as a workspace that "has no prompts". Exported for the
 * catalog tests.
 */
export async function listSkillPrompts(config: HexisMcpConfig): Promise<{ prompts: Prompt[] }> {
  const res = (await callKbTool(config, 'list_skills', {})) as { skills?: SkillSummary[] } | null;
  const skills = Array.isArray(res?.skills) ? res.skills : [];
  const prompts: Prompt[] = skills.map((s) => ({
    name: s.name,
    description: s.description,
    arguments: [],
  }));
  return { prompts };
}

/**
 * One skill as a prompt. `Unknown skill` (InvalidParams — the caller's mistake)
 * is reserved for a lookup that SUCCEEDED and found nothing; an upstream
 * failure propagates instead of masquerading as it. Exported for the catalog
 * tests.
 */
export async function getSkillPrompt(
  config: HexisMcpConfig,
  name: string,
): Promise<GetPromptResult> {
  const res = (await callKbTool(config, 'get_skill', { name })) as {
    ok?: boolean;
    kind?: string;
    skill?: LoadedSkill;
  } | null;
  if (!res?.ok || res.kind !== 'skill' || !res.skill) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown skill "${name}".`);
  }
  return {
    description: res.skill.description,
    messages: [{ role: 'user', content: { type: 'text', text: skillPromptText(res.skill) } }],
  };
}
