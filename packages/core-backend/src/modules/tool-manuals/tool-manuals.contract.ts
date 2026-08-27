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
