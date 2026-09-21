import { createHash } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('mcp');
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
  isInitializeRequest,
  type CallToolResult,
  type Tool as McpTool,
  type Prompt,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import '@utcp/http'; // side effect: registers the 'http' UTCP communication protocol
import '@utcp/mcp'; // side effect: registers the 'mcp' protocol (native MCP-server `.tool` sources)
import {
  UtcpClientConfigSerializer,
  CallTemplateSerializer,
  UtcpManualSchema,
  type CallTemplate,
  type Tool as UtcpTool,
} from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  CODE_MODE_META_TOOLS,
  META_TOOL_NAMES,
  dispatchMetaTool,
  dispatchToolCall,
  registerManual,
  installSessionRecovery,
  flattenManualTool,
  toListedTool,
  toolError,
  retiredToolMessage,
  needsAuthorizationResult,
  skillPromptText,
  type ProxiedTool,
  type SkillSummary,
  type LoadedSkill,
} from '@bevel-software/platform-mcp-core';
import { bevelSecretsLoaderConfig } from '../secrets-vault/index.js';
import { scopesCovered, type ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import type { SpillStore } from '../workspace/spill-store.js';
import { seedBevelHostedManualVars } from '../../shared/utcp-namespace.js';
import type { InternalTokenService } from '../tool-auth/internal-token.service.js';
import { ManualFailureMemo } from './manual-failure-memo.js';
import { DownstreamPool, POOL_KEY_SEPARATOR, type DownstreamPoolOptions, type Lease } from './downstream-pool.js';
import { SurfaceLogThrottle } from './surface-log-throttle.js';
import {
  composeAgentInstructions,
  prefixToolDescription,
  PREFIXED_TOOLS,
  type AgentPreambleReader,
  type ComposedAgentInstructions,
} from '../agent-instructions/index.js';

/**
 * Configuration for the loopback proxy. `loopbackBaseUrl` is the backend's own
 * address (`http://127.0.0.1:<port>`) and `manualName` is BOTH the UTCP manual
 * namespace the per-request client registers under AND the prefix its `${VAR}`
 * placeholders resolve through (`<manualName>_API_URL` / `_CONNECTION_KEY`).
 */
export interface McpProxyOptions {
  loopbackBaseUrl: string;
  manualName: string;
  /** Shared spill store for oversized `call_tool_chain` results (parity with the in-process agent). */
  spillStore: SpillStore;
  /** Public web address of the frontend, for the needs-authorization setup link. */
  publicFrontendUrl: string;
  /**
   * Reads `mcp-description.md` on the default branch with platform rights
   * (see modules/agent-instructions). Called on every request that needs it
   * (an `initialize`, or a `tools/list` for the tool prefix), so an edit
   * reaches the next request without a restart. Optional so constructions
   * that never exercise it (tests) keep working: without it every request
   * carries the platform header alone.
   */
  readAgentPreamble?: AgentPreambleReader;
  /** Bounds of the downstream (`mcp.json`) connection pool; defaults are 4h idle / 5000 entries. */
  downstreamPool?: Pick<DownstreamPoolOptions<unknown>, 'idleTtlMs' | 'maxEntries' | 'now'>;
}

/** Who a request is from — everything the proxy needs, resolved from that request's own bearer. */
export interface McpCaller {
  userId: string;
  /** The connection-key id (per-key metering rides on it), or null for an OAuth/JWT bearer. */
  tokenId: string | null;
  /** The raw bearer the request carried. */
  bearer: string;
}

/**
 * Upper bound on one `loopbackJson` round-trip (manual list, skill fetch) so a
 * hung loopback can't stall a request. Generous: these endpoints answer in
 * milliseconds; only a wedged process ever comes near it.
 */
const LOOPBACK_TIMEOUT_MS = 15_000;

/**
 * Lifetime of the internal token minted as an OAuth/JWT request's loopback
 * bearer. A request only needs it for as long as it runs, but one `tools/call`
 * can legitimately run for a long time (`ask`, a long `call_tool_chain`), so
 * the lifetime is generous rather than tight.
 *
 * Exported because `POST /api/mcp/local-token` (mcp.routes.ts) performs the
 * same OAuth-access-token → internal-token exchange for the LOCAL MCP server,
 * and must mint the exact same shape and lifetime — one constant, two
 * consumers, so the two bridges can never drift apart.
 */
export const MCP_LOOPBACK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

const callTemplateSerializer = new CallTemplateSerializer();

/** What one request's tool calls run against: its UTCP client and the flattened catalog. */
interface RequestSurface {
  client: CodeModeUtcpClient;
  tools: ProxiedTool[];
}

/** One pooled downstream connection: a client holding one `mcp` manual, named so it can be deregistered. */
interface PooledDownstream {
  /** Owns its own `mcp` protocol instance, so its sessions are its alone and `close()` ends exactly them. */
  client: CodeModeUtcpClient;
}

/**
 * The MCP server is a GENERIC, STATELESS proxy over the UTCP tool surface. It
 * owns no tool logic and no session: every HTTP request gets its own MCP
 * `Server`, built from that request's bearer. When the request needs tools it
 * stands up a `UtcpClient` pointed at the backend's own `GET /api/agent/all-tools`
 * catalog (over loopback, authenticated as the caller, so ACL filtering lives
 * ONCE behind the REST surface), discovers every tool, and re-exposes each one
 * to the MCP client. A tool call is dispatched straight back through the same
 * REST endpoint the tool's UTCP `tool_call_template` names — so the agent logic,
 * thread continuity, and per-key token metering all live ONCE behind that REST
 * endpoint (`AgentAskService` for `ask`), never duplicated here.
 *
 * Because nothing is held between requests, a platform restart between two
 * requests of one client conversation is undetectable by the client.
 *
 * There is NO catalog cache at this layer, deliberately: the catalog is
 * re-derived per request, and if that ever proves too slow the fix belongs in
 * the source path (all-tools/ACL), which serves every other caller too.
 *
 * The one exception to "nothing between requests" is proxied third-party MCP
 * servers (`mcp` manuals): those are session-ful by nature, so their
 * connections live in a {@link DownstreamPool} keyed by (user, manual) — lazy,
 * single-flight, idle-evicted, bounded, and healed by session recovery. Losing
 * any of it costs a reconnect, never correctness.
 *
 * Dispatch always uses `callToolStreaming`, which is uniform across tool kinds:
 * a plain `http` tool yields exactly one chunk (its final result, emitted as
 * the tool result with no progress), while a `streamable_http` tool yields many
 * (the all-but-last become `notifications/progress` on the request's own
 * response stream, the last is the result).
 *
 * Auth note: `/api/agent/*` accepts connection keys and internal tokens only.
 * Connection-key requests pass the caller's own key through to the loopback;
 * OAuth/JWT requests can't (their bearer would 401 there), so the proxy mints a
 * least-privilege internal token for the resolved user and uses THAT as the
 * request's loopback bearer instead.
 */
export class McpService {
  // Circuit breaker for manuals whose credentials just failed — see the memo.
  // Retry policy, not session state: it survives the move to statelessness.
  private readonly manualFailures = new ManualFailureMemo();
  private readonly surfaceLog = new SurfaceLogThrottle();

  // The downstream connection pool for `mcp` manuals — see the class doc.
  private readonly downstream: DownstreamPool<PooledDownstream>;

  constructor(
    private readonly opts: McpProxyOptions,
    // The vault + manual catalog, used to check a caller's per-user credentials
    // before dispatching a tool. Optional so existing constructions/tests that
    // don't exercise the check keep working (the check is skipped when absent).
    private readonly secretsVault?: ISecretsVaultService,
    private readonly toolManuals?: IToolManualService,
    // Mints the loopback bearer for OAuth/JWT requests (see class doc).
    // Optional for the same test-compat reason; without it those requests
    // fall back to the old pass-through (and 401 at the loopback hop).
    private readonly internalTokens?: InternalTokenService,
    // Revokes an MCP OAuth access token (BevelOAuthProvider.revokeByAccessToken)
    // — the reset that sends an interactive client back through the browser
    // authorization when one of its TOOL sign-ins breaks. Optional: without
    // it, broken sign-ins surface only as the /connect link in the result.
    private readonly revokeOAuthAccess?: (bearer: string) => Promise<void>,
  ) {
    this.downstream = new DownstreamPool<PooledDownstream>({
      ...opts.downstreamPool,
      // Since @utcp/sdk 1.2.0 a client closes only the protocol instances it
      // created, and @utcp/mcp registers as a factory — so this closes exactly
      // this entry's MCP sessions and touches no other client's.
      dispose: (entry) => entry.client.close(),
    });
  }

  /**
   * A secret changed — wired to the secrets vault's mutation listener.
   * `null` = a shared secret changed (affects everyone).
   *
   * Two things were built from the old value: remembered manual failures (so a
   * just-repaired credential is retried on the very next request) and pooled
   * downstream connections (dialed and discovered with the old credential).
   * Both are dropped; the next request rebuilds whatever it needs.
   */
  onSecretsChanged(userId: string | null): void {
    if (userId === null) {
      this.manualFailures.clearAll();
      this.downstream.closeAll();
      return;
    }
    this.manualFailures.clearUser(userId);
    this.downstream.evictWhere((key) => key.startsWith(`${userId}${POOL_KEY_SEPARATOR}`));
  }

  /**
   * Build the MCP `Server` for ONE request. The route connects it to a fresh
   * stateless transport, lets it answer, and closes both with the response.
   *
   * Cheap by construction: nothing is fetched up front except what the
   * request's own messages need. The agent instructions are read only when the
   * request carries an `initialize` (the only place they ride); the tool
   * catalog is built on the first handler that needs it and shared by every
   * message of the request (a JSON-RPC batch), never beyond it.
   */
  async createRequestServer(caller: McpCaller, messages: unknown): Promise<Server> {
    const { userId, tokenId, bearer } = caller;
    // The loopback surface (`/api/agent/*`) accepts connection keys and
    // internal tokens only. A connection-key request passes the caller's own
    // key through (per-key metering rides on it); an OAuth/JWT request's
    // bearer would 401 there, so mint a least-privilege internal token for
    // the resolved user instead — flagged `externalProxy` so the tool-auth
    // verifier resolves it to `source: 'external'`: the caller IS an external
    // agent and must be treated like one (admitted to `start_session`/`ask`,
    // refused from internal-only tools).
    const loopbackBearer =
      tokenId == null && this.internalTokens
        ? this.internalTokens.mint({ userId, externalProxy: true }, MCP_LOOPBACK_TOKEN_TTL_MS)
        : bearer;

    let instructions: Promise<ComposedAgentInstructions> | undefined;
    const agentInstructions = () => (instructions ??= this.composeAgentInstructions());
    let surface: Promise<RequestSurface> | undefined;
    const requestSurface = () => (surface ??= this.buildSurface(userId, tokenId, loopbackBearer));

    const initializing = (Array.isArray(messages) ? messages : [messages]).some((m) => isInitializeRequest(m));
    const server = new Server(
      { name: 'bevel-mcp', version: '0.1.0' },
      {
        capabilities: { tools: {}, prompts: {} },
        // `instructions` rides the initialize result; clients that honour it
        // place the text in the model's system prompt without the model acting.
        ...(initializing ? { instructions: (await agentInstructions()).instructions } : {}),
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const [{ tools }, { toolPrefix }] = await Promise.all([requestSurface(), agentInstructions()]);
      // A discovered tool whose name collides with a meta-tool would be
      // listed but never callable (the dispatcher routes the name to the
      // meta-tool first), so drop it from the listing entirely.
      let listed = tools.filter((t) => !META_TOOL_NAMES.has(t.mcpName));
      // Connection-key callers are autonomous pipelines — nobody is present
      // to complete a sign-in mid-run, so register ONLY the tools whose
      // per-user credentials are already satisfied. Interactive (OAuth/JWT)
      // callers keep the full listing: they can configure a tool on
      // /connect when the call-time check points them there.
      if (tokenId != null) {
        const ready = await Promise.all(
          // A per-tool check that throws must NOT reject the whole list (which
          // would blank every tool) — fail that one tool closed and move on.
          listed.map((t) =>
            this.missingUserSecrets(userId, t).then(
              (missing) => missing.length === 0,
              () => false,
            ),
          ),
        );
        listed = listed.filter((_, i) => ready[i]);
      }
      // Validate + dedupe each discovered tool so ONE non-conforming or
      // duplicate-named entry can't make an MCP client reject the whole
      // `tools/list` (blanking every tool). Every drop is logged with a reason
      // so a missing tool is diagnosable instead of silent.
      const seen = new Set(META_TOOL_NAMES);
      const dropped: string[] = [];
      const direct: McpTool[] = [];
      for (const t of listed) {
        const entry = toListedTool(t); // logs its own reason on a name/schema drop
        if (!entry) {
          dropped.push(t.mcpName);
          continue;
        }
        if (seen.has(entry.name)) {
          dropped.push(`${entry.name} (duplicate)`);
          continue;
        }
        seen.add(entry.name);
        // The four knowledge-base tools carry the purpose prefix: the one
        // pre-call channel every client shows the model, for the clients that
        // drop the handshake's `instructions`. Applied AFTER the credential
        // filter above, so a connection-key caller's listing carries it too.
        // Every other tool, meta-tools included, keeps its description as is.
        direct.push(
          PREFIXED_TOOLS.has(entry.name)
            ? { ...entry, description: prefixToolDescription(toolPrefix, entry.description) }
            : entry,
        );
      }
      // Log only when a tool was dropped (name/schema/duplicate) — that's the
      // anomaly worth surfacing, since a downstream client would otherwise hide
      // it by rejecting the whole response.
      if (dropped.length) {
        log.warn(
          `tools/list: serving ${CODE_MODE_META_TOOLS.length + direct.length} tool(s); ` +
            `dropped ${dropped.length} non-listable: ${dropped.join(', ')}`,
        );
      }
      return {
        // Code-mode meta-tools first, then every validated direct tool.
        tools: [...CODE_MODE_META_TOOLS, ...direct],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { client, tools } = await requestSurface();
      if (META_TOOL_NAMES.has(request.params.name)) {
        return this.dispatchMetaTool(client, request.params.name, request.params.arguments ?? {});
      }
      const proxied = tools.find((t) => t.mcpName === request.params.name);
      if (!proxied) {
        return toolError(retiredToolMessage(request.params.name) ?? `Unknown tool "${request.params.name}".`);
      }
      // Stop before running a tool whose personal (user-scoped) credentials the
      // caller hasn't provided — return a setup link instead of a blank-credential
      // request that would fail opaquely at the provider.
      const needsAuth = await this.checkUserSecrets(userId, proxied);
      if (needsAuth) {
        // A sign-in that EXISTS but is broken (expired grant, abandoned
        // consent, missing scopes) on an interactive OAuth caller: revoke the
        // agent's own grant too. Its next request then 401s, its refresh
        // fails, and it re-runs the browser authorization — landing the user
        // on /connect where the broken sign-in shows as not-connected, to
        // re-authorize or deselect. Never-configured tools keep the plain
        // link (revoking for those would loop on every poke at a tool the
        // user simply hasn't set up). Connection-key callers have no grant
        // to reset; the revoke no-ops on non-OAuth bearers anyway.
        if (needsAuth.brokenSignIn && tokenId == null && this.revokeOAuthAccess) {
          try {
            await this.revokeOAuthAccess(bearer);
          } catch (err) {
            log.warn('failed to reset the caller grant for re-auth:', { err });
          }
        }
        return needsAuth.result;
      }
      return this.dispatch(client, proxied, request, extra);
    });

    // Prompts = skills. Each skill becomes a user-callable prompt (slash command
    // in MCP clients). Backed by the same skill endpoints the tools use, over
    // loopback with the caller's key — so the default-branch catalog, access
    // filtering, and progressive disclosure all live ONCE behind that REST
    // surface, never duplicated here. Neither handler needs the tool catalog.
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const skills = await this.fetchSkillList(loopbackBearer);
      const prompts: Prompt[] = skills.map((s) => ({
        name: s.name,
        description: s.description,
        arguments: [],
      }));
      return { prompts };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
      const skill = await this.fetchSkill(loopbackBearer, request.params.name);
      if (!skill) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown skill "${request.params.name}".`);
      }
      return {
        description: skill.description,
        messages: [{ role: 'user', content: { type: 'text', text: skillPromptText(skill) } }],
      };
    });

    return server;
  }

  /**
   * The request's tool surface: catalog over loopback, a fresh UTCP client,
   * every manual registered (pooled for `mcp` ones), tools flattened.
   *
   * Logs one line with the time each half took — the per-request overhead
   * the stateless design trades for restart-invisibility, kept visible so it
   * is measured rather than assumed.
   */
  private async buildSurface(userId: string, tokenId: string | null, loopbackBearer: string): Promise<RequestSurface> {
    const started = performance.now();
    // The list of manuals this caller gets: the KB manual + each `.tool` they
    // can read. Fetched over loopback with the caller's key, so ACL filtering
    // lives ONCE behind the REST surface.
    const manuals = await this.fetchManualTemplates(loopbackBearer);
    const catalogMs = performance.now() - started;
    const client = await this.buildClient(loopbackBearer, userId, manuals);
    const tools = await this.discoverTools(client, manuals, userId);
    const totalMs = performance.now() - started;
    // Per user: on a shape change or once per interval, never per request —
    // see SurfaceLogThrottle for why both halves matter.
    const decision = this.surfaceLog.decide(userId, { tools: tools.length, manuals: manuals.length });
    if (decision.log) {
      log.info(
        `request surface: user=${userId} tokenId=${tokenId ?? 'none'} — ` +
          `${tools.length} tool(s) across ${manuals.length} manual(s) in ${totalMs.toFixed(0)}ms ` +
          `(catalog ${catalogMs.toFixed(0)}ms, registration ${(totalMs - catalogMs).toFixed(0)}ms)` +
          (decision.suppressed > 0 ? ` [+${decision.suppressed} identical rebuild(s) since last line]` : ''),
      );
    }
    return { client, tools };
  }

  /**
   * The instructions and tool prefix. A reader failure (a disk fault; ENOENT
   * is not one, the reader answers null for that) falls back to the header
   * alone and the fixed prefix line with a logged warning: a request never
   * fails over its preamble.
   */
  private async composeAgentInstructions(): Promise<ComposedAgentInstructions> {
    const read = this.opts.readAgentPreamble;
    if (!read) return composeAgentInstructions(null);
    try {
      return composeAgentInstructions(await read());
    } catch (err) {
      log.warn('could not read mcp-description.md; this request gets the platform header alone:', { err });
      return composeAgentInstructions(null);
    }
  }

  /** Loopback GET of the default-branch skill catalog (via the `list_skills` tool). */
  private async fetchSkillList(bearer: string): Promise<SkillSummary[]> {
    const res = await this.loopbackTool(bearer, 'list_skills', {});
    const skills = (res as { skills?: SkillSummary[] } | null)?.skills;
    return Array.isArray(skills) ? skills : [];
  }

  /** Loopback GET of one skill's body (via the `get_skill` tool); null if unavailable. */
  private async fetchSkill(bearer: string, name: string): Promise<LoadedSkill | null> {
    const res = (await this.loopbackTool(bearer, 'get_skill', { name })) as
      | { ok?: boolean; kind?: string; skill?: LoadedSkill }
      | null;
    if (res?.ok && res.kind === 'skill' && res.skill) return res.skill;
    return null;
  }

  /**
   * The ONE loopback round-trip: fetch `path` on our own REST surface with the
   * caller's bearer, parse JSON. Failures are logged under `label` (never the
   * bearer) and degrade to null — a loopback hiccup must not throw into the
   * MCP request. GET when `json` is absent, POST with a JSON body when present.
   * Bounded: a hung loopback (e.g. mid-restart) must not block a request
   * indefinitely; a timeout aborts and degrades to null like any other failure.
   */
  private async loopbackJson(bearer: string, path: string, label: string, json?: unknown): Promise<unknown> {
    try {
      const res = await fetch(`${this.opts.loopbackBaseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(json !== undefined ? { method: 'POST', body: JSON.stringify(json) } : {}),
        signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.error(`${label} loopback failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      log.error(`${label} loopback threw:`, { err });
      return null;
    }
  }

  /** POST a skill tool endpoint over loopback with the caller's bearer; parsed JSON or null. */
  private async loopbackTool(bearer: string, tool: string, body: unknown): Promise<unknown> {
    return this.loopbackJson(bearer, `/api/agent/tools/${tool}`, `skill ${tool}`, body);
  }

  /**
   * Loopback GET of the caller's manual list (KB + accessible `.tool` manuals),
   * validated into `CallTemplate`s at the boundary. The KB manual is guaranteed
   * present (a fallback covers an unavailable endpoint); a user manual that
   * fails validation is dropped + logged so one bad `.tool` can't break the
   * request. HTTP transport loses the `CallTemplate` type, so we re-validate the
   * received JSON even though the producing endpoint already validated it.
   */
  private async fetchManualTemplates(bearer: string): Promise<CallTemplate[]> {
    // This is the REMOTE proxy, so ask for remote-capable manuals only — local-only
    // `.tool`s are surfaced instead via the `list_local_tools` tool in the KB manual.
    const body = (await this.loopbackJson(bearer, '/api/agent/all-tools?remote=true', 'all-tools')) as
      | { manuals?: unknown }
      | null;
    const rawManuals: unknown[] = Array.isArray(body?.manuals) ? body.manuals : [];

    const out: CallTemplate[] = [];
    let hasKb = false;
    for (const raw of rawManuals) {
      const isKb = (raw as { name?: unknown })?.name === EXTERNAL_KB_MANUAL_NAME;
      try {
        out.push(callTemplateSerializer.validateDict(raw as Record<string, unknown>));
        if (isKb) hasKb = true;
      } catch (err) {
        const name = String((raw as { name?: unknown })?.name ?? '');
        if (isKb) throw err; // the KB manual must be valid — the core toolset depends on it
        log.warn(`skipping manual "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Always include the KB manual, even if `all-tools` was unavailable/regressed.
    if (!hasKb) out.unshift(this.kbManualTemplate());
    return out;
  }

  /** The KB manual's discovery template — the fallback if `all-tools` is unavailable. */
  private kbManualTemplate(): CallTemplate {
    return callTemplateSerializer.validateDict({
      name: EXTERNAL_KB_MANUAL_NAME,
      call_template_type: 'http',
      http_method: 'GET',
      url: '${API_URL}/api/agent/utcp',
      content_type: 'application/json',
      headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
    });
  }

  /**
   * One `CodeModeUtcpClient` per request. Reserved `API_URL`/`CONNECTION_KEY` are
   * seeded (namespaced) ONLY for Bevel-hosted manuals — the KB manual and inline
   * `.tool` sub-manuals, whose discovery template targets the loopback (`${API_URL}`).
   * Third-party http/mcp `.tool`s point at arbitrary user URLs, so we must NOT seed
   * them the caller's bearer: a malicious `.tool` referencing `${CONNECTION_KEY}`
   * would otherwise exfiltrate the caller's token to its own endpoint. Tool
   * `${SECRET}` refs resolve lazily via the per-user `bevel-secrets` loader.
   *
   * Not `close()`d: a request's client holds no connection of its own (its
   * `mcp` manuals route to the pool, so its own `mcp` protocol instance never
   * opens a session), and dropping the reference is the whole teardown.
   */
  private async buildClient(bearer: string, userId: string, manuals: CallTemplate[]): Promise<CodeModeUtcpClient> {
    const variables = seedBevelHostedManualVars(manuals, this.opts.loopbackBaseUrl, bearer);
    return CodeModeUtcpClient.create(process.cwd(), utcpClientConfig(userId, variables));
  }

  /**
   * Register EVERY manual for this request, then flatten each discovered tool
   * into the proxy's advertised shape. Manuals register concurrently — they are
   * independent, and a request pays for the slowest one rather than the sum. A
   * failure registering a user `.tool` is isolated (logged + skipped) so one
   * broken manual never breaks the request; the KB manual failing is fatal (the
   * core toolset is unusable).
   *
   * `mcp` manuals never dial from here: they are attached from the downstream
   * pool (see {@link attachDownstream}).
   *
   * Failures are memoized per (user, manual definition) for a few minutes (see
   * {@link ManualFailureMemo}): the catalog is rebuilt on every request, and a
   * manual with a broken credential (expired OAuth, revoked key) would
   * otherwise re-dial its provider on every single one. The definition's
   * fingerprint is part of the key, so a manual edited after a failure (a
   * corrected `mcp.json` URL) is tried on the very next request.
   */
  private async discoverTools(
    client: CodeModeUtcpClient,
    manuals: CallTemplate[],
    userId: string,
  ): Promise<ProxiedTool[]> {
    const routes = new Map<string, () => Promise<Lease<PooledDownstream>>>();
    // The shared layer rewrites every manual name (`[^\w]` → `_`) and tools
    // route by the rewritten prefix, so two manuals whose names rewrite to one
    // identifier would silently share it. Sequential registration used to
    // throw "already registered" for the second; concurrent registration
    // (below) would let both pass the shared layer's pre-check, one
    // overwriting the other in the repository while `routes` kept whichever
    // resolved last — tools/list from one server, tools/call to the other.
    // Decided here, over the whole list, before anything is registered: every
    // manual in a colliding group fails with a message naming the others. The
    // KB manual always keeps its name — a `.tool` colliding with it fails,
    // the KB manual does not.
    const byRewrittenName = new Map<string, string[]>();
    for (const m of manuals) {
      const rewritten = utcpManualName(m);
      byRewrittenName.set(rewritten, [...(byRewrittenName.get(rewritten) ?? []), String(m.name)]);
    }
    const outcomes = await Promise.all(
      manuals.map(async (m) => {
        const isKb = m.name === EXTERNAL_KB_MANUAL_NAME;
        const name = String(m.name);
        // Both taken before registration, which renames the template in place.
        const rewritten = utcpManualName(m);
        const siblings = (byRewrittenName.get(rewritten) ?? []).filter((s) => s !== name);
        // A collision is a property of the LIST, not of this manual's
        // definition, so the memo key carries the siblings: the moment one is
        // renamed away, the key changes and the survivor is tried on the very
        // next request instead of sitting out the memo's TTL.
        const memoKey =
          `${name}${POOL_KEY_SEPARATOR}${templateFingerprint(m)}` +
          (siblings.length > 0 ? `${POOL_KEY_SEPARATOR}collides:${[...siblings].sort().join(',')}` : '');
        if (!isKb) {
          const recent = this.manualFailures.recentFailure(userId, memoKey);
          if (recent !== undefined) {
            log.warn(`skipping manual "${name}" (recent failure, not retried): ${recent}`);
            return { isKb, ok: true as const };
          }
        }
        // Begun BEFORE the awaited attempt: if a secrets change (or a
        // concurrent success of this same manual) clears the memo while
        // registration is in flight, the stale failure must not resurrect an
        // entry the clear removed.
        const generation = this.manualFailures.beginAttempt();
        try {
          // Neither path throws: a discovery/network failure and a validation
          // failure both come back as `{ ok: false }`, because the retry
          // policy — this memo — is ours, not the shared layer's.
          const result: { ok: true } | { ok: false; error: string } =
            !isKb && siblings.length > 0
              ? {
                  ok: false,
                  error:
                    `manual name "${name}" rewrites to "${rewritten}", the same identifier as ` +
                    `${siblings.map((s) => `"${s}"`).join(', ')} — rename one; a colliding manual is not registered`,
                }
              : m.call_template_type === 'mcp'
                ? await this.attachDownstream(client, m, userId, routes)
                : await registerManual(client, m);
          if (!result.ok) {
            if (isKb) return { isKb, ok: false as const, error: result.error };
            this.manualFailures.recordFailure(userId, memoKey, result.error, generation);
            log.warn(`skipping manual "${name}": ${result.error}`);
          } else if (!isKb) {
            this.manualFailures.clear(userId, memoKey);
          }
        } finally {
          this.manualFailures.endAttempt(generation);
        }
        return { isKb, ok: true as const };
      }),
    );
    const kbFailure = outcomes.find((o) => o.isKb && !o.ok);
    if (kbFailure && !kbFailure.ok) throw new Error(`Bevel tool discovery failed: ${kbFailure.error}`);
    if (routes.size > 0) routeToDownstream(client, routes);
    const utcpTools = await client.getTools();
    return utcpTools.map((tool: UtcpTool) => flattenManualTool(tool, EXTERNAL_KB_MANUAL_NAME));
  }

  /**
   * Make one `mcp` manual's tools part of this request's client, backed by the
   * pooled connection for (user, manual).
   *
   * The pooled client's discovered tools are copied into the request client's
   * repository — so `tools/list`, `list_tools`/`tools_info` and the TypeScript
   * interfaces `call_tool_chain` generates all see them exactly as if they had
   * been registered here — and `routes` records that calls to this manual go to
   * the pool. The route re-acquires at CALL time rather than holding the pooled
   * client, so an entry evicted between discovery and the call is transparently
   * re-created instead of used after its connection was closed. Each use holds
   * a pool lease only for its own duration, so the pool never closes a
   * connection an operation is still using.
   */
  private async attachDownstream(
    client: CodeModeUtcpClient,
    template: CallTemplate,
    userId: string,
    routes: Map<string, () => Promise<Lease<PooledDownstream>>>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const key = downstreamPoolKey(userId, template);
    const acquire = () => this.downstream.acquire(key, () => this.connectDownstream(userId, template));
    try {
      const lease = await acquire();
      const manualName = utcpManualName(template);
      try {
        const tools = (await lease.value.client.getTools()).filter((t) => t.name.startsWith(`${manualName}.`));
        await client.config.tool_repository.saveManual(
          { ...template, name: manualName },
          UtcpManualSchema.parse({ tools }),
        );
      } finally {
        lease.release();
      }
      routes.set(manualName, acquire);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Create one pooled downstream connection: a client registering just this
   * manual.
   *
   * `@utcp/mcp` (1.2.0+) registers its protocol as a FACTORY, so this client
   * gets an `mcp` protocol instance of its own: the session it opens lives in
   * that instance, is reachable from no other client, and ends with
   * `client.close()`. That is what makes a pool entry per (user, server) an
   * actual isolation boundary — two users with byte-identical server
   * definitions still never share a connection — with nothing reached into.
   *
   * SESSION RECOVERY is installed on the pooled client: a downstream server
   * that restarts (or expires a session) answers our next call with the spec's
   * 404/`-32001`, and recovery re-registers in place and retries once. It is
   * deliberately clear of {@link ManualFailureMemo}: that memo is a circuit
   * breaker for manuals whose REGISTRATION failed, so a recovery neither
   * consults it nor records into it.
   *
   * A registration that fails closes the client it built (ending whatever the
   * attempt opened) and throws, so the pool caches nothing and the caller's
   * memo records the failure.
   */
  private async connectDownstream(userId: string, template: CallTemplate): Promise<PooledDownstream> {
    // Third-party manuals are never seeded loopback credentials (see
    // `buildClient`), so a pooled client carries no request-scoped bearer.
    const client = await CodeModeUtcpClient.create(process.cwd(), utcpClientConfig(userId, {}));
    // Our own copy: registration renames the template in place, and recovery
    // re-registers from exactly what discovery used.
    const own = structuredClone(template);
    const manualName = utcpManualName(own);
    installSessionRecovery(client, { manualTemplate: (name) => (name === manualName ? own : undefined) });
    const result = await registerManual(client, own);
    if (!result.ok) {
      await client.close().catch(() => {});
      throw new Error(result.error);
    }
    return { client };
  }

  /**
   * If the tool declares per-user credentials the caller hasn't set, return a
   * needs-authorization result (naming the tool + a setup link); otherwise null
   * to proceed. Reads the manual's `user`-scoped variables and asks the vault,
   * with the SAME keys `resolve` uses, which the caller has configured — so the
   * check can't drift from the actual resolution. A no-op when the vault/manual
   * services aren't wired, or the tool's manual declares no per-user credential
   * (e.g. the built-in KB tools).
   */
  private async checkUserSecrets(
    userId: string,
    tool: ProxiedTool,
  ): Promise<{ result: CallToolResult; brokenSignIn: boolean } | null> {
    const missing = await this.missingUserSecrets(userId, tool);
    if (missing.length === 0) return null;
    return {
      result: needsAuthorizationResult(
        tool.mcpName,
        missing.map((v) => v.label ?? v.name),
        `${this.opts.publicFrontendUrl}/connect`,
      ),
      // At least one missing item is a sign-in the caller already HAS a row
      // for (dead grant, abandoned consent, or missing scopes) — the state
      // that warrants resetting an interactive client for re-auth, as
      // opposed to a tool the caller never set up at all.
      brokenSignIn: missing.some((v) => v.brokenSignIn),
    };
  }

  /**
   * The per-user variables of `tool`'s manual the caller has NOT satisfied.
   * Shared by the call-time needs-authorization check above and the
   * listing-time filter for connection-key callers (which registers only
   * ready tools). Empty when the vault/manual services aren't wired or the
   * manual declares no per-user credential.
   */
  private async missingUserSecrets(
    userId: string,
    tool: ProxiedTool,
  ): Promise<{ name: string; label?: string | null; brokenSignIn: boolean }[]> {
    if (!this.secretsVault || !this.toolManuals || !tool.manualName) return [];
    const userVars = await this.toolManuals.userScopedKeysForManual(tool.manualName);
    if (userVars.length === 0) return [];
    const status = await this.secretsVault.statusFor(
      userId,
      userVars.map((v) => v.key),
    );
    const statusMap = new Map(status.map((s) => [s.key, s]));
    const missing: { name: string; label?: string | null; brokenSignIn: boolean }[] = [];
    for (const v of userVars) {
      const st = statusMap.get(v.key);
      // A sign-in the caller already HAS a row for but that isn't (or is no
      // longer) usable: dead/wiped grant, abandoned consent, missing scopes.
      const brokenSignIn = Boolean(v.oauth && st?.userConfigured);
      if (!st?.userConfigured) {
        missing.push({ name: v.name, label: v.label, brokenSignIn }); // no row at all → needs a value / sign-in
        continue;
      }
      // An OAuth-backed var whose row exists but has no token yet is NOT ready —
      // the user has registered but not completed sign-in. Fail closed: anything
      // other than a confirmed `true` (including a non-oauth row → undefined)
      // counts as not-yet-authorized.
      if (v.oauth && st.userAuthorized !== true) {
        missing.push({ name: v.name, label: v.label, brokenSignIn });
        continue;
      }
      // An OAuth-backed var the user signed in for, but whose token was granted
      // fewer scopes than the tool now declares, is ALSO not ready — the call would
      // otherwise fail opaquely at the provider. Compare the live required scopes
      // against the token's recorded granted scopes; an under-scoped (or unknown)
      // token needs re-authorization.
      if (v.oauth && !scopesCovered(v.oauthScopes, st.grantedScopes)) {
        missing.push({ name: v.name, label: v.label, brokenSignIn });
      }
    }
    return missing;
  }

  /**
   * Run one tool call through `callToolStreaming` with a one-chunk lookahead:
   * every chunk except the last becomes a progress notification — sent on THIS
   * request's own response stream — and the last is the result. Continuity is
   * the caller's: a tool that supports it (e.g. `ask`) returns its `sessionId`
   * in the result verbatim, and the caller echoes it back per the tool's own
   * schema — the proxy never rewrites args.
   */
  private async dispatch(
    client: CodeModeUtcpClient,
    tool: ProxiedTool,
    request: { params: { arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } } },
    // `sendNotification` typed loosely (`any`) so a `notifications/progress`
    // payload without a `progressToken` is accepted — same approach the prior
    // handler used; the strict ServerNotification type requires the token.
    extra: { sendNotification: (n: any) => Promise<void> },
  ): Promise<CallToolResult> {
    const progressToken = request.params._meta?.progressToken;
    return dispatchToolCall(client, tool, request.params.arguments ?? {}, (progress, message) =>
      extra.sendNotification({
        method: 'notifications/progress',
        params: {
          ...(progressToken !== undefined ? { progressToken } : {}),
          progress,
          message,
        },
      }),
    );
  }

  /**
   * Handle a code-mode meta-tool. The shared implementation reflects on this
   * request's client, so `list_tools`/`tools_info` describe exactly the catalog
   * this request discovered and `call_tool_chain` runs in that client's
   * isolated-vm — resolving over loopback with the caller's key. The workspace
   * spill store is passed in so an oversized chain result comes back as a
   * `read_file`-able ref rather than a wall of JSON.
   */
  private async dispatchMetaTool(
    client: CodeModeUtcpClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return dispatchMetaTool(client, name, args, this.opts.spillStore);
  }
}

/**
 * The UTCP client config for `userId`: the given variables, plus the per-user
 * `bevel-secrets` loader that resolves every `${SECRET}` ref lazily. Shared by
 * request clients and pooled downstream clients, so both resolve a manual's
 * variables through exactly the same tiers.
 */
function utcpClientConfig(userId: string, variables: Record<string, string>) {
  return new UtcpClientConfigSerializer().validateDict({
    variables,
    load_variables_from: [bevelSecretsLoaderConfig(userId)],
  });
}

/**
 * The name a manual is registered under. `UtcpClient.registerManual` rewrites
 * every non-word character to `_`, and tool names are prefixed with the result,
 * so routing has to key on the same rewrite.
 */
function utcpManualName(template: CallTemplate): string {
  return String(template.name ?? '').replace(/[^\w]/g, '_');
}

/**
 * The pool key for (user, manual). The template's fingerprint is part of it, so
 * an edited `mcp.json` (new URL, new headers) gets a new connection rather than
 * the one dialed for the old definition, which simply idles out. Hashed: the
 * template can carry credentials and the key must stay log-safe.
 */
function downstreamPoolKey(userId: string, template: CallTemplate): string {
  return [userId, utcpManualName(template), templateFingerprint(template)].join(POOL_KEY_SEPARATOR);
}

/** A short, log-safe hash of a manual's whole definition: changes whenever the definition does. */
function templateFingerprint(template: CallTemplate): string {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex').slice(0, 16);
}

/**
 * Route tool calls for pooled manuals to their pooled client, in place on the
 * request client. Both entry points are wrapped — `callToolStreaming` is the
 * MCP dispatch path, `callTool` is what `call_tool_chain` bridges every
 * in-isolate tool function to — so the two can never disagree. Every other
 * manual's calls go through the request client unchanged.
 *
 * Each routed call holds its pool lease until the call ends — for a stream,
 * until the consumer finishes or abandons it (`for await` returns the
 * generator, which runs the `finally`).
 */
function routeToDownstream(
  client: CodeModeUtcpClient,
  routes: ReadonlyMap<string, () => Promise<Lease<PooledDownstream>>>,
): void {
  const callTool = client.callTool.bind(client);
  const callToolStreaming = client.callToolStreaming.bind(client);
  const routeOf = (toolName: string) => routes.get(toolName.split('.')[0] ?? '');

  client.callTool = async function routedCallTool(toolName: string, toolArgs: Record<string, unknown>) {
    const route = routeOf(toolName);
    if (!route) return callTool(toolName, toolArgs);
    const lease = await route();
    try {
      return await lease.value.client.callTool(toolName, toolArgs);
    } finally {
      lease.release();
    }
  };
  client.callToolStreaming = async function* routedCallToolStreaming(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): AsyncGenerator<unknown, void, unknown> {
    const route = routeOf(toolName);
    if (!route) {
      yield* callToolStreaming(toolName, toolArgs);
      return;
    }
    const lease = await route();
    try {
      yield* lease.value.client.callToolStreaming(toolName, toolArgs);
    } finally {
      lease.release();
    }
  };
}

/**
 * The pieces of the proxy that are shared with the local MCP server now live in
 * `@bevel-software/platform-mcp-core`. Re-exported here because this module is
 * where they have always been imported from — inside this package and by its
 * tests — and moving a file is not a reason to churn every call site.
 */
export {
  type ProxiedTool,
  toListedTool,
  sanitizeInputSchema,
  flattenManualTool,
  flattenDiscoveredTool,
  describeToolFailure,
  toCallToolResult,
  needsAuthorizationResult,
} from '@bevel-software/platform-mcp-core';
