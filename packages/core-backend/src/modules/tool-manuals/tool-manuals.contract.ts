import type { CallTemplate } from '@utcp/sdk';

/**
 * Tool manuals — user-authored `*.tool` files under `Plugins/` in the DEFAULT
 * branch KB. Each is a UTCP *manual* (a pointer to where tools come from), not a
 * flattened tool list. Access-controlled exactly like Skills (default-deny ACL
 * on the `.tool` file path). The MCP/UTCP endpoint serves every manual a user
 * can read via `GET /api/agent/all-tools`, and the MCP proxy registers them all
 * on its per-session UTCP client — UTCP namespaces tools by manual name, so
 * there's no server-side flattening.
 *
 * A `.tool` file's `type` (its UTCP call-template kind) decides resolution:
 *  - `inline` — tools embedded in the file; Bevel serves them as a tiny http
 *               sub-manual (`GET /api/tools/:slug/manual`), so no extra client
 *               plugin is needed.
 *  - `http`   — points to a URL that returns a UTCP manual.
 *  - `mcp`    — a remote MCP server whose tools are discovered over MCP.
 */

/** The external KB manual's name — shared by `/agent/all-tools` and the MCP proxy. */
export const EXTERNAL_KB_MANUAL_NAME = 'KNOWLEDGE_BASE';

export type ToolManualType = 'inline' | 'http' | 'mcp';

/** How a tool variable's secret is provisioned. */
export type ToolVariableScope = 'admin' | 'user';

/**
 * PUBLIC OAuth provider config a variable declares — NEVER a client secret. When
 * present, the variable's value is obtained by signing in with this provider
 * (the per-user secret row is `kind:'oauth'`), rather than being typed. The
 * confidential client secret is provisioned separately by a tool writer.
 *
 * The endpoints are OPTIONAL for an `mcp.json` server: an MCP-spec server
 * publishes its authorization-server metadata, so a declaration carrying only
 * the `clientId` of an owner-registered app is completed at scan time
 * (`authorizationUrl`/`tokenUrl`/`resource` filled in from that metadata). A
 * `.tool` manual has no server to ask, so there both URLs are required.
 */
export interface ToolVariableOAuth {
  /** Absent on an mcp.json server ⇒ discovered from the server's OAuth metadata. */
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId: string;
  scopes?: string[];
  /**
   * Extra static query params appended to the authorization request — e.g.
   * Google's `access_type: offline` + `prompt: consent`, which it requires to
   * return a refresh token (without it the sign-in dies at the 1h access-token
   * expiry). Control params (`response_type`/`client_id`/`redirect_uri`/`state`/
   * `scope`) can't be overridden. NEVER a secret — the confidential client
   * secret is still provisioned only through the protected route.
   */
  authParams?: Record<string, string>;
  /**
   * PKCE (S256) on the authorization-code flow. ON unless explicitly `false`:
   * the MCP authorization spec requires it, and a provider that doesn't
   * implement it ignores the extra parameters (RFC 6749 §3.1). Only `false` is
   * ever stored — absent means the default.
   */
  pkce?: boolean;
  /**
   * RFC 8707 resource indicator — the MCP server's canonical URL, so the token
   * is audience-bound. Filled in from the server's metadata for an mcp.json
   * server; declare it by hand only when the provider demands it and the
   * endpoints are declared by hand too.
   */
  resource?: string;
}

/**
 * A `${VAR}` a `.tool` manual references, and who provisions its secret:
 *  - `admin` — set ONCE by a writer of the `.tool` file; the same value is shared
 *              by every invoker (a shared secret row). This is the default.
 *  - `user`  — set by each end user (a per-user secret row).
 * Variables referenced but not declared here default to `admin`.
 */
export interface ToolVariable {
  name: string;
  scope: ToolVariableScope;
  /** Operator-facing hint shown in the secrets UI. */
  label?: string;
  /**
   * When present, this variable is OAuth-backed: the user signs in with the
   * declared provider to obtain a token. Only valid with `scope:'user'` (each
   * caller authorizes their own). The client secret is NOT declared here.
   */
  oauth?: ToolVariableOAuth;
}

/**
 * An optional cheap, read-only call that proves a credential actually WORKS.
 *
 * A `type: mcp` manual needs none — its handshake is authenticated, so merely
 * connecting already tests the token. `http` and `inline` manuals have no such
 * moment: registering an `http` manual fetches its DESCRIPTION, which providers
 * usually serve publicly, so a wrong key sails through; an `inline` manual's
 * discovery template points at Bevel's own API and never touches the provider
 * at all. Without a declaration there is genuinely nothing to call, and the
 * platform reports the connection as unverified rather than guessing.
 *
 * NOT inferred from the manual's own tools. Picking one automatically would
 * mean calling an arbitrary tool with invented arguments — a probe that could
 * send a message or create a record is worse than no probe. The author names a
 * safe endpoint or the tool stays unverified.
 *
 * `${VAR}` refs resolve from the caller's vault exactly as they do in `url` and
 * `headers`, which is the whole point: the probe must carry the same credential
 * the real calls carry. Any 2xx is a pass; 401/403 is a rejection; anything
 * else is treated as the provider being unwell rather than the key being wrong.
 */
export interface ToolHealthCheck {
  /** Absolute URL to call. May contain `${VAR}` refs; SSRF-checked like `url`. */
  url: string;
  /** Default `GET`. A health check may not mutate, so nothing else is allowed. */
  method?: 'GET';
  /** Defaults to the manual's own `headers` — usually where the credential is. */
  headers?: Record<string, string>;
}

/**
 * One manual, reduced to exactly what testing its credential requires.
 *
 * Server-internal, like {@link ToolHealthCheck} and for the same reason: both
 * `healthCheck.headers` and `callTemplate` can carry a literal token.
 */
export interface ToolProbeTarget {
  name: string;
  type: ToolManualType;
  /** `false` for a local-only tool this server is not the one that can reach it. */
  remote?: boolean;
  /** The probe the `.tool` declares, if any. */
  healthCheck?: ToolHealthCheck;
  /**
   * The validated UTCP call template, or `null` when the manual doesn't produce
   * a valid one. Only the `mcp` probe uses it — its handshake IS the test — but
   * it is built here so the probe never has to walk the catalog again.
   */
  callTemplate: CallTemplate | null;
}

/**
 * For a `type: mcp` tool, what an admin must do to make the remote server
 * reachable — derived from OAuth auto-discovery, which a non-mcp tool has no
 * equivalent of (its needs are fully described by its declared `variables`):
 *  - `open`         — the server needs no auth; nothing to configure.
 *  - `oauth-auto`   — OAuth was auto-configured; the sign-in appears as a
 *                     `user`-scoped variable, so users just authorize.
 *  - `oauth-manual` — the server needs OAuth with an OWNER-REGISTERED client:
 *                     auto-discovery couldn't register one (typically no dynamic
 *                     client registration — Google, HubSpot), or the declaration
 *                     already names a client id. A tool writer declares the
 *                     sign-in on a `user`-scoped variable (the server editor for
 *                     an `mcp.json` server; the `variables` block of a `.tool`)
 *                     and sets its client secret. `reason` is present only while
 *                     something is still missing, and says exactly what.
 */
export interface ToolManualSetup {
  kind: 'open' | 'oauth-auto' | 'oauth-manual';
  /** What still blocks the sign-in — present for an unfinished `oauth-manual`. */
  reason?: string;
}

/** Fields common to every parsed manual — see {@link ToolManualDescriptor}. */
export interface ToolManualDescriptorBase {
  /** URL-safe id derived from the file name (route `:slug`), unique in the catalog. */
  slug: string;
  /**
   * UTCP manual name — the declared frontmatter `id` (snake_case, underscores
   * allowed; see `isValidId`) or the filename-derived fallback. Unique in the
   * catalog; namespacing doubles underscores in vault keys (`utcpNamespacedKey`).
   */
  name: string;
  /** Repo-root-relative path of the `.tool` file (e.g. `Plugins/Everyone/weather.tool`). */
  path: string;
  type: ToolManualType;
  /**
   * Optional one-line prose from the frontmatter, for humans browsing the
   * catalog. PURELY COSMETIC — a malformed value is ignored rather than
   * skipping the file (see `normalizeToolManual`), because a bad sentence must
   * never take a working integration offline.
   */
  description?: string;
  /** For `http`/`mcp`: the endpoint URL (may contain `${VAR}` refs). */
  url?: string;
  httpMethod?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** For `inline`: the embedded UTCP tools (validated when served). */
  tools?: unknown[];
  /** Declared `${VAR}` scopes (see {@link ToolVariable}); empty when none declared. */
  variables?: ToolVariable[];
  /** For `type: mcp`: the admin-facing setup requirement from auto-discovery. */
  setup?: ToolManualSetup;
  /**
   * Optional credential probe — see {@link ToolHealthCheck}. Declared on
   * `http`/`inline` manuals, and honoured on `type: mcp` too, where it
   * OVERRIDES the default handshake probe (a server whose health endpoint is
   * cheaper or more truthful than a full MCP handshake says so here).
   * INTERNAL: lives on the descriptor, never on {@link ToolManualSummary},
   * because it carries `headers`.
   */
  healthCheck?: ToolHealthCheck;
}

/** The spawn spec of a stdio-declared MCP server (a plugin `mcp.json` entry). */
export interface ToolManualStdioSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * A parsed manual (a `.tool` file or a plugin `mcp.json` entry, normalized).
 *
 * `remote` — whether the tool can run for a REMOTE consumer (Bevel's hosted
 * MCP proxy). Absent/`true` ⇒ available remotely; `false` ⇒ LOCAL-ONLY — the
 * remote endpoint skips it (it can't reach e.g. a `localhost` MCP server),
 * and instead surfaces its path via the `list_local_tools` tool so a local
 * agent can self-configure it.
 *
 * `stdio` — for a `type: mcp` server declared with a stdio transport in a
 * plugin's `mcp.json`: the spawn spec. A UNION, not two optional fields,
 * because a stdio spec REQUIRES `remote: false` — the hosted proxy can never
 * spawn a subprocess out of knowledge-base content, so stdio servers are
 * served only to local consumers, which run them per the Agent Plugins
 * runtime contract (PLUGIN_ROOT/PLUGIN_DATA, `./` containment) — and the
 * type refusing `remote: true` beside a spawn spec is what keeps every
 * producer honest about that.
 */
export type ToolManualDescriptor =
  | (ToolManualDescriptorBase & { remote?: boolean; stdio?: undefined })
  | (ToolManualDescriptorBase & { type: 'mcp'; remote: false; stdio: ToolManualStdioSpec });

/** A validated UTCP manual dict (`{ utcp_version, manual_version, tools }`). */
export type UtcpManualDict = Record<string, unknown>;

/** Result of validating a draft `.tool` for the renderer's preview. */
export interface ToolManualPreview {
  ok: boolean;
  /** Discovered/embedded tool names when resolvable. */
  tools?: { name: string; description?: string }[];
  /** Human-readable validation/resolution errors. */
  errors?: string[];
}

export interface ToolManualSummary {
  slug: string;
  name: string;
  path: string;
  type: ToolManualType;
  /** The frontmatter `description`, when the file declares a usable one. */
  description?: string;
  /** Declared `${VAR}` scopes; empty when none declared. */
  variables?: ToolVariable[];
  /** `false` ⇒ local-only (not served to remote agents); absent/`true` ⇒ remote-capable. */
  remote?: boolean;
  /** For `type: mcp`: the admin-facing setup requirement from auto-discovery. */
  setup?: ToolManualSetup;
  // NOTE: no `healthCheck` here, deliberately. This type is serialized straight
  // to the browser by the tool endpoints, and a probe carries `headers` — which
  // a `.tool` author may write as a literal token rather than a `${VAR}` ref.
  // The server reads probe config through `IToolManualService.probeTargetFor`.
}

/** One thing an `inline` manual's embedded tool list says the assistant can do. */
export interface ToolCapability {
  name: string;
  description: string | null;
}

/**
 * A single tool manual for the BROWSER tool page (`GET /api/tools/:slug`): the
 * summary plus the two human-facing fields the catalog listing has no use for.
 * Both are normalized to `null` rather than left optional — the page renders a
 * definite "nothing here" state, so an absent field and an empty one are the
 * same thing to it.
 */
export interface ToolManualDetail extends Omit<ToolManualSummary, 'description'> {
  description: string | null;
  /**
   * What the tool actually exposes, derived from an `inline` manual's embedded
   * `tools`. `http`/`mcp` manuals resolve their tools at call time (a network
   * round-trip this endpoint deliberately does not make), so they report `[]`.
   */
  capabilities: ToolCapability[];
}

export interface IToolManualService {
  /** The `.tool` manuals the user can read, as summaries. */
  listAccessible(userEmail: string): Promise<ToolManualSummary[]>;
  /**
   * One readable `.tool` by slug, with its description + capabilities, for the
   * browser tool page. `null` when no such slug exists OR the caller can't read
   * it — the two are deliberately indistinguishable (fail-closed: a 404 must not
   * confirm that a tool the caller can't see exists).
   */
  getDetail(userEmail: string, slug: string): Promise<ToolManualDetail | null>;

  /**
   * Every manual in the catalog, UNFILTERED by access — the mirror of
   * `skillService.listSkills(undefined)`. For caller-INDEPENDENT counting only
   * (the plugin index's "N tools", which a non-member is allowed to see as a
   * number). Never surface a name, path or description from this to someone
   * who cannot read the file; `listAccessible` is the surface for that.
   */
  listAllSummaries(): Promise<ToolManualSummary[]>;
  /**
   * Validated UTCP manual call-templates for the user's accessible `.tool`s —
   * one per file, ready for a UTCP client to `registerManual`. Each is validated
   * at build time (a `.tool` that fails to validate is skipped + logged). Does
   * NOT include the KB manual (the route prepends that). With `{ remoteOnly: true }`
   * (the remote MCP proxy), LOCAL-ONLY manuals (`remote: false`) are excluded.
   */
  toManualCallTemplates(userEmail: string, opts?: { remoteOnly?: boolean }): Promise<CallTemplate[]>;
  /**
   * The caller's accessible LOCAL-ONLY (`remote: false`) manuals.
   *
   * `slug` rides along with `name` and `path` because a local runtime needs
   * both: `name` is the UTCP namespace its `${VAR}` refs are keyed by, and
   * `slug` is what addresses the manual on the variable-resolution route.
   */
  listLocalOnly(userEmail: string): Promise<{ slug: string; name: string; path: string }[]>;
  /** The embedded UTCP manual for an inline `.tool` (served at `/api/tools/:slug/manual`). */
  resolveInlineManual(userEmail: string, slug: string): Promise<UtcpManualDict | null>;
  /** Validate a draft `.tool` file's content for the renderer preview. */
  preview(content: string): Promise<ToolManualPreview>;
  /**
   * The provisioning scope of a UTCP-namespaced variable key (`<manual>_<VAR>`).
   * Splits on the first underscore (manual names are alphanumeric), looks up the
   * manual's declared variables, and returns its scope — defaulting to `admin`
   * for an undeclared var or unknown manual. Used by the vault to decide whether
   * a `resolve` reads the shared row or the caller's row.
   */
  scopeOfVariable(effectiveKey: string): Promise<ToolVariableScope>;
  /**
   * Everything the credential probe needs about one readable manual, resolved
   * in a SINGLE catalog + ACL pass.
   *
   * One accessor rather than three because the probe needs three facts that all
   * come from the same file — is it local-only, does it declare a health check,
   * and what call template would reach it — and asking for them separately made
   * one probe walk the catalog four times, building call templates for every
   * manual in the workspace to use exactly one of them.
   *
   * Deliberately NOT reachable through {@link ToolManualSummary}: that type is
   * serialized straight to the browser by the tool endpoints, and a probe
   * carries `headers` — which a `.tool` author may write as a literal token
   * rather than a `${VAR}` ref. Probe config is internal to the server, so it
   * travels by its own accessor and never rides a public DTO.
   *
   * Addressed by SLUG, which is what the route has: resolving the slug here
   * rather than making the caller map it to a name first is what reduces a
   * probe to one pass. `ToolProbeTarget.name` carries the UTCP namespace back
   * out, since that is what the probe's `${VAR}` lookups are keyed by.
   *
   * `null` when no such manual exists OR the caller can't read it — the two are
   * indistinguishable on purpose, as everywhere else in this contract.
   */
  probeTargetFor(userEmail: string, slug: string): Promise<ToolProbeTarget | null>;
  /**
   * The per-user (`user`-scoped) variables a manual declares, each with the vault
   * key (`<manual>_<VAR>`) the caller's value is stored under, its bare name, and
   * its operator label. Used by the MCP proxy to check — before running a tool —
   * whether the caller has provided every personal credential the tool needs.
   */
  userScopedKeysForManual(
    manualName: string,
  ): Promise<
    { key: string; name: string; label: string | null; oauth: boolean; oauthScopes?: string[] }[]
  >;
  /** Drop the cached catalog (call after a merge to the default branch). */
  invalidate(): void;
}
