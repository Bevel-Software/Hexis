import type { CallTemplate } from '@utcp/sdk';

/**
 * Tool manuals — user-authored `*.tool` files under `Tools/` in the DEFAULT
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
 */
export interface ToolVariableOAuth {
  authorizationUrl: string;
  tokenUrl: string;
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
 *  - `oauth-manual` — the server needs OAuth but auto-discovery couldn't set it
 *                     up (typically no dynamic client registration, e.g. Google);
 *                     a tool writer must declare the provider in the `.tool` file
 *                     and set its client secret. `reason` says exactly why.
 */
export interface ToolManualSetup {
  kind: 'open' | 'oauth-auto' | 'oauth-manual';
  /** Why auto-setup didn't complete — present for `oauth-manual`. */
  reason?: string;
}

/** A parsed `.tool` file (normalized). */
export interface ToolManualDescriptor {
  /** URL-safe id derived from the file name (route `:slug`), unique in the catalog. */
  slug: string;
  /**
   * UTCP manual name — the declared frontmatter `id` (snake_case, underscores
   * allowed; see `isValidId`) or the filename-derived fallback. Unique in the
   * catalog; namespacing doubles underscores in vault keys (`utcpNamespacedKey`).
   */
  name: string;
  /** Repo-root-relative path of the `.tool` file (e.g. `Tools/weather.tool`). */
  path: string;
  type: ToolManualType;
  /** For `http`/`mcp`: the endpoint URL (may contain `${VAR}` refs). */
  url?: string;
  httpMethod?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** For `inline`: the embedded UTCP tools (validated when served). */
  tools?: unknown[];
  /** Declared `${VAR}` scopes (see {@link ToolVariable}); empty when none declared. */
  variables?: ToolVariable[];
  /**
   * Whether this tool can run for a REMOTE consumer (Bevel's hosted MCP proxy).
   * Absent/`true` ⇒ available remotely; `false` ⇒ LOCAL-ONLY — the remote endpoint
   * skips it (it can't reach e.g. a `localhost` MCP server), and instead surfaces
   * its path via the `list_local_tools` tool so a local agent can self-configure it.
   */
  remote?: boolean;
  /** For `type: mcp`: the admin-facing setup requirement from auto-discovery. */
  setup?: ToolManualSetup;
}

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
  /** Declared `${VAR}` scopes; empty when none declared. */
  variables?: ToolVariable[];
  /** `false` ⇒ local-only (not served to remote agents); absent/`true` ⇒ remote-capable. */
  remote?: boolean;
  /** For `type: mcp`: the admin-facing setup requirement from auto-discovery. */
  setup?: ToolManualSetup;
}

export interface IToolManualService {
  /** The `.tool` manuals the user can read, as summaries. */
  listAccessible(userEmail: string): Promise<ToolManualSummary[]>;
  /**
   * Validated UTCP manual call-templates for the user's accessible `.tool`s —
   * one per file, ready for a UTCP client to `registerManual`. Each is validated
   * at build time (a `.tool` that fails to validate is skipped + logged). Does
   * NOT include the KB manual (the route prepends that). With `{ remoteOnly: true }`
   * (the remote MCP proxy), LOCAL-ONLY manuals (`remote: false`) are excluded.
   */
  toManualCallTemplates(userEmail: string, opts?: { remoteOnly?: boolean }): Promise<CallTemplate[]>;
  /** The `{ name, path }` of the caller's accessible LOCAL-ONLY (`remote: false`) manuals. */
  listLocalOnly(userEmail: string): Promise<{ name: string; path: string }[]>;
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
