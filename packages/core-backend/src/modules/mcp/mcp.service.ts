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
  type JsonSchema,
  type Tool as UtcpTool,
} from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpNameToTsInterfaceName, findToolByName } from '../code-mode/code-mode-names.js';
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

/** Default cap on a `call_tool_chain` result's stringified size before it spills. */
const CALL_TOOL_CHAIN_MAX_OUTPUT = 200_000;

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
 */
const MCP_LOOPBACK_TOKEN_TTL_MS = 5 * 60 * 60 * 1000;

const callTemplateSerializer = new CallTemplateSerializer();

/**
 * Code-mode meta-tools exposed ALONGSIDE the direct tools. They let an external
 * agent batch many Bevel calls into one isolated-vm run (`call_tool_chain`)
 * instead of one MCP round-trip per call — the same efficiency our own agent
 * gets. `call_tool_chain`'s description carries the code-mode protocol (there is
 * no system prompt over MCP), so the client learns the convention from the tool
 * itself; `list_tools`/`tools_info` are how it discovers what to call.
 *
 * Security is identical to the direct surface: the chain runs in our isolated-vm
 * but calls tools over loopback with the CALLER's key against the external
 * catalog — internal-only tools aren't in that catalog, so a chain can't reach
 * them either.
 */
const CALL_TOOL_CHAIN_DESCRIPTION = [
  'Execute a short JavaScript program with direct access to every registered UTCP tool as a synchronous function. Call tools as `KNOWLEDGE_BASE.<tool>({ body: { ...args } })` with NO `await` (results are already resolved), and `return` the final value. The runtime is plain JavaScript (no type annotations / no TypeScript-only syntax).',
  'Discover first: `list_tools` lists every tool in callable form (e.g. `KNOWLEDGE_BASE.read_file`); `tools_info` returns their exact argument + return shapes — do not guess. Batch multiple tool calls into one chain to avoid a round-trip per call. The chain runs with your own connection key, so it can only reach the tools you can already call directly.',
  'Large results: if the combined result+logs exceed `max_output_size` (default 200000 chars) the full JSON is spilled to a shared store and you get back a `__tool_chain_spill__/…` ref instead. Read it with `read_file` (pass that ref as `path` — `branch` is ignored — plus `offset`/`limit` to slice it), or better, re-run a narrower chain that returns only what you need.',
].join('\n\n');

const CODE_MODE_META_TOOLS: McpTool[] = [
  {
    name: 'list_tools',
    description:
      'List every UTCP tool currently registered, in TypeScript-accessible form (e.g. `KNOWLEDGE_BASE.read_file`) for use inside `call_tool_chain`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as McpTool['inputSchema'],
  },
  {
    name: 'tools_info',
    description:
      'Get full TypeScript interface definitions for named tools (names from `list_tools`). The schemas are the source of truth — do not guess shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tool names to describe.' },
      },
      required: ['tool_names'],
      additionalProperties: false,
    } as McpTool['inputSchema'],
  },
  {
    name: 'call_tool_chain',
    description: CALL_TOOL_CHAIN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', minLength: 1, description: 'JavaScript to execute against the registered tools.' },
        timeout: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Timeout in ms (default 30000).' },
        max_output_size: { type: 'integer', minimum: 1000, maximum: 1000000, description: 'Max result+logs size in chars before spilling (default 200000, max 1000000).' },
      },
      required: ['code'],
      additionalProperties: false,
    } as McpTool['inputSchema'],
  },
];

const META_TOOL_NAMES = new Set(CODE_MODE_META_TOOLS.map((t) => t.name));

/** Minimal skill shapes the prompt bridge needs (kept local so the proxy stays decoupled from `modules/skills`). */
interface SkillSummary {
  name: string;
  description: string;
}
interface LoadedSkill extends SkillSummary {
  body: string;
  path: string;
  files: string[];
}

/** The prompt message text for a loaded skill: its instructions body + a pointer to bundled files. */
function skillPromptText(skill: LoadedSkill): string {
  const rel = skill.files.map((f) =>
    f.startsWith(`${skill.path}/`) ? f.slice(skill.path.length + 1) : f,
  );
  const footer = rel.length
    ? `\n\n---\nSkill folder: ${skill.path}\nBundled files (fetch each with the get_skill tool: { name: "${skill.name}", file }): ${rel.join(', ')}`
    : '';
  return `${skill.body}${footer}`;
}

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
      try {
        const result = await client.registerManual(m);
        if (result && result.success === false) {
          const errs = Array.isArray(result.errors) ? result.errors.join('; ') : 'unknown error';
          if (isKb) throw new Error(`Bevel tool discovery failed: ${errs}`);
          this.manualFailures.recordFailure(userId, name, errs);
          console.warn(`[mcp] skipping manual "${name}": ${errs}`);
        } else if (!isKb) {
          this.manualFailures.clear(userId, name);
        }
      } catch (err) {
        // Registration (network/discovery) failure — the templates are already
        // validated, so this is a runtime, not a schema, problem.
        if (isKb) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.manualFailures.recordFailure(userId, name, message);
        console.warn(`[mcp] skipping manual "${name}": ${message}`);
      }
    }
    const utcpTools = await client.getTools();
    return utcpTools.map((tool: UtcpTool) => flattenManualTool(tool));
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
    const args = request.params.arguments ?? {};

    const progressToken = request.params._meta?.progressToken;
    let prev: unknown;
    let hasPrev = false;
    let progress = 0;

    try {
      // Args pass through to UTCP verbatim — each communication protocol does
      // its own serialization (http reads the template's `body_field` out of the
      // args, mcp forwards them untouched as MCP `arguments`). The advertised
      // schema is the tool's UTCP `inputs` verbatim too, so what the caller
      // sends is already in the shape the protocol expects; any reshaping here
      // would be wrong for at least one protocol.
      for await (const chunk of client.callToolStreaming(tool.utcpName, args)) {
        if (hasPrev) {
          progress += 1;
          await extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                ...(progressToken !== undefined ? { progressToken } : {}),
                progress,
                message: renderProgress(prev),
              },
            })
            .catch((err) => console.warn('[mcp] progress notification failed:', err));
        }
        prev = chunk;
        hasPrev = true;
      }
    } catch (err) {
      return toolError(`The "${tool.mcpName}" tool failed: ${describeToolFailure(err)}`);
    }

    return toCallToolResult(prev);
  }

  /**
   * Handle a code-mode meta-tool. `list_tools`/`tools_info` reflect on the
   * session client's discovered catalog; `call_tool_chain` runs the caller's
   * JavaScript in the client's isolated-vm, where every tool is reachable as
   * `<manual>.tool(...)` and resolves over loopback with the caller's key.
   */
  private async dispatchMetaTool(
    client: CodeModeUtcpClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      if (name === 'list_tools') {
        const tools = await client.config.tool_repository.getTools();
        return toCallToolResult({ tools: tools.map((t) => utcpNameToTsInterfaceName(t.name)) });
      }
      if (name === 'tools_info') {
        const names = Array.isArray(args.tool_names) ? (args.tool_names as string[]) : [];
        const interfaces: string[] = [];
        const notFound: string[] = [];
        for (const n of names) {
          const found = await findToolByName(client, n);
          if (found) interfaces.push(client.toolToTypeScriptInterface(found.tool));
          else notFound.push(n);
        }
        return toCallToolResult({ interfaces: interfaces.join('\n\n'), not_found: notFound });
      }
      // call_tool_chain
      const code = typeof args.code === 'string' ? args.code : '';
      const timeout = typeof args.timeout === 'number' ? args.timeout : 30_000;
      // Clamp to [1000, 1_000_000] so a caller can't force oversized inline
      // output past the spill (schema bounds are advisory over a raw JSON-RPC call).
      const maxOutputSize =
        typeof args.max_output_size === 'number'
          ? Math.min(1_000_000, Math.max(1_000, Math.trunc(args.max_output_size)))
          : CALL_TOOL_CHAIN_MAX_OUTPUT;
      const { result, logs } = await client.callToolChain(code, timeout);
      // Bound the payload: an external session has no ambient workspace, so an
      // oversized result spills to the shared store and we return only a ref —
      // parity with the in-process agent's `call_tool_chain`.
      if (JSON.stringify({ success: true, result, logs }).length <= maxOutputSize) {
        return toCallToolResult({ success: true, result, logs });
      }
      const fullJson = JSON.stringify({ result, logs }, null, 2);
      const { ref, bytes } = await this.opts.spillStore.write(fullJson);
      return toCallToolResult({
        success: true,
        truncated: true,
        result_ref: ref,
        result_bytes: bytes,
        message: `Result+logs payload was ${fullJson.length} characters (exceeded max_output_size of ${maxOutputSize}). Full JSON saved to the shared spill store as \`${ref}\`. Read it back with \`read_file\` (pass that ref as \`path\`, \`branch\` ignored, plus \`offset\`/\`limit\` to slice), or re-run a narrower chain that returns only what you need.`,
      });
    } catch (err) {
      return toolError(`The "${name}" tool failed: ${describeToolFailure(err)}`);
    }
  }
}

/** A tool discovered from the manual, flattened into what the proxy advertises. */
export interface ProxiedTool {
  utcpName: string;
  mcpName: string;
  description: string;
  inputSchema: JsonSchema;
  /** The UTCP manual this tool came from (the `<manual>` in `<manual>.<tool>`),
   * used to look up the manual's declared per-user credentials before dispatch. */
  manualName: string;
}

/**
 * Flatten a discovered UTCP tool (`<manual>.<tool>`) into the proxy's advertised
 * shape when MULTIPLE manuals are registered. KB tools keep their bare name (so
 * existing external agents still call `read_file`); a user `.tool`'s tool is
 * namespaced as `<manual>_<tool>` to guarantee a unique, dot-free MCP name.
 */
/**
 * MCP tool-name grammar (also the Anthropic API's), and a length bound. A
 * remote MCP server can expose a tool whose flattened name breaks this — too
 * long, or an illegal char the `<manual>_<name>` flattening didn't remove — and
 * an MCP client (or the model API behind it) rejects the ENTIRE `tools/list`
 * response when a single entry is non-conforming. That makes EVERY tool vanish
 * the moment one bad tool from a newly-added server enters the catalog, with no
 * server-side error (the rejection is the client's). `toListedTool` isolates it
 * per tool: drop the offender (logged), normalize an odd schema, keep the rest.
 */
const MCP_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// The Anthropic API caps a tool name at 128 chars — but the MCP CLIENT (Claude
// Code, claude.ai) prepends `mcp__<server>__` (≈20+ chars) before sending it,
// and that FULL name is what the 128 applies to. So budget for the prefix here,
// or a long `googlecalendar_…` name we pass gets the whole request 400'd. This
// is deliberately conservative; a dropped tool is logged so it's diagnosable.
const MCP_TOOL_NAME_MAX = 100;

/** A discovered tool as an MCP listing entry, or null if its name can't be listed. */
export function toListedTool(tool: ProxiedTool): McpTool | null {
  if (!MCP_TOOL_NAME_RE.test(tool.mcpName) || tool.mcpName.length > MCP_TOOL_NAME_MAX) {
    console.warn(
      `[mcp] dropping tool "${tool.mcpName}" from the listing — not a valid MCP tool name ` +
        `(must match ${MCP_TOOL_NAME_RE} and be ≤${MCP_TOOL_NAME_MAX} chars). ` +
        'One non-conforming tool would otherwise make the whole toolset disappear on the client.',
    );
    return null;
  }
  // MCP requires an object inputSchema. A remote server's schema that isn't a
  // plain object (or omits `type: 'object'`) can invalidate the whole response,
  // so normalize it — keeping any declared properties — rather than pass it
  // through verbatim.
  const raw = tool.inputSchema;
  let inputSchema: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { type: 'object', ...(raw as Record<string, unknown>) }
      : { type: 'object', properties: {} };
  // Sanitize the schema into what the Anthropic tool validator accepts. A
  // remote server that emits a construct the validator rejects — Google's
  // gmail/calendar use `$ref`/`$defs` AND OpenAPI `format` values like
  // `int32`/`byte` — makes the CLIENT reject the ENTIRE tools/list response,
  // so all tools vanish and nothing registers. Sanitizing per-tool means one
  // odd server can't blank the whole toolset.
  inputSchema = sanitizeInputSchema(inputSchema) as Record<string, unknown>;
  // The MCP/Anthropic validator requires the top-level `type` to be exactly
  // "object" and (for the Anthropic API) `properties` to be present. Force both
  // so a remote schema that declared something else — or a union like
  // `["object","null"]` — can't reject the whole tools/list.
  inputSchema.type = 'object';
  if (typeof inputSchema.properties !== 'object' || inputSchema.properties === null) {
    inputSchema.properties = {};
  }
  return {
    name: tool.mcpName,
    description: tool.description,
    inputSchema: inputSchema as McpTool['inputSchema'],
  };
}

/** JSON-Schema string `format` values the Anthropic tool validator accepts. */
const SUPPORTED_SCHEMA_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * Make a remote server's JSON Schema safe for the Anthropic tool validator:
 *  - inline local `$ref` pointers (`#/$defs/...`, `#/definitions/...`) and drop
 *    the now-unreferenced `$defs`/`definitions` blocks (the API restricts `$ref`
 *    and MCP clients converting our schemas reject it outright);
 *  - drop non-standard `format` values (OpenAPI's `int32`/`byte`/… — only the
 *    JSON-Schema-standard formats above are accepted; `format` is advisory, so
 *    dropping it doesn't change tool behavior).
 * Depth-bounded so a recursive schema degrades to a permissive `{}` node instead
 * of hanging or emitting the unsupported recursion; non-local/external refs
 * degrade the same way. Exported for direct testing.
 */
export function sanitizeInputSchema(schema: unknown): unknown {
  const root = schema;
  const resolvePointer = (pointer: string): unknown => {
    if (!pointer.startsWith('#/')) return undefined;
    let node: unknown = root;
    for (const partRaw of pointer.slice(2).split('/')) {
      const part = partRaw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 20) return {}; // recursion/cycle guard — permissive fallback
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const target = resolvePointer(obj.$ref);
      // JSON Schema allows siblings next to $ref; keep them, target wins ties.
      const { $ref: _ref, ...siblings } = obj;
      const resolved = walk(target ?? {}, depth + 1);
      return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
        ? { ...siblings, ...(resolved as Record<string, unknown>) }
        : Object.keys(siblings).length
          ? siblings
          : resolved ?? {};
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$defs' || key === 'definitions') continue; // inlined above
      // Drop a non-standard `format` (OpenAPI `int32`/`byte`/…) — the validator
      // only allows the JSON-Schema-standard set; the annotation is non-load-bearing.
      if (key === 'format' && (typeof value !== 'string' || !SUPPORTED_SCHEMA_FORMATS.has(value))) {
        continue;
      }
      out[key] = walk(value, depth + 1);
    }
    return out;
  };
  return walk(schema, 0);
}

export function flattenManualTool(tool: UtcpTool): ProxiedTool {
  const dot = tool.name.indexOf('.');
  const manual = dot >= 0 ? tool.name.slice(0, dot) : '';
  const bare = dot >= 0 ? tool.name.slice(dot + 1) : tool.name;
  const mcpName = manual === EXTERNAL_KB_MANUAL_NAME ? bare : tool.name.replace(/\./g, '_');
  return {
    utcpName: tool.name,
    mcpName,
    description: tool.description,
    inputSchema: tool.inputs,
    manualName: manual,
  };
}

/**
 * Flatten one discovered UTCP tool into the proxy's advertised shape: strip the
 * `<manual>.` namespace prefix for the MCP name and keep the UTCP input schema
 * verbatim (Bevel-hosted HTTP tools show their `{body}` envelope, exactly as in
 * `call_tool_chain`).
 */
export function flattenDiscoveredTool(prefix: string, tool: UtcpTool): ProxiedTool {
  return {
    utcpName: tool.name,
    mcpName: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
    description: tool.description,
    inputSchema: tool.inputs,
    // `prefix` is `<manual>.`; the manual is that without the trailing dot.
    manualName: prefix.endsWith('.') ? prefix.slice(0, -1) : prefix,
  };
}

/**
 * Extract a human-meaningful failure message from a tool-call error. UTCP's
 * HTTP protocol surfaces a non-2xx as an axios-style error whose `.response.data`
 * is the REST endpoint's JSON body (`{ error: "..." }`). Pull that out so the
 * MCP caller sees the tool's real message instead of a bare "status code 500".
 */
export function describeToolFailure(err: unknown): string {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const inner = (data as { error?: unknown }).error;
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  if (typeof data === 'string' && data.length > 0) return data;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a tool's final value into an MCP result:
 *  - a tool that already returns the MCP agentic shape (`{ content: [...] }`,
 *    each entry a real content block) is passed through unchanged;
 *  - a bare string becomes the text content;
 *  - anything else is JSON-stringified into one text block.
 *
 * Note we do NOT collapse a structured object down to its `text` field: doing
 * so silently dropped the other fields (e.g. `ask`'s `status` / `sessionId`,
 * the id a caller must echo back to poll or continue a conversation).
 * Stringifying the whole object keeps every field, so the caller always sees
 * the id it is responsible for echoing.
 *
 * The passthrough guard checks the entries, not just that `content` is an array:
 * a domain value that merely happens to carry a `content` array of non-blocks
 * (e.g. `{ content: ['a', 'b'] }`) is data, not an MCP result, so it falls
 * through to JSON-stringify and survives intact instead of being emitted as a
 * malformed result the client can't parse.
 */
function isMcpContentBlock(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string';
}

export function toCallToolResult(value: unknown): CallToolResult {
  // Already in MCP agentic format — pass through untouched, but only when every
  // `content` entry is a real content block (has a string `type`).
  const content = (value as { content?: unknown })?.content;
  if (value && typeof value === 'object' && Array.isArray(content) && content.every(isMcpContentBlock)) {
    return value as CallToolResult;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return { content: [{ type: 'text', text: text || '(tool produced no output)' }] };
}

function renderProgress(chunk: unknown): string {
  const s = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
  return s.length > 500 ? s.slice(0, 497) + '...' : s;
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * The result returned when the caller is missing personal credentials a tool
 * needs. Marked `isError` so the external agent surfaces it to the person rather
 * than treating it as tool output. Names the tool, lists the missing items, and
 * gives the absolute setup-page URL so the person can provide them and retry.
 */
export function needsAuthorizationResult(
  toolName: string,
  missing: string[],
  connectUrl: string,
): CallToolResult {
  const items = missing.join(', ');
  const text =
    `The "${toolName}" tool needs credentials you haven't set up yet: ${items}. ` +
    `Open ${connectUrl} to connect your accounts and enter your keys, then run the tool again.`;
  return { isError: true, content: [{ type: 'text', text }] };
}
