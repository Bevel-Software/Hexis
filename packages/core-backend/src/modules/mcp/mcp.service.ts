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
  needsAuthorizationResult,
  skillPromptText,
  type ProxiedTool,
  type SkillSummary,
  type LoadedSkill,
} from '@bevel-software/platform-mcp-core';
import { bevelSecretsLoaderConfig } from '../secrets-vault/index.js';
import {
  scopesCovered,
  type ForcedRefreshOutcome,
  type ISecretsVaultService,
} from '../secrets-vault/secrets-vault.contract.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import type { SpillStore } from '../workspace/spill-store.js';
import { seedBevelHostedManualVars } from '../../shared/utcp-namespace.js';
import type { InternalTokenService } from '../tool-auth/internal-token.service.js';
import { ManualFailureMemo } from './manual-failure-memo.js';
import { DownstreamPool, POOL_KEY_SEPARATOR, type DownstreamPoolOptions, type Lease } from './downstream-pool.js';
import { SurfaceLogThrottle } from './surface-log-throttle.js';
import { DownstreamRefreshGuard, isDownstreamTokenRejection } from './downstream-token-refresh.js';
import { printable } from '../../shared/printable.js';
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
  /**
   * Pooled manuals the caller may use but whose tools could not be put on the
   * surface because the caller's sign-in for them is missing or broken AND no
   * tool definitions were ever discovered for them in this process. A call to
   * one of their tools is answered with the /connect link, not "Unknown tool".
   */
  unavailable: UnavailableManual[];
}

/** A manual off the surface for want of a sign-in — see {@link RequestSurface.unavailable}. */
interface UnavailableManual {
  /** The name as registered (`utcpManualName`): tools of it are `<utcpName>_<tool>` on the wire. */
  utcpName: string;
}

/**
 * How a pooled manual's calls are served: lease its pooled connection, and —
 * when a call fails — decide whether a token refresh warrants one retry
 * ({@link RETRY_WITH_REFRESHED_TOKEN}) or which error the caller gets.
 */
interface DownstreamRoute {
  acquire: () => Promise<Lease<PooledDownstream>>;
  afterFailure: (err: unknown) => Promise<unknown>;
}

/**
 * What a failed downstream operation turned out to be, for the code that has
 * to decide more than "retry or throw" — see {@link McpService.attachDownstream}.
 */
type DownstreamFailure =
  | { retry: true }
  /** `credentialTransient`: a token rejection whose refresh could not be settled (network, 5xx, or the once-a-minute guard), so the very next call should try again rather than being written off. */
  | { retry: false; error: unknown; credentialTransient: boolean };

/** The {@link DownstreamRoute.afterFailure} answer that means "refreshed — retry once". */
const RETRY_WITH_REFRESHED_TOKEN = Symbol('retry-with-refreshed-token');

/**
 * What attaching one pooled manual to a request came to. `retryable`: do not
 * remember this failure (it may clear on its own within the minute).
 * `signInMissing`: the caller has no usable sign-in for the manual and this
 * process has never seen its tools — the manual goes on the request's
 * {@link RequestSurface.unavailable} list so a call still gets the sign-in link.
 */
type DownstreamAttachResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean; signInMissing?: boolean };

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
  // One forced token refresh per (user, manual) per minute — see downstream-token-refresh.
  private readonly tokenRefreshes: DownstreamRefreshGuard<ForcedRefreshOutcome>;
  /**
   * The tools each pooled manual last advertised, by manual definition. A
   * downstream can only be asked what its tools are over a connection, and a
   * caller whose sign-in is missing or broken has no connection — so their
   * tools would silently vanish from the surface, and a call would answer
   * "Unknown tool" instead of "sign in again on /connect". These definitions
   * keep the manual on the surface for such a caller; the call-time credential
   * check then answers with the link, and an interactive client is sent back
   * through authorization. Definitions, never credentials or results, and
   * bounded by the number of distinct manual definitions the process has seen.
   */
  private readonly knownDownstreamTools = new Map<string, UtcpTool[]>();

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
    // Paced on the pool's clock, so a test that moves one moves both.
    this.tokenRefreshes = new DownstreamRefreshGuard(undefined, opts.downstreamPool?.now);
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
    this.forgetStaleRefreshWindows(userId);
    if (userId === null) {
      this.manualFailures.clearAll();
      this.downstream.closeAll();
      return;
    }
    this.manualFailures.clearUser(userId);
    this.downstream.evictWhere((key) => key.startsWith(`${userId}${POOL_KEY_SEPARATOR}`));
  }

  /**
   * A credential changed, so a refresh window that FAILED to produce one no
   * longer describes anything: a token the user has just re-authorized (or an
   * admin has just re-keyed) must be tried on the very next rejection, not sit
   * out the remainder of a minute earned by the credential it replaced.
   *
   * Only settled, non-`refreshed` windows are forgotten. A refresh of our own
   * is itself a secrets mutation, and clearing on that would hand a provider
   * that keeps minting tokens the downstream keeps refusing one refresh per
   * call — precisely the loop the once-a-minute guard exists to bound. An
   * in-flight attempt (no outcome yet) is left alone for the same reason: it
   * may be the very refresh that raised this notification.
   */
  private forgetStaleRefreshWindows(userId: string | null): void {
    const mine = (key: string) => userId === null || key.startsWith(`${userId}${POOL_KEY_SEPARATOR}`);
    this.tokenRefreshes.clearWhere(
      (key, outcome) => mine(key) && outcome !== undefined && outcome !== 'refreshed',
    );
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
            this.missingUserSecrets(userId, t.manualName).then(
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
      const { client, tools, unavailable } = await requestSurface();
      const toolName = request.params.name;
      if (META_TOOL_NAMES.has(toolName)) {
        return this.dispatchMetaTool(client, toolName, request.params.arguments ?? {});
      }
      /**
       * The needs-authorization answer, when the caller's sign-in for
       * `manualName` is missing or broken; `null` to proceed. Stops before
       * running a tool whose personal (user-scoped) credentials the caller
       * hasn't provided — a setup link instead of a blank-credential request
       * that would fail opaquely at the provider.
       */
      const needsAuthorization = async (manualName: string): Promise<CallToolResult | null> => {
        const needsAuth = await this.checkUserSecrets(userId, toolName, manualName);
        if (!needsAuth) return null;
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
      };
      const proxied = tools.find((t) => t.mcpName === toolName);
      if (!proxied) {
        // Not on the surface — but if the name belongs to a manual that is off
        // it only because this caller's sign-in is gone (and nothing in this
        // process has seen its tools yet), the honest answer is the sign-in
        // link, exactly as if the tool were listed. Longest matching prefix:
        // manual names may themselves contain underscores.
        const owner = unavailable
          .filter((m) => toolName.startsWith(`${m.utcpName}_`))
          .sort((a, b) => b.utcpName.length - a.utcpName.length)[0];
        const answer = owner ? await needsAuthorization(owner.utcpName) : null;
        return answer ?? toolError(`Unknown tool "${toolName}".`);
      }
      const needsAuth = await needsAuthorization(proxied.manualName);
      if (needsAuth) return needsAuth;
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
    const { tools, unavailable } = await this.discoverTools(client, manuals, userId);
    const totalMs = performance.now() - started;
    // Per user: on a shape change or once per interval, never per request —
    // see SurfaceLogThrottle for why both halves matter.
    const decision = this.surfaceLog.decide(userId, { tools: tools.length, manuals: manuals.length });
    if (decision.log) {
      log.info(
        // Both ids come from the request (an identity provider's subject, a
        // connection key's id), so neither is interpolated raw — see printable.
        `request surface: user=${printable(userId)} tokenId=${tokenId ? printable(tokenId) : 'none'} — ` +
          `${tools.length} tool(s) across ${manuals.length} manual(s) in ${totalMs.toFixed(0)}ms ` +
          `(catalog ${catalogMs.toFixed(0)}ms, registration ${(totalMs - catalogMs).toFixed(0)}ms)` +
          (decision.suppressed > 0 ? ` [+${decision.suppressed} identical rebuild(s) since last line]` : ''),
      );
    }
    return { client, tools, unavailable };
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
  ): Promise<{ tools: ProxiedTool[]; unavailable: UnavailableManual[] }> {
    const routes = new Map<string, DownstreamRoute>();
    const unavailable: UnavailableManual[] = [];
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
          const result: DownstreamAttachResult =
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
            // A failure the manual may recover from on its own schedule (a
            // token refresh that hasn't settled) is reported but NOT
            // remembered: the memo's five minutes would outlast the refresh
            // policy's one and hold the manual down after the provider is back.
            if (!result.retryable) this.manualFailures.recordFailure(userId, memoKey, result.error, generation);
            if (result.signInMissing) unavailable.push({ utcpName: rewritten });
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
    return { tools: utcpTools.map((tool: UtcpTool) => flattenManualTool(tool, EXTERNAL_KB_MANUAL_NAME)), unavailable };
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
    routes: Map<string, DownstreamRoute>,
  ): Promise<DownstreamAttachResult> {
    const key = downstreamPoolKey(userId, template);
    // The catalog name, which is what the manual's per-user variables are keyed by.
    const catalogName = String(template.name ?? '');
    const manualName = utcpManualName(template);
    const definition = templateFingerprint(template);
    const acquire = () => this.downstream.acquire(key, () => this.connectDownstream(userId, template));
    const afterFailure = (err: unknown) => this.afterDownstreamFailure(userId, catalogName, key, err);
    const attach = async (tools: UtcpTool[]) => {
      await client.config.tool_repository.saveManual({ ...template, name: manualName }, UtcpManualSchema.parse({ tools }));
      routes.set(manualName, { acquire, afterFailure });
    };
    // Set when the handshake failed on a credential the provider may yet
    // renew: the caller must NOT remember that as a dead manual (see below).
    let credentialTransient = false;
    try {
      let lease: Lease<PooledDownstream>;
      try {
        lease = await acquire();
      } catch (err) {
        // A connection dialed with a token the server refuses fails right here,
        // at the handshake — the same refresh-and-retry applies.
        const verdict = await this.classifyDownstreamFailure(userId, catalogName, key, err);
        if (!verdict.retry) {
          credentialTransient = verdict.credentialTransient;
          throw verdict.error;
        }
        lease = await acquire();
      }
      let tools: UtcpTool[];
      try {
        tools = (await lease.value.client.getTools()).filter((t) => t.name.startsWith(`${manualName}.`));
      } finally {
        lease.release();
      }
      this.knownDownstreamTools.set(definition, tools);
      await attach(tools);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // No connection because this CALLER has no usable sign-in for the manual
      // (never signed in, or the grant was just found dead and wiped): the
      // manual is not broken, the sign-in is. Keep its tools on the surface
      // from what the downstream last advertised, so a call answers with the
      // sign-in link — and never remember the failure, since re-authorizing is
      // one visit to /connect away and the next attempt costs no network.
      if (await this.signInMissing(userId, manualName)) {
        const known = this.knownDownstreamTools.get(definition);
        if (known) {
          await attach(known);
          return { ok: true };
        }
        return { ok: false, error, retryable: true, signInMissing: true };
      }
      // `retryable` keeps a transient credential failure out of the caller's
      // five-minute failure memo: the refresh-and-retry policy for a rejected
      // token is one minute, and a memo entry would silently outlast it.
      return { ok: false, error, retryable: credentialTransient };
    }
  }

  /** Whether the caller's sign-in for `manualName` is missing or broken — a check that must never throw here. */
  private async signInMissing(userId: string, manualName: string): Promise<boolean> {
    try {
      return (await this.missingUserSecrets(userId, manualName)).length > 0;
    } catch {
      return false;
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
   * A pooled manual's operation failed: may it be retried with a refreshed
   * token? Answers {@link RETRY_WITH_REFRESHED_TOKEN} when so, otherwise the
   * error the caller should see.
   *
   * Only a token rejection (401 / `invalid_token`) qualifies. Then the
   * caller's OAuth token for this manual is refreshed once, ignoring its
   * stored expiry, and:
   *   - refreshed → the pooled connection (dialed with the dead token) is
   *     dropped and the operation retried once, on a fresh one;
   *   - rejected → the grant is gone and the vault has wiped it; the caller is
   *     told to re-authorize on /connect, where it now shows as not connected;
   *   - transient, or no refresh allowed / possible → the original error.
   */
  private async afterDownstreamFailure(
    userId: string,
    manualName: string,
    poolKey: string,
    err: unknown,
  ): Promise<unknown> {
    const verdict = await this.classifyDownstreamFailure(userId, manualName, poolKey, err);
    return verdict.retry ? RETRY_WITH_REFRESHED_TOKEN : verdict.error;
  }

  /** {@link afterDownstreamFailure}, keeping the one distinction its symbol-or-error answer drops. */
  private async classifyDownstreamFailure(
    userId: string,
    manualName: string,
    poolKey: string,
    err: unknown,
  ): Promise<DownstreamFailure> {
    if (!isDownstreamTokenRejection(err)) return { retry: false, error: err, credentialTransient: false };
    const outcome = await this.refreshDownstreamToken(userId, manualName);
    if (outcome === 'refreshed') {
      // The vault's mutation signal evicts this user's connections too; doing it
      // here as well keeps the retry correct whether or not that is wired.
      this.downstream.evictWhere((k) => k === poolKey);
      return { retry: true };
    }
    if (outcome === 'rejected') {
      // The connection was dialed with a grant that no longer exists; the
      // vault's mutation signal drops it too, this keeps the next request
      // honest whether or not that is wired.
      this.downstream.evictWhere((k) => k === poolKey);
      return {
        retry: false,
        credentialTransient: false,
        error: new Error(
          `Your sign-in for "${manualName}" was rejected and has been disconnected. ` +
            `Re-authorize it on ${this.opts.publicFrontendUrl}/connect, then run the tool again.`,
        ),
      };
    }
    // The token stands and so does the call's own error. Whether the NEXT
    // call may try again depends on why: a refresh that failed transiently, or
    // one the window refused, will be worth attempting shortly — while
    // "nothing here to refresh" (no vault, no OAuth variable, no stored token)
    // is a standing condition, and the failure memo should hold the manual
    // down exactly as it does for any other broken credential.
    const mayRecoverSoon = outcome === 'transient' || outcome === 'guarded';
    return { retry: false, error: err, credentialTransient: mayRecoverSoon };
  }

  /**
   * Force-refresh the caller's OAuth token(s) for `manualName`, at most once per
   * (user, manual) per minute. Logs ONE line per attempt — manual, user,
   * outcome, never token material.
   *
   * `'guarded'` when the window refused this one (a refresh just ran, or is
   * running, for this pair); `undefined` when there was nothing to refresh at
   * all: no vault wired, or no OAuth variable on the manual. The two are not
   * the same thing to the caller — see {@link classifyDownstreamFailure}.
   */
  private async refreshDownstreamToken(
    userId: string,
    manualName: string,
  ): Promise<ForcedRefreshOutcome | 'guarded' | undefined> {
    const vault = this.secretsVault;
    if (!vault || !this.toolManuals || !manualName) return undefined;
    let keys: string[];
    try {
      keys = (await this.toolManuals.userScopedKeysForManual(manualName)).filter((v) => v.oauth).map((v) => v.key);
    } catch (err) {
      // The error's own message is caller-controlled as well (it quotes the
      // manual, and may quote a provider's reply), and a raw Error handed to
      // the logger renders its message and stack verbatim — so it goes through
      // the same escaper rather than travelling as an object.
      log.warn(
        `downstream token refresh: could not read the variables of manual=${printable(manualName)}: ` +
          printable(err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }
    if (keys.length === 0) return undefined;
    const attempt = this.tokenRefreshes.run(`${userId}${POOL_KEY_SEPARATOR}${manualName}`, async () => {
      const outcomes: ForcedRefreshOutcome[] = [];
      for (const key of keys) {
        // A vault fault is not a verdict on the grant: keep the token, try later.
        outcomes.push(await vault.forceRefresh(userId, key).catch((): ForcedRefreshOutcome => 'transient'));
      }
      const outcome: ForcedRefreshOutcome = outcomes.includes('rejected')
        ? 'rejected'
        : outcomes.includes('transient')
          ? 'transient'
          : outcomes.includes('refreshed')
            ? 'refreshed'
            : 'skipped';
      if (outcome !== 'skipped') {
        // Both values reach the log from outside (a catalog name, an identity
        // provider's id), so both are escaped: one event stays one line.
        log.info(
          `downstream token refresh: manual=${printable(manualName)} user=${printable(userId)} outcome=${outcome}`,
        );
      }
      return outcome;
    });
    return attempt ? await attempt : 'guarded';
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
    toolName: string,
    manualName: string,
  ): Promise<{ result: CallToolResult; brokenSignIn: boolean } | null> {
    const missing = await this.missingUserSecrets(userId, manualName);
    if (missing.length === 0) return null;
    return {
      result: needsAuthorizationResult(
        toolName,
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
    manualName: string,
  ): Promise<{ name: string; label?: string | null; brokenSignIn: boolean }[]> {
    if (!this.secretsVault || !this.toolManuals || !manualName) return [];
    const userVars = await this.toolManuals.userScopedKeysForManual(manualName);
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
 *
 * A call the downstream refuses for its token (401 / `invalid_token`) goes to
 * the route's `afterFailure`, which may refresh the token and ask for ONE retry
 * on a fresh connection. Retrying is safe for the same reason session recovery
 * is: authentication is decided before the request reaches a tool, so the
 * refused attempt ran nothing.
 */
function routeToDownstream(client: CodeModeUtcpClient, routes: ReadonlyMap<string, DownstreamRoute>): void {
  const callTool = client.callTool.bind(client);
  const callToolStreaming = client.callToolStreaming.bind(client);
  const routeOf = (toolName: string) => routes.get(toolName.split('.')[0] ?? '');

  client.callTool = async function routedCallTool(toolName: string, toolArgs: Record<string, unknown>) {
    const route = routeOf(toolName);
    if (!route) return callTool(toolName, toolArgs);
    const once = async () => {
      const lease = await route.acquire();
      try {
        return await lease.value.client.callTool(toolName, toolArgs);
      } finally {
        lease.release();
      }
    };
    try {
      return await once();
    } catch (err) {
      const next = await route.afterFailure(err);
      if (next !== RETRY_WITH_REFRESHED_TOKEN) throw next;
      // Exactly one retry: whatever it produces is what the caller sees.
      return await once();
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
    const once = async function* () {
      const lease = await route.acquire();
      try {
        yield* lease.value.client.callToolStreaming(toolName, toolArgs);
      } finally {
        lease.release();
      }
    };
    let yielded = false;
    try {
      for await (const chunk of once()) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      // A stream that already produced output was accepted — a rejection can
      // only come before the first chunk, and replaying would duplicate output.
      if (yielded) throw err;
      const next = await route.afterFailure(err);
      if (next !== RETRY_WITH_REFRESHED_TOKEN) throw next;
    }
    yield* once();
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
