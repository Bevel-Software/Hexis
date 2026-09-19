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
// side effect: registers the 'cli' protocol. Unlike the hosted platform — which
// registers the SERIALIZER only, so it can never run a shell command — this is
// the runtime a shell `.tool` exists for, and here the executor is the point.
import '@utcp/cli';
import { UtcpClientConfigSerializer, type CallTemplate, type Tool as UtcpTool } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  CODE_MODE_META_TOOLS,
  META_TOOL_NAMES,
  dispatchMetaTool,
  dispatchToolCall,
  registerManual,
  installSessionRecovery,
  noteManualReregistered,
  flattenManualTool,
  toListedTool,
  toolError,
  seedBevelHostedManualVars,
  printable,
  skillPromptText,
  type ProxiedTool,
  type SkillSummary,
  type LoadedSkill,
} from '@bevel-software/platform-mcp-core';
import type { HexisMcpConfig } from './config.js';
import {
  callKbTool,
  ConnectionKeyRejectedError,
  fetchAllManuals,
  fetchCatalogRevision,
  fetchLocalOnlyManuals,
  resolveDeployment,
  fetchAgentInstructions,
  type LocalManualInfo,
} from './deployment.js';
import { watchCatalog, type CatalogWatch } from './catalog-watch.js';
import { materializePlugin, prepareStdioSpec, type StdioServerSpec } from './materialize.js';
import { REMOTE_MANUAL_NAME, localManualTemplates, remoteManualTemplate } from './manuals.js';
import {
  bindLocalVariableResolver,
  registerLocalVariableLoader,
  localVariableLoaderConfig,
  resetLocalVariableResolver,
} from './local-variables.js';
import { closeRenewal } from './renewal.js';

/** Reported on `initialize`; the version is stamped at build time by the package. */
const SERVER_NAME = 'hexis-mcp';

/**
 * How long `shutdown()` waits for background discovery to come to rest
 * before closing anyway.
 *
 * Discovery stops at its phase boundaries, but a phase already in flight is
 * not cancellable: a deployment fetch runs to its own timeout, a credential
 * swap drains for up to 15s. Shorter than teardown.ts's SHUTDOWN_GRACE_MS on
 * purpose — the CLI's watchdog is the last resort for a hang, and this cap
 * has to expire INSIDE it to be the thing that acts first.
 */
export const DISCOVERY_SHUTDOWN_GRACE_MS = 5_000;

/**
 * A timer that does not, by existing, keep this process alive. The bounded
 * wait below races a promise against one of these, and the loser's timer
 * would otherwise hold the event loop open for its full delay after teardown
 * had already finished — a server that exits five seconds late looks hung.
 */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Build one UTCP client over both halves of the catalog.
 *
 * `${VAR}` resolution is where the two halves differ, and deliberately so.
 * Bevel-hosted manuals — the inline `.tool` sub-manuals whose discovery URL has
 * `${API_URL}` as its origin — are seeded the deployment address and the
 * caller's key, by the same shared rule the hosted proxy uses, which refuses to
 * seed anything else.
 *
 * Everything else falls through UTCP's later tiers, and there are now two.
 * First the local-variable loader, which asks the deployment to resolve what a
 * LOCAL manual's own `.tool` file declares — a tool that executes here needs
 * its credentials here, and the alternative was every user hand-placing them
 * on their own machine. It answers for local manuals only and never returns a
 * value to a caller: what it resolves is substituted into a tool invocation and
 * goes no further. Then `process.env`, unchanged, so an existing setup that
 * provisions a local tool through the MCP client config keeps working.
 *
 * A remote manual's tools still execute on the deployment and resolve their
 * credentials there. Nothing here can reach those — moving a server-side secret
 * onto a laptop would be a wider exposure than the tools it unlocks.
 */
async function buildClient(
  config: HexisMcpConfig,
  manuals: CallTemplate[],
  localOnly: ReadonlyMap<string, LocalManualInfo>,
): Promise<{ client: CodeModeUtcpClient; bindingId: string }> {
  const variables = seedBevelHostedManualVars(
    manuals as unknown as { name?: unknown; url?: unknown }[],
    config.baseUrl,
    config.connectionKey,
  );
  registerLocalVariableLoader();
  // A binding per client, not one per process: two servers in one process would
  // otherwise share a deployment, and the second to bind would retarget the
  // first's tools at the wrong vault.
  const bindingId = bindLocalVariableResolver(config, localOnly);
  // The id travels with the client so shutdown can release the binding — it
  // holds this deployment's config and its cached secret VALUES, and a host
  // that creates servers over time would otherwise accumulate both. The
  // binding is taken BEFORE anything below runs, so EVERY failure past this
  // line — config validation included, not only client creation — has nothing
  // downstream to release it and must do so itself.
  try {
    const clientConfig = new UtcpClientConfigSerializer().validateDict({
      variables,
      load_variables_from: [localVariableLoaderConfig(bindingId)],
    });
    return { client: await CodeModeUtcpClient.create(process.cwd(), clientConfig), bindingId };
  } catch (err) {
    resetLocalVariableResolver(bindingId);
    throw err;
  }
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
  await removeRemoteMetaTools(client);
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
 * Purge the deployment's meta-tool copies from the registry. Runs at first
 * registration AND after every credential-renewal re-registration of the
 * remote manual — re-registering rediscovers the deployment's copies, and a
 * copy left registered stays callable from chains against the remote registry
 * that cannot see a local-only tool (see `discoverTools`).
 */
async function removeRemoteMetaTools(client: CodeModeUtcpClient): Promise<void> {
  for (const name of META_TOOL_NAMES) {
    // A refused removal must not cost the caller: the listing filter below
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
 * the rest of the toolset must not pay for one broken server. The one
 * exception is a rejected connection key: that is not one broken server but a
 * dead credential for all of them, so it propagates and fails startup with
 * its own sentence.
 */
async function prepareLocalManuals(
  config: HexisMcpConfig,
  templates: CallTemplate[],
  localOnly: ReadonlyMap<string, LocalManualInfo>,
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
      const kbPath = localOnly.get(String(template.name))?.path ?? '';
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
      // A dead key is not one broken server: it fails startup in its own words.
      if (err instanceof ConnectionKeyRejectedError) throw err;
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
   * Settles when background tool discovery has finished, successfully or not.
   * It NEVER rejects — a failure is reported through the tool surface and on
   * stderr, not by throwing at whoever happens to be holding this.
   *
   * The server does not need it: every request handler awaits it already. It
   * is here for an embedding host that wants to know when the catalog is
   * real, and for the tests that pin exactly that ordering.
   */
  ready: Promise<void>;
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
 * The name of the single tool `tools/list` serves when discovery failed.
 *
 * A tool rather than an empty list, because an empty list is what a correctly
 * configured but tool-less workspace looks like: indistinguishable, from
 * inside a client, from a server that could not reach its deployment. The
 * reason travels in the description, which is the one string every client
 * shows next to a tool.
 */
export const DISCOVERY_NOTICE_TOOL = 'hexis_unavailable';

/** The one-tool listing that carries a discovery failure to the client. */
export function discoveryNoticeTool(reason: string): McpTool {
  return {
    name: DISCOVERY_NOTICE_TOOL,
    description:
      `hexis-mcp could not load this workspace's tools: ${reason} ` +
      'Fix the cause and restart this server; the same sentence is on its stderr log.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/**
 * Stand up the local MCP server — ANSWER FIRST, DISCOVER AFTER.
 *
 * What comes back is a server that can be connected and can answer
 * `initialize` right away. Everything expensive — fetching the manuals,
 * materializing every plugin, spawning their stdio servers, building the UTCP
 * client, discovering tools — runs in the BACKGROUND behind `ready`, and every
 * request handler awaits it before answering. This ordering is the whole point
 * of the change: a cold `npx` start downloads a dependency tree and then one
 * archive per plugin, all of which used to happen BEFORE the transport was
 * connected, so the client timed out (Claude Code allows 30s) on a server that
 * was working perfectly and had simply not said hello yet.
 *
 * Only the two small deployment reads stay in front of the handshake:
 * `/api/config`, which names the MCP endpoint, and the agent instructions —
 * because `instructions` travels in the `initialize` RESULT and is the one
 * thing that genuinely cannot be sent later. Both are single JSON GETs against
 * the workspace, not the downloads this reordering exists to move out of the
 * way. They are also where a rejected connection key still surfaces as a
 * startup failure with its own sentence, as before.
 *
 * A failure AFTER that point no longer kills startup. The process stays up and
 * says what happened, on stderr and through the tools themselves: `tools/list`
 * answers with one notice tool carrying the reason, `tools/call` with an MCP
 * error. Exiting there would look, from inside a client, exactly like a server
 * that was never configured.
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
  options: {
    /**
     * How often to check whether the deployment's tools or skills changed.
     * Defaults to `CATALOG_POLL_INTERVAL_MS` (see `catalog-watch.ts`); `0`
     * turns the watch off,
     * which freezes this server's toolset at what discovery found (what it
     * did before the watch existed). Here for tests and embedding hosts — the
     * CLI does not expose it, because the default is the contract the
     * knowledge base's guide states.
     */
    catalogPollMs?: number;
  } = {},
): Promise<HexisMcpHandle> {
  const { mcpUrl, agentInstructions, catalogRevision: catalogRevisionAdvertised } = await resolveDeployment(config);
  // Fetched here rather than alongside the manuals below: it is part of the
  // handshake's own answer, so it cannot wait behind `ready` the way the
  // catalog can.
  const instructions = agentInstructions ? await fetchAgentInstructions(config) : undefined;
  if (!agentInstructions) {
    console.error(
      '[hexis-mcp] this deployment predates agent instructions (no agentInstructions in /api/config); ' +
        'sessions start without them.',
    );
  }

  /**
   * CREDENTIAL SWAP (OAuth mode). The remote manual's MCP session captured
   * `Authorization: Bearer <token>` as a header when it was registered, so a
   * renewed token does nothing for it until the manual is re-registered with
   * a fresh template. `renewal.ts` calls `onConnectionKeyRenewed` on every
   * successful renewal — proactive or 401-triggered — and this is the swap:
   * deregister (which closes the manual's sessions), re-register with the new
   * bearer, purge the rediscovered remote meta-tool copies.
   *
   * Installed BEFORE discovery: the proactive timer armed at sign-in keeps
   * running through the fetch/materialize/registration work below (a large
   * plugin download can outlast 80% of a short grant), and a renewal firing
   * in that window must not be dropped for want of a listener. Until the
   * remote manual is registered the swap is a no-op — registration itself
   * reads `config.connectionKey`, which renewal.ts already updated — and a
   * renewal that lands WHILE registration is in flight is reconciled right
   * after it (see the registeredKey check below).
   *
   * Serialization, as far as the UTCP API allows: the client offers no lock,
   * so in-flight tool calls are COUNTED and the swap waits (bounded) for them
   * to drain, while calls arriving DURING a swap await its completion before
   * dispatch. The flattened `tools` list survives the swap untouched — it
   * holds only names and schemas, and `callToolStreaming` resolves the call
   * template from the repository BY NAME at call time, so re-registration is
   * invisible to it (verified against @utcp/sdk's dispatch).
   *
   * SESSION RECOVERY SHARES THIS GATE. Recovery (below) re-registers a manual
   * too, so both go through `withReregisterGate`: one at a time, never
   * interleaved, and never each waiting on the other. That last part is why
   * `callsParkedForReregister` exists — a call queued at the gate still holds
   * an `inflightCalls` slot, and a swap draining for it would wait out the
   * full deadline for a call that is itself waiting for that swap.
   *
   * Key mode sets no `renewConnectionKey`, so renewal.ts never renews, this
   * listener is never called, and the swap below never engages.
   */
  let closed = false;
  let remoteManualRegistered = false;
  let inflightCalls = 0;
  /** The one re-registration allowed at a time: a credential swap or a recovery. */
  let reregisterInProgress: Promise<void> | null = null;
  /** In-flight calls parked at that gate, waiting for their turn to recover. */
  let callsParkedForReregister = 0;
  /**
   * Discovery's products. They are now filled in AFTER the handlers exist, so
   * every closure reads them through these bindings rather than closing over
   * a value — and each one that uses the client re-reads it, because teardown
   * (or a failed discovery) sets it back to null.
   */
  let client: CodeModeUtcpClient | null = null;
  let bindingId: string | null = null;
  let tools: ProxiedTool[] = [];
  /** Why discovery failed, if it did: the sentence every handler answers with. */
  let discoveryError: string | null = null;
  /**
   * The SDK server, declared up here rather than beside `shutdown`: the
   * catalog refresh below sends notifications on it, and a closure defined
   * before it would otherwise have nothing to reach.
   */
  let server: Server | null = null;
  /** The running catalog watch, once discovery has a baseline to watch from. */
  let catalogWatch: CatalogWatch | null = null;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /**
   * Run `body` as THE re-registration in flight. `parksACall` marks the waiter
   * as a tool call whose own dispatch is blocked here, so a swap's drain does
   * not count it. The published promise never rejects: it says "finished", not
   * "succeeded".
   */
  const withReregisterGate = async <T>(body: () => Promise<T>, parksACall = false): Promise<T> => {
    if (parksACall) callsParkedForReregister += 1;
    try {
      while (reregisterInProgress) await reregisterInProgress;
    } finally {
      if (parksACall) callsParkedForReregister -= 1;
    }
    // `body()` runs to its first await before the publish below, and nothing
    // else can interleave in between — so anyone who observes this gate as
    // free has genuinely not missed a re-registration that already began.
    const run = body();
    const published: Promise<void> = run.then(
      () => {},
      () => {},
    ).finally(() => {
      if (reregisterInProgress === published) reregisterInProgress = null;
    });
    reregisterInProgress = published;
    return run;
  };
  const swapRemoteCredential = async (token: string): Promise<void> => {
    // The manual is registered only once discovery got that far, so the guard
    // also keeps this closure off a client that does not exist yet.
    if (closed || !remoteManualRegistered) return;
    await withReregisterGate(async (): Promise<void> => {
      if (closed) return; // shutdown landed while awaiting the gate
      const live = client;
      if (!live) return; // discovery failed and released it while we queued
      // Bounded drain: a wedged call must not hold the credential stale
      // forever — after the deadline the swap proceeds and the straggler
      // fails like any call racing a dying session would.
      const deadline = Date.now() + 15_000;
      while (inflightCalls - callsParkedForReregister > 0 && Date.now() < deadline) await sleep(50);
      try {
        // Closes the manual's MCP sessions and drops its repository entries.
        await live.deregisterManual(REMOTE_MANUAL_NAME);
      } catch (err) {
        console.error(
          `[hexis-mcp] deregistering the remote manual for the credential swap failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const result = await registerManual(live, remoteManualTemplate(mcpUrl, token));
      if (!result.ok) {
        console.error(
          `[hexis-mcp] re-registering the remote manual with the renewed credential failed: ${result.error}. ` +
            'Remote tools may be unavailable until the next renewal or a restart.',
        );
        return;
      }
      await removeRemoteMetaTools(live);
      // The manual now holds a session this swap created. A call that lost its
      // own session around the swap — the two often land together, a redeploy
      // being exactly when a 401-triggered renewal happens — retries against
      // THIS one instead of deregistering it to dial an identical third.
      noteManualReregistered(live, REMOTE_MANUAL_NAME);
      console.error('[hexis-mcp] remote manual re-registered with the renewed credential.');
    });
  };
  if (config.renewConnectionKey) {
    config.onConnectionKeyRenewed = swapRemoteCredential;
  }

  /**
   * The deployment's catalog moved: re-register its manual so the toolset this
   * process serves is the current one, then TELL the client.
   *
   * Both halves matter and neither substitutes for the other. Re-registration
   * is what makes the new tool callable here — the registered MCP session is
   * where `tools/list` comes from, and it was built at startup. The
   * notification is what makes a client that cached the list ask again; a
   * client that ignores it keeps the stale list until it re-lists for its own
   * reasons, which is why the guide says so plainly.
   *
   * Under the SAME gate as the credential swap and session recovery, so the
   * three re-registration paths can never interleave, and with the same
   * bounded drain: a wedged call must not hold the catalog stale forever.
   *
   * SCOPE: the REMOTE manual only. Local-only servers (`local: true`,
   * `type: stdio`) are materialized to disk and spawned as child processes at
   * startup; adding one still needs a restart, and the log line says so rather
   * than leaving the reader to discover it. Everything the deployment serves —
   * every `.tool`, every remote `mcp.json` entry, and the KB tools themselves —
   * arrives through the remote manual and is covered here.
   *
   * BOTH notifications fire on any change, because one fingerprint covers both
   * catalogs: a `.tool` commit re-lists prompts that did not move, and a
   * `SKILL.md` commit re-lists tools that did not move. One extra round trip
   * on a client that honours them, against a second poll to tell the two
   * apart on every deployment that has neither.
   */
  const refreshRemoteCatalog = async (): Promise<void> => {
    if (closed || !remoteManualRegistered) return;
    const refreshed = await withReregisterGate(async (): Promise<boolean> => {
      if (closed) return false; // shutdown landed while awaiting the gate
      const live = client;
      if (!live) return false; // discovery failed and released it while we queued
      const deadline = Date.now() + 15_000;
      while (inflightCalls - callsParkedForReregister > 0 && Date.now() < deadline) await sleep(50);
      try {
        await live.deregisterManual(REMOTE_MANUAL_NAME);
      } catch (err) {
        console.error(
          `[hexis-mcp] deregistering the remote manual to pick up a catalog change failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // The credential is read NOW, not captured: a renewal may have landed
      // between this poll and the gate, exactly as it may around a recovery.
      const result = await registerManual(live, remoteManualTemplate(mcpUrl, config.connectionKey));
      if (!result.ok) {
        console.error(
          `[hexis-mcp] re-registering the remote manual after a catalog change failed: ${result.error}. ` +
            'Remote tools may be unavailable until the next change or a restart.',
        );
        return false;
      }
      await removeRemoteMetaTools(live);
      noteManualReregistered(live, REMOTE_MANUAL_NAME);
      // Re-flattened from the repository rather than re-running discovery:
      // `getTools` already holds the local manuals registered at startup, so
      // this replaces the remote half and leaves their spawned children alone.
      tools = withoutRemoteMetaTools(
        (await live.getTools()).map((tool: UtcpTool) => flattenManualTool(tool, REMOTE_MANUAL_NAME)),
      );
      console.error(
        `[hexis-mcp] the workspace's catalog changed — ${tools.length} tool(s) now served. ` +
          'A newly added local-only server still needs a restart of this process.',
      );
      return true;
    });
    if (!refreshed || closed) return;
    // Best-effort, and separately: a client connected over a transport that
    // has already gone away must not turn a successful refresh into a failure.
    const notifyFailed = (what: string) => (err: unknown) => {
      console.error(
        `[hexis-mcp] could not send the ${what}-list-changed notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    };
    await server?.sendToolListChanged().catch(notifyFailed('tool'));
    await server?.sendPromptListChanged().catch(notifyFailed('prompt'));
  };

  /**
   * Release what discovery built: the UTCP client — whose close is the only
   * thing that reliably ends the spawned stdio children — and the variable
   * binding, which holds this deployment's cached secret values (released
   * here rather than left to the process, because this module explicitly
   * supports several servers in one host).
   *
   * Separate from `shutdown`, because a FAILED discovery has to run it while
   * the server stays UP: children of a half-built client are exactly the
   * orphans teardown exists to prevent, but closing the SDK server too would
   * hang up on the client we are trying to tell what went wrong. Idempotent —
   * it clears the bindings it consumed, so shutdown after a failure is a
   * no-op rather than a double close.
   */
  const releaseDiscovered = async (): Promise<void> => {
    const live = client;
    client = null;
    const binding = bindingId;
    bindingId = null;
    if (live) await live.close().catch(() => {});
    if (binding !== null) resetLocalVariableResolver(binding);
  };

  /**
   * Everything that used to run before `server.connect`, now behind the gate.
   *
   * Cooperative about teardown: a client that hangs up mid-startup (or a
   * Ctrl+C) must not have a plugin download run to completion, spawn its
   * servers and leave them behind, so every phase boundary rechecks `closed`
   * and stops there. Whatever HAS been built by then is released by
   * `shutdown`, which waits for this to come to rest before closing anything.
   */
  const discover = async (): Promise<void> => {
    const [allManuals, localOnly, baselineRevision] = await Promise.all([
      fetchAllManuals(config),
      fetchLocalOnlyManuals(config),
      // Read ALONGSIDE the manuals, so it is the revision of the catalog this
      // discovery is about to register — not one read afterwards, which would
      // swallow a commit that landed in between. Only when the deployment
      // ADVERTISES the route: an older one would answer the unknown path
      // through its JWT mounts with a 401, which reads as a dead credential.
      // Never fatal either way — a deployment that cannot answer it is one
      // whose tools still work, frozen at what this discovery found.
      catalogRevisionAdvertised
        ? fetchCatalogRevision(config).then(
            (r) => r,
            () => null,
          )
        : Promise.resolve(null),
    ]);
    if (closed) return;
    const local = await prepareLocalManuals(
      config,
      localManualTemplates(allManuals, new Set(localOnly.keys())),
      localOnly,
    );
    if (closed) return;
    // Read at registration time, not at entry: a renewal during the fetches
    // above must be the credential the remote manual registers with.
    const registeredKey = config.connectionKey;
    const remote = remoteManualTemplate(mcpUrl, registeredKey);

    const built = await buildClient(config, [remote, ...local], localOnly);
    // Published IMMEDIATELY, before the next await: from here on the client
    // owns closeable resources, and a teardown racing this line must find
    // something to close rather than a null that leaks it.
    client = built.client;
    bindingId = built.bindingId;
    if (closed) return;

    /**
     * SESSION RECOVERY. A deployment redeploy — or a local `mcp.json` server
     * restarting — throws away the sessions our manuals hold, and the next call
     * on one gets the spec's 404/`-32001`. Installed on the client, so the MCP
     * surface below and any `call_tool_chain` recover through the same mechanism.
     *
     * The template is rebuilt HERE rather than captured, so the remote manual
     * re-registers with whatever connection key renewal has arrived at by now (a
     * restart and a renewal often land together). Recovery runs under the SAME
     * gate the credential swap uses, which is what keeps the two re-registration
     * paths off each other, and it is `closed`-checked INSIDE that gate: once
     * shutdown holds it, a recovery behind it registers nothing — and a recovery
     * that got in first is awaited by `shutdown` before the client is closed, so
     * a local manual can never be registered (spawning a child) after teardown.
     */
    const localByName = new Map(local.map((m) => [String(m.name), m]));
    installSessionRecovery(built.client, {
      withReregister: (_name, run) => withReregisterGate(run, true),
      manualTemplate: (name) => {
        if (closed) return undefined;
        return name === REMOTE_MANUAL_NAME
          ? remoteManualTemplate(mcpUrl, config.connectionKey)
          : localByName.get(name);
      },
      // Re-registering rediscovers the deployment's own copies of the code-mode
      // meta-tools, which must not be callable from a chain here (see
      // `discoverTools`) — the same purge first registration does.
      afterReregister: async (name) => {
        if (name === REMOTE_MANUAL_NAME) await removeRemoteMetaTools(built.client);
      },
      // No `log` override: the default writes to stderr, which is the only place
      // this stdio server may write — stdout is the MCP transport itself.
    });

    const discovered = withoutRemoteMetaTools(await discoverTools(built.client, remote, local));
    remoteManualRegistered = true;
    // A renewal that landed while registration was in flight hit the no-op
    // guard above; without this reconciliation the manual would keep the
    // retired bearer until the next renewal.
    if (config.connectionKey !== registeredKey) {
      await swapRemoteCredential(config.connectionKey);
    }
    tools = discovered;

    console.error(
      `[hexis-mcp] ${config.baseUrl} — ${tools.length} tool(s) ready ` +
        `(${local.length} local-only manual(s) registered here, the rest served by the workspace).`,
    );

    // Started LAST, and only on a discovery that got this far: there is
    // nothing to refresh until there is a registered manual to re-register.
    // A teardown that raced the line above finds `closed` and skips it, so
    // this never outlives the server that owns it.
    if (closed) return;
    if (!catalogRevisionAdvertised) {
      console.error(
        '[hexis-mcp] this deployment predates catalog change detection (no catalogRevision in /api/config); ' +
          'tools and skills added to it will not appear here until this server is restarted.',
      );
      return;
    }
    catalogWatch = watchCatalog({
      config,
      initialRevision: baselineRevision,
      intervalMs: options.catalogPollMs,
      onChanged: refreshRemoteCatalog,
    });
  };

  /**
   * The gate every handler awaits. It NEVER rejects — a rejection here would
   * be unhandled for as long as no request happens to arrive, and the point
   * of the failure path is that it survives to be reported rather than
   * killing the process from a corner.
   */
  const ready: Promise<void> = discover().then(
    () => {},
    async (err: unknown) => {
      discoveryError = err instanceof Error ? err.message : String(err);
      // `printable`, because this reason came off the network: a deployment
      // (or a proxy in front of it) chose the text, and interpolated raw a
      // newline in it would start a line of its own in the operator log and an
      // ANSI escape would paint their terminal. The CLIENT-facing copies below
      // keep the reason verbatim — they travel inside a JSON-RPC string, where
      // it is already data rather than a line.
      console.error(
        `[hexis-mcp] tool discovery failed: ${printable(discoveryError)} ` +
          'The server stays connected and answers tools/list with this notice; restart it once the cause is fixed.',
      );
      // Whatever got built before the failure — including any stdio children
      // already spawned — goes now. The SDK server does not: it is how the
      // client learns any of this.
      //
      // Swallowed rather than allowed to propagate, so "never rejects" is a
      // property of this promise and not a bet on the release path: a
      // rejection here would surface as an unhandled one until some request
      // happened to await the gate, and would throw `shutdown` off course
      // halfway through teardown — the one place that cannot afford it.
      await releaseDiscovered().catch(() => {});
    },
  );

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // First, because everything below tears down what a refresh would run
    // against. A poll already in flight finds `closed` at the gate and
    // registers nothing.
    catalogWatch?.stop();
    catalogWatch = null;
    // No further renewals or credential swaps once we are going down: the
    // renewal lifecycle is closed FOR GOOD (timer disarmed, and a renewal
    // starting after this point — a straggling 401-retry — is refused, not
    // merely de-fanged), the listener is unhooked (renewal.ts reads it at
    // notify time, so a renewal already in flight applies to nothing), and a
    // swap — or a session recovery — that started before this point gets to
    // finish before the client it operates on is closed out from under it.
    closeRenewal(config);
    if (config.onConnectionKeyRenewed === swapRemoteCredential) {
      config.onConnectionKeyRenewed = undefined;
    }
    // Discovery now runs in the BACKGROUND, so teardown can land in the
    // middle of it — mid-download, mid-spawn. `closed` is already true, so
    // every remaining phase boundary stops; this waits for it to come to
    // rest, because closing the client while it is still registering manuals
    // is how a spawned child ends up with nobody left to close it. `ready`
    // never rejects, so it cannot throw teardown off course.
    //
    // BOUNDED, though: the phase boundaries stop discovery, the phase IN
    // FLIGHT does not stop — a fetch runs to its own AbortSignal.timeout, a
    // credential swap drains for up to 15s — and an embedding host calling
    // `shutdown()` would wait out all of it. (cli.ts has its own watchdog;
    // a library caller has none, which is who this cap is for.) Past the cap
    // we close anyway, and whatever discovery builds AFTER that is released
    // when it does come to rest — `releaseDiscovered` is idempotent and
    // re-reads `client`, so the late call frees a late child rather than
    // double-closing an early one.
    const settledInTime = await Promise.race([
      ready.then(() => true),
      unrefSleep(DISCOVERY_SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!settledInTime) {
      console.error(
        `[hexis-mcp] tool discovery was still in flight ${DISCOVERY_SHUTDOWN_GRACE_MS}ms into shutdown; ` +
          'closing now and releasing whatever it finishes building.',
      );
      void ready.then(() => releaseDiscovered().catch(() => {}));
    }
    // One await, not a loop: whatever holds the gate finishes, and anything
    // queued behind it now finds `closed` and registers nothing. The gate
    // promise never rejects, so this cannot throw teardown off course.
    if (reregisterInProgress) await reregisterInProgress;
    // The SDK server too, not only the client: embedding callers connect the
    // transport themselves, and this handle should fully tear down — closing
    // the server closes its transport (and with it any pending requests).
    await server?.close().catch(() => {});
    await releaseDiscovered();
  };

  try {
    server = new Server(
      { name: SERVER_NAME, version },
      // The same text the hosted endpoint sends on its handshake, so a client
      // connected here is told what the knowledge base is and to search it.
      //
      // `listChanged` on both: a manual or a skill committed on the
      // deployment's default branch reaches this connection without a
      // reconnect (see `refreshRemoteCatalog`), and declaring the capability
      // is what permits the notification that says so.
      {
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        ...(instructions !== undefined ? { instructions } : {}),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await ready;
      // The failure goes IN the listing, not into an empty one: an empty
      // toolset is what a tool-less workspace looks like, and a client that
      // shows one gives its reader nothing to act on.
      if (discoveryError !== null) return { tools: [discoveryNoticeTool(discoveryError)] };
      // Shutdown can land DURING discovery: every phase boundary then returns
      // early, which is a clean return — no error, and `tools` still empty.
      // Answering that with an empty listing would show the reader exactly
      // what a correctly configured, tool-less workspace shows, which is the
      // look the notice above exists to prevent. The truth is the same one
      // the call handler gives: this server is going away.
      if (closed) throw new McpError(ErrorCode.ConnectionClosed, 'hexis-mcp is shutting down.');
      return { tools: listedTools(tools) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      // Same wait as the listing: a client that calls a tool it just listed
      // must not be told it does not exist because the catalog is still
      // arriving. (After the first list this is already settled.)
      await ready;
      if (discoveryError !== null) {
        throw new McpError(
          ErrorCode.InternalError,
          `hexis-mcp could not load this workspace's tools: ${discoveryError}`,
        );
      }
      // Never start a call mid-re-registration — a swap or a recovery may have
      // the manual between its deregister and its register, where a repository
      // lookup finds nothing.
      while (reregisterInProgress) await reregisterInProgress;
      // Shutdown can land while a call waits here, and `shutdown` waits only
      // for the re-registration, not for callers parked behind it. Dispatching
      // now would run against a client being torn down, so the caller gets the
      // real reason rather than whatever a half-closed transport throws.
      const live = client;
      if (closed || !live) throw new McpError(ErrorCode.ConnectionClosed, 'hexis-mcp is shutting down.');
      inflightCalls += 1;
      try {
        const name = request.params.name;
        if (META_TOOL_NAMES.has(name)) {
          // No spill store: this process has nowhere to park an oversized chain
          // result that `read_file` could read back, so the shared dispatcher
          // returns a truncation notice instead of a ref that resolves nowhere.
          return await dispatchMetaTool(live, name, request.params.arguments ?? {});
        }
        const tool = tools.find((t) => t.mcpName === name);
        if (!tool) return toolError(`Unknown tool "${name}".`);
        const progressToken = request.params._meta?.progressToken;
        return await dispatchToolCall(live, tool, request.params.arguments ?? {}, (progress, message) =>
          extra.sendNotification({
            method: 'notifications/progress',
            params: {
              ...(progressToken !== undefined ? { progressToken } : {}),
              progress,
              message,
            },
          } as never),
        );
      } finally {
        inflightCalls -= 1;
      }
    });

    /**
     * Prompts are skills, and they do NOT arrive through the remote manual: UTCP
     * carries tools, so registering the deployment's MCP endpoint brings its
     * tools and silently drops its prompts. We rebuild them from the same two KB
     * tools the hosted server uses, so a skill reads identically either way.
     *
     * Behind `ready` like the tool surface, even though they read the
     * deployment directly: the contract a client is given is that every
     * request after `initialize` answers as it did before this reordering.
     */
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      await ready;
      return listSkillPrompts(config);
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      await ready;
      return getSkillPrompt(config, request.params.name);
    });

    return { server, ready, shutdown };
  } catch (err) {
    // Building the SDK surface itself failed, with discovery already in
    // flight behind it: the caller gets a rejection instead of a handle, so
    // nobody else can close what that discovery is spawning. Same teardown as
    // the returned `shutdown`; it never throws, so the original failure is
    // what propagates.
    await shutdown();
    throw err;
  }
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
