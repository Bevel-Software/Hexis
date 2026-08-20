import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
import '@utcp/mcp'; // side effect: registers the 'mcp' protocol (native MCP-server `.tool` sources)
import {
  UtcpClientConfigSerializer,
  CallTemplateSerializer,
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
import { scopesCovered, type ISecretsVaultService } from '../secrets-vault/secrets-vault.contract.js';
import { EXTERNAL_KB_MANUAL_NAME } from '../tool-manuals/tool-manuals.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import type { SpillStore } from '../workspace/spill-store.js';
import { seedBevelHostedManualVars } from '../../shared/utcp-namespace.js';
import type { McpSessionStore } from './mcp-session-store.js';
import type { InternalTokenService } from '../tool-auth/internal-token.service.js';
import { ManualFailureMemo } from './manual-failure-memo.js';

/**
 * Configuration for the loopback proxy. `loopbackBaseUrl` is the backend's own
 * address (`http://127.0.0.1:<port>`) and `manualName` is BOTH the UTCP manual
 * namespace the per-session client registers under AND the prefix its `${VAR}`
 * placeholders resolve through (`<manualName>_API_URL` / `_CONNECTION_KEY`).
 */
export interface McpProxyOptions {
  loopbackBaseUrl: string;
  manualName: string;
  /** Shared spill store for oversized `call_tool_chain` results (parity with the in-process agent). */
  spillStore: SpillStore;
  /** Public web address of the frontend, for the needs-authorization setup link. */
  publicFrontendUrl: string;
}

/**
 * Upper bound on one `loopbackJson` round-trip (manual list, skill fetch) so a
 * hung loopback can't stall `createSession`. Generous: these endpoints answer
 * in milliseconds; only a wedged process ever comes near it.
 */
const LOOPBACK_TIMEOUT_MS = 15_000;

/**
 * Lifetime of the internal token minted as an OAuth/JWT session's loopback
 * bearer. Longer than the session store's 4h idle eviction (see
 * `DEFAULT_IDLE_TTL_MS` in mcp-session-store.ts) so the credential is not the
 * first thing to die under a session's normal lifecycle. A continuously-active
 * session CAN outlive it — its tool calls then fail at the loopback and the
 * client recovers by re-initializing, which mints a fresh token.
 *
 * Exported because `POST /api/mcp/local-token` (mcp.routes.ts) performs the
 * same OAuth-access-token → internal-token exchange for the LOCAL MCP server,
 * and must mint the exact same shape and lifetime — one constant, two
 * consumers, so the two bridges can never drift apart.
 */
export const MCP_LOOPBACK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

const callTemplateSerializer = new CallTemplateSerializer();

/**
 * The MCP server is a GENERIC proxy over the UTCP tool surface. It owns no tool
 * logic: per MCP session it stands up a `UtcpClient` pointed at the backend's
 * own `GET /api/agent/utcp` manual (over loopback, authenticated with the
 * caller's connection key), discovers every tool, and re-exposes each one to
 * the MCP client. A tool call is dispatched straight back through the same REST
 * endpoint the tool's UTCP `tool_call_template` names — so the agent logic,
 * thread continuity, and per-key token metering all live ONCE behind that REST
 * endpoint (`AgentAskService` for `ask`), never duplicated here.
 *
 * Dispatch always uses `callToolStreaming`, which is uniform across tool kinds:
 * a plain `http` tool yields exactly one chunk (its final result, emitted as
 * the tool result with no progress), while a `streamable_http` tool yields many
 * (the all-but-last become `notifications/progress`, the last is the result).
 * Because of that, adding — or later upgrading a tool to streaming — never
 * touches this file.
 *
 * Auth note: `/api/agent/*` accepts connection keys and internal tokens only.
 * Connection-key sessions pass the caller's own key through to the loopback;
 * OAuth/JWT sessions can't (their bearer would 401 there), so `createSession`
 * mints a least-privilege internal token for the resolved user and uses THAT
 * as the session's loopback bearer instead.
 */
export class McpService {
  // Circuit breaker for manuals whose credentials just failed — see the memo.
  private readonly manualFailures = new ManualFailureMemo();

  /**
   * Invalidate remembered manual failures — wired to the secrets vault's
   * mutation listener, so a just-repaired credential is retried on the very
   * next session build. `null` = a shared secret changed (affects everyone).
   */
  clearManualFailures(userId: string | null): void {
    if (userId === null) this.manualFailures.clearAll();
    else this.manualFailures.clearUser(userId);
  }

  constructor(
    private readonly sessionStore: McpSessionStore,
    private readonly opts: McpProxyOptions,
    // The vault + manual catalog, used to check a caller's per-user credentials
    // before dispatching a tool. Optional so existing constructions/tests that
    // don't exercise the check keep working (the check is skipped when absent).
    private readonly secretsVault?: ISecretsVaultService,
    private readonly toolManuals?: IToolManualService,
    // Mints the loopback bearer for OAuth/JWT sessions (see class doc).
    // Optional for the same test-compat reason; without it those sessions
    // fall back to the old pass-through (and 401 at the loopback hop).
    private readonly internalTokens?: InternalTokenService,
    // Revokes an MCP OAuth access token (BevelOAuthProvider.revokeByAccessToken)
    // — the reset that sends an interactive session back through the browser
    // authorization when one of its TOOL sign-ins breaks. Optional: without
    // it, broken sign-ins surface only as the /connect link in the result.
    private readonly revokeOAuthAccess?: (bearer: string) => Promise<void>,
  ) {}

  /**
   * Subscribe to store-driven evictions (idle-TTL sweep, size-cap eviction) so
   * the route layer can drop its transport mirror. Returns an unsubscribe fn.
   */
  onSessionEvicted(listener: (sessionId: string) => void): () => void {
    return this.sessionStore.onEvict(listener);
  }

  /**
   * Build a fresh per-session (transport, server) pair. Async because tool
   * discovery (a loopback round-trip authenticated with `bearer`) happens here,
   * before the server is returned, so `tools/list` is ready the moment the
   * client asks. The route awaits this, then `server.connect(transport)`.
   */
  async createSession(
    userId: string,
    tokenId: string | null,
    bearer: string,
    onSessionInitialized: (sessionId: string) => void,
  ): Promise<{ transport: StreamableHTTPServerTransport; server: Server }> {
    // The loopback surface (`/api/agent/*`) accepts connection keys and
    // internal tokens only. A connection-key session passes the caller's own
    // key through (per-key metering rides on it); an OAuth/JWT session's
    // bearer would 401 there, so mint a least-privilege internal token for
    // the resolved user instead — flagged `externalProxy` so the tool-auth
    // verifier resolves it to `source: 'external'`: the caller IS an external
    // agent and must be treated like one (admitted to `start_session`/`ask`,
    // refused from internal-only tools). TTL covers the session store's 4h
    // idle eviction — an evicted session re-initializes and re-mints.
    const loopbackBearer =
      tokenId == null && this.internalTokens
        ? this.internalTokens.mint({ userId, externalProxy: true }, MCP_LOOPBACK_TOKEN_TTL_MS)
        : bearer;

    // The list of manuals this caller gets: the KB manual + each `.tool` they
    // can read. Fetched over loopback with the caller's key, so ACL filtering
    // lives ONCE behind the REST surface.
    const manuals = await this.fetchManualTemplates(loopbackBearer);
    const client = await this.buildClient(loopbackBearer, userId, manuals);
    const tools = await this.discoverTools(client, manuals, userId);
    // Confirms the MCP session was built for a connecting client (vs. an
    // in-process agent code-mode client, which never runs createSession) and
    // how many tools discovery yielded before listing/filtering.
    console.log(
      `[mcp] createSession: user=${userId} tokenId=${tokenId ?? 'none'} — ` +
        `discovered ${tools.length} tool(s) across ${manuals.length} manual(s)`,
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessionStore.create(sessionId, userId, tokenId);
        onSessionInitialized(sessionId);
      },
      onsessionclosed: (sessionId) => {
        this.sessionStore.delete(sessionId);
      },
    });

    const server = new Server(
      { name: 'bevel-mcp', version: '0.1.0' },
      { capabilities: { tools: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // A discovered tool whose name collides with a meta-tool would be
      // listed but never callable (the dispatcher routes the name to the
      // meta-tool first), so drop it from the listing entirely.
      let listed = tools.filter((t) => !META_TOOL_NAMES.has(t.mcpName));
      // Connection-key sessions are autonomous pipelines — nobody is present
      // to complete a sign-in mid-run, so register ONLY the tools whose
      // per-user credentials are already satisfied. Interactive (OAuth/JWT)
      // sessions keep the full listing: their caller can configure a tool on
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
        direct.push(entry);
      }
      // Log only when a tool was dropped (name/schema/duplicate) — that's the
      // anomaly worth surfacing, since a downstream client would otherwise hide
      // it by rejecting the whole response. The steady-state served count is
      // already visible once per session in the createSession log above.
      if (dropped.length) {
        console.warn(
          `[mcp] tools/list: serving ${CODE_MODE_META_TOOLS.length + direct.length} tool(s); ` +
            `dropped ${dropped.length} non-listable: ${dropped.join(', ')}`,
        );
      }
      return {
        // Code-mode meta-tools first, then every validated direct tool.
        tools: [...CODE_MODE_META_TOOLS, ...direct],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (META_TOOL_NAMES.has(request.params.name)) {
        return this.dispatchMetaTool(client, request.params.name, request.params.arguments ?? {});
      }
      const proxied = tools.find((t) => t.mcpName === request.params.name);
      if (!proxied) {
        return toolError(`Unknown tool "${request.params.name}".`);
      }
      // Stop before running a tool whose personal (user-scoped) credentials the
      // caller hasn't provided — return a setup link instead of a blank-credential
      // request that would fail opaquely at the provider.
      const needsAuth = await this.checkUserSecrets(userId, proxied);
      if (needsAuth) {
        // A sign-in that EXISTS but is broken (expired grant, abandoned
        // consent, missing scopes) on an interactive OAuth session: revoke the
        // agent's own grant too. Its next request then 401s, its refresh
        // fails, and it re-runs the browser authorization — landing the user
        // on /connect where the broken sign-in shows as not-connected, to
        // re-authorize or deselect. Never-configured tools keep the plain
        // link (revoking for those would loop on every poke at a tool the
        // user simply hasn't set up). Connection-key sessions have no grant
        // to reset; the revoke no-ops on non-OAuth bearers anyway.
        if (needsAuth.brokenSignIn && tokenId == null && this.revokeOAuthAccess) {
          try {
            await this.revokeOAuthAccess(bearer);
          } catch (err) {
            console.warn('[mcp] failed to reset the session grant for re-auth:', err);
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
    // surface, never duplicated here.
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

    return { transport, server };
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
   * MCP session. GET when `json` is absent, POST with a JSON body when present.
   * Bounded: a hung loopback (e.g. mid-restart) must not block `createSession`
   * or a prompts handler indefinitely; a timeout aborts and degrades to null
   * like any other failure.
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
        console.error(`[mcp] ${label} loopback failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`[mcp] ${label} loopback threw:`, err instanceof Error ? err.message : err);
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
   * session. HTTP transport loses the `CallTemplate` type, so we re-validate the
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
        console.warn(`[mcp] skipping manual "${name}": ${err instanceof Error ? err.message : String(err)}`);
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
   * One `CodeModeUtcpClient` per session. Reserved `API_URL`/`CONNECTION_KEY` are
   * seeded (namespaced) ONLY for Bevel-hosted manuals — the KB manual and inline
   * `.tool` sub-manuals, whose discovery template targets the loopback (`${API_URL}`).
   * Third-party http/mcp `.tool`s point at arbitrary user URLs, so we must NOT seed
   * them the caller's bearer: a malicious `.tool` referencing `${CONNECTION_KEY}`
   * would otherwise exfiltrate the caller's token to its own endpoint. Tool
   * `${SECRET}` refs resolve lazily via the per-user `bevel-secrets` loader.
   */
  private async buildClient(
    bearer: string,
    userId: string,
    manuals: CallTemplate[],
  ): Promise<CodeModeUtcpClient> {
    // Bevel-hosted manuals (KB + inline `.tool` sub-manuals, discovery url
    // `${API_URL}/…`) get the loopback creds; third-party `.tool` URLs are never
    // seeded so the bearer can't leak. Same rule the in-process agent factory uses.
    const variables = seedBevelHostedManualVars(manuals, this.opts.loopbackBaseUrl, bearer);
    const config = new UtcpClientConfigSerializer().validateDict({
      variables,
      load_variables_from: [bevelSecretsLoaderConfig(userId)],
    });
    return CodeModeUtcpClient.create(process.cwd(), config);
  }

  /**
   * Register EVERY manual on the client, then flatten each discovered tool into
   * the proxy's advertised shape. A failure registering a user `.tool` is
   * isolated (logged + skipped) so one broken manual never breaks the session;
   * the KB manual failing is fatal (the core toolset is unusable).
   *
   * Failures are memoized per (user, manual) for a few minutes (see
   * {@link ManualFailureMemo}): sessions rebuild constantly, and a manual with
   * a broken credential (expired OAuth, revoked key) would otherwise re-dial
   * its provider on every single build.
   */
  private async discoverTools(
    client: CodeModeUtcpClient,
    manuals: CallTemplate[],
    userId: string,
  ): Promise<ProxiedTool[]> {
    for (const m of manuals) {
      const isKb = m.name === EXTERNAL_KB_MANUAL_NAME;
      const name = String(m.name);
      if (!isKb) {
        const recent = this.manualFailures.recentFailure(userId, name);
        if (recent !== undefined) {
          console.warn(`[mcp] skipping manual "${name}" (recent failure, not retried): ${recent}`);
          continue;
        }
      }
      // Captured BEFORE the awaited attempt: if a secrets change clears the
      // memo while registration is in flight, the stale failure from the OLD
      // credential must not resurrect an entry the clear removed.
      const generation = this.manualFailures.currentGeneration;
      // `registerManual` never throws: a discovery/network failure and a
      // validation failure both come back as `{ ok: false }`, because the retry
      // policy — this memo — is ours, not the shared layer's.
      const result = await registerManual(client, m);
      if (!result.ok) {
        if (isKb) throw new Error(`Bevel tool discovery failed: ${result.error}`);
        this.manualFailures.recordFailure(userId, name, result.error, generation);
        console.warn(`[mcp] skipping manual "${name}": ${result.error}`);
      } else if (!isKb) {
        this.manualFailures.clear(userId, name);
      }
    }
    const utcpTools = await client.getTools();
    return utcpTools.map((tool: UtcpTool) => flattenManualTool(tool, EXTERNAL_KB_MANUAL_NAME));
  }

  /**
   * Run one tool call through `callToolStreaming` with a one-chunk lookahead:
   * every chunk except the last becomes a progress notification, the last is
   * the result. Continuity is the caller's: a tool that supports it (e.g.
   * `ask`) returns its `sessionId` in the result verbatim, and the caller
   * echoes it back per the tool's own schema — the proxy never rewrites args.
   */
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
      // that warrants resetting an interactive session for re-auth, as
      // opposed to a tool the caller never set up at all.
      brokenSignIn: missing.some((v) => v.brokenSignIn),
    };
  }

  /**
   * The per-user variables of `tool`'s manual the caller has NOT satisfied.
   * Shared by the call-time needs-authorization check above and the
   * listing-time filter for connection-key sessions (which registers only
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

  private async dispatch(
    client: CodeModeUtcpClient,
    tool: ProxiedTool,
    request: { params: { arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } } },
    // `sendNotification` typed loosely (`any`) so a `notifications/progress`
    // payload without a `progressToken` is accepted — same approach the prior
    // handler used; the strict ServerNotification type requires the token.
    extra: { sessionId?: string; sendNotification: (n: any) => Promise<void> },
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
   * session's client, so `list_tools`/`tools_info` describe exactly the catalog
   * this session discovered and `call_tool_chain` runs in that client's
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
