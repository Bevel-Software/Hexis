import path from 'node:path';
import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import '@utcp/http'; // side effect: register the 'http' call-template type (http + inline sub-manuals)
import '@utcp/mcp'; // side effect: register the 'mcp' call-template type (mcp `.tool` sources)
import {
  UtcpManualSerializer,
  CallTemplateSerializer,
  DefaultVariableSubstitutor,
  type CallTemplate,
} from '@utcp/sdk';
import {
  DEFAULT_BRANCH,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
} from '@bevel-software/platform-shared';
import { descriptorsFromMcpJson } from './mcp-json-discovery.js';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import { RESERVED_VARIABLE_NAMES, findReservedVariableRef } from '../../shared/variable-refs.js';
import { extractFrontmatter, resolveDeclaredId, isValidId, dedupeById } from '../../shared/frontmatter-id.js';
import { walkFiles } from '../../shared/fs-walk.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import {
  utcpNamespacePrefix,
  utcpNamespacedKey,
  MCP_OAUTH_VAR,
  INTERNAL_MANUAL_NAME,
} from '../../shared/utcp-namespace.js';
import {
  EXTERNAL_KB_MANUAL_NAME,
  type IToolManualService,
  type ToolManualDescriptor,
  type ToolManualDescriptorBase,
  type ToolManualSummary,
  type ToolManualDetail,
  type ToolCapability,
  type UtcpManualDict,
  type ToolManualPreview,
  type ToolManualType,
  type ToolVariable,
  type ToolVariableScope,
  type ToolVariableOAuth,
} from './tool-manuals.contract.js';

const CACHE_TTL_MS = 60_000;

/**
 * How many embedded tools a manual may advertise on the tool page. A `.tool` is
 * author-written, so its `tools` array is unbounded input; the page renders one
 * bullet per entry, and a thousand of them is a broken page, not a useful one.
 */
const MAX_CAPABILITIES = 100;

/**
 * UTCP namespaces a user `.tool` may NOT claim: they belong to built-in manuals
 * whose loopback creds are pre-seeded on the agent's code-mode client (the
 * internal `Bevel` manual carries the `source:'internal'` token + connector
 * creds; the external KB manual carries the caller's bearer). A `.tool`
 * reproducing one of these namespaces would resolve those seeded vars and could
 * exfiltrate them, so the scanner refuses it. Compared case-insensitively —
 * defensive, though the live collision is the mixed-case `Bevel` reachable via
 * the `name` fallback (an explicit `id` must already be lowercase snake_case).
 */
const RESERVED_TOOL_NAMESPACES = [INTERNAL_MANUAL_NAME, EXTERNAL_KB_MANUAL_NAME].map((n) => n.toLowerCase());

/**
 * No user `.tool` may REFERENCE the platform-seeded variables (`${API_URL}` /
 * `$API_URL`), in any `.tool` type: the only seeded user namespace is an
 * inline `.tool`'s (its discovery template is platform-served), and a
 * reference inside author-written content would resolve platform creds into a
 * request the author shaped. Refusing every `.tool` at the producing boundary
 * makes "user tools never carry platform credentials" structural rather than
 * dependent on which namespaces happen to be seeded. The names and the
 * reference grammar live in `shared/variable-refs.ts` — one definition for
 * every boundary that classifies references.
 */

/** Throw if any string in the `.tool` document references a reserved variable. */
function assertNoReservedVariableRefs(doc: unknown, name: string): void {
  const ref = findReservedVariableRef(doc);
  if (ref !== null) {
    throw new Error(
      `\`.tool\` "${name}" references the reserved variable "${ref}" — ` +
        'API_URL and CONNECTION_KEY (bare or namespaced, e.g. `<namespace>_CONNECTION_KEY`) ' +
        'are seeded by the platform for its own manuals and may not appear anywhere in a `.tool`.',
    );
  }
}

const manualSerializer = new UtcpManualSerializer();
const callTemplateSerializer = new CallTemplateSerializer();
// `findRequiredVariables` is a pure walk — one shared instance is fine.
const variableSubstitutor = new DefaultVariableSubstitutor();

/**
 * What the catalog needs from MCP OAuth auto-discovery (structurally satisfied
 * by `McpOAuthDiscoveryService` in modules/secrets-vault). A local port keeps
 * this module free of a secrets-vault import — the same decoupling discipline
 * the vault applies in the other direction with `VariableScopeResolver`.
 */
export interface McpAuthDiscoveryPort {
  statusFor(
    manualName: string,
    mcpUrl: string,
  ): Promise<
    | { status: 'open' }
    | {
        status: 'oauth';
        provider: { authorizationUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
      }
    | { status: 'unsupported'; reason: string }
  >;
}

/**
 * Reads `*.tool` manuals from the DEFAULT-branch workspace (never the caller's
 * branch), so the catalog is one global, released set — same discipline as
 * Skills. Results are cached briefly; drop via `invalidate()` after a merge to
 * default. Any read failure degrades to an empty catalog: the MCP/UTCP endpoint
 * must never break because a `.tool` can't be read.
 */
export class ToolManualService implements IToolManualService {
  private readonly cache: TtlCache<ToolManualDescriptor[]>;
  private mcpAuthDiscovery?: McpAuthDiscoveryPort;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  /**
   * Wire the MCP OAuth auto-discovery (setter injection: the discovery service
   * depends on the vault, which is constructed after this service — the same
   * reason the vault takes `scopeOfVariable` as a closure). Optional: without
   * it, bare `type: mcp` tools simply aren't decorated.
   */
  setMcpAuthDiscovery(discovery: McpAuthDiscoveryPort): void {
    this.mcpAuthDiscovery = discovery;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async listAccessible(userEmail: string): Promise<ToolManualSummary[]> {
    return (await this.accessibleManuals(userEmail)).map(toSummary);
  }

  async listAllSummaries(): Promise<ToolManualSummary[]> {
    return (await this.scan()).map(toSummary);
  }

  async getDetail(userEmail: string, slug: string): Promise<ToolManualDetail | null> {
    // Resolved through `accessibleManuals` rather than `scan()` + a canRead call
    // so the cache, the dedupe, the mcp-oauth decoration and the fail-closed
    // batch ACL all apply exactly as they do to the catalog listing — one read
    // model, no second place for the access rules to drift.
    const found = (await this.accessibleManuals(userEmail)).find((m) => m.slug === slug);
    if (!found) return null;
    return {
      ...toSummary(found),
      description: found.description ?? null,
      capabilities: capabilitiesOf(found),
    };
  }

  async listLocalOnly(userEmail: string): Promise<{ name: string; path: string }[]> {
    const manuals = await this.accessibleManuals(userEmail);
    return manuals.filter((m) => m.remote === false).map((m) => ({ name: m.name, path: m.path }));
  }

  async userScopedKeysForManual(
    manualName: string,
  ): Promise<
    { key: string; name: string; label: string | null; oauth: boolean; oauthScopes?: string[] }[]
  > {
    // The per-user (`user`-scoped) variables a manual declares, keyed the SAME
    // way the vault stores them — the UTCP-namespaced key (underscores in the
    // manual name doubled), so a readiness check reads the exact rows `resolve`
    // would. `oauth` lets the pre-check treat a not-yet-authorized sign-in as
    // still-missing.
    const manual = (await this.scan()).find((m) => m.name === manualName);
    return (manual?.variables ?? [])
      .filter((v) => v.scope === 'user')
      .map((v) => ({
        key: utcpNamespacedKey(manualName, v.name),
        name: v.name,
        label: v.label ?? null,
        oauth: v.oauth != null,
        // The permissions the tool declares RIGHT NOW — the pre-check compares these
        // against the caller's granted scopes to catch a token that predates a scope
        // addition. Read live so a `.tool` edit self-heals on the next call.
        oauthScopes: v.oauth?.scopes,
      }));
  }

  async scopeOfVariable(effectiveKey: string): Promise<ToolVariableScope> {
    // UTCP looks up `<namespace-with-doubled-underscores>_<VAR>`. Find the manual
    // whose namespace prefixes this key; the declared var is the remainder. Match
    // the LONGEST prefix so a manual `a` can't shadow `a_b` when both exist. (A
    // plain first-underscore split would mis-parse a snake_case manual name.)
    let best: { manual: ToolManualDescriptor; varName: string; len: number } | null = null;
    for (const m of await this.scan()) {
      const prefix = utcpNamespacePrefix(m.name);
      if (effectiveKey.startsWith(prefix) && (!best || prefix.length > best.len)) {
        best = { manual: m, varName: effectiveKey.slice(prefix.length), len: prefix.length };
      }
    }
    if (!best) return 'admin';
    const declared = best.manual.variables?.find((v) => v.name === best!.varName);
    return declared?.scope ?? 'admin';
  }

  async toManualCallTemplates(userEmail: string, opts?: { remoteOnly?: boolean }): Promise<CallTemplate[]> {
    const manuals = await this.accessibleManuals(userEmail);
    const out: CallTemplate[] = [];
    for (const m of manuals) {
      // Remote consumers (the hosted MCP proxy) don't get local-only manuals —
      // they'd fail server-side. Discovery of them happens via `list_local_tools`.
      if (opts?.remoteOnly && m.remote === false) continue;
      try {
        out.push(callTemplateSerializer.validateDict(this.buildCallTemplateDict(m)));
      } catch (err) {
        // A `.tool` that produces an invalid call-template is dropped here — at
        // the producing boundary — so the served list is always valid.
        console.warn(
          `[tool-manuals] skipping "${m.path}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  async resolveInlineManual(userEmail: string, slug: string): Promise<UtcpManualDict | null> {
    const found = (await this.scan()).find((m) => m.slug === slug);
    if (!found || found.type !== 'inline') return null;
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    if (!(await this.accessControl.canRead(wsId, userEmail, found.path))) return null;
    try {
      return manualSerializer.validateDict({
        utcp_version: '1.1.0',
        manual_version: '1.0.0',
        tools: found.tools ?? [],
      }) as unknown as UtcpManualDict;
    } catch {
      return null;
    }
  }

  async preview(content: string): Promise<ToolManualPreview> {
    let descriptor: ToolManualDescriptor;
    try {
      descriptor = normalizeToolManual('draft', 'Plugins/draft.tool', content);
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    if (descriptor.type === 'inline') {
      try {
        const manual = manualSerializer.validateDict({
          utcp_version: '1.1.0',
          manual_version: '1.0.0',
          tools: descriptor.tools ?? [],
        }) as { tools?: { name?: unknown; description?: unknown }[] };
        const tools = (manual.tools ?? []).map((t) => ({
          name: String(t.name ?? ''),
          description: typeof t.description === 'string' ? t.description : undefined,
        }));
        return { ok: true, tools };
      } catch (err) {
        return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    // http / mcp resolve their tools at runtime (a network round-trip we don't
    // perform in preview), but still validate the call-template the same way
    // `toManualCallTemplates` does, so a draft that discovery would reject is
    // reported here instead of appearing valid.
    try {
      callTemplateSerializer.validateDict(this.buildCallTemplateDict(descriptor));
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
    return { ok: true, tools: [] };
  }

  // --- internal --------------------------------------------------------------

  /** Build the raw UTCP manual call-template dict for one descriptor (validated by the caller). */
  private buildCallTemplateDict(m: ToolManualDescriptor): Record<string, unknown> {
    if (m.type === 'inline') {
      return {
        name: m.name,
        call_template_type: 'http',
        http_method: 'GET',
        url: `\${API_URL}/api/tools/${m.slug}/manual`,
        content_type: 'application/json',
        headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
      };
    }
    if (m.type === 'mcp' && m.stdio) {
      // A stdio server, for LOCAL consumers only (`remote: false` is implied
      // at discovery). Command/args/env/cwd pass through verbatim — the Agent
      // Plugins placeholders (`${PLUGIN_ROOT}`/`${PLUGIN_DATA}`) are expanded
      // by the LOCAL runtime against its materialized plugin copy; this
      // process has no such paths and must not guess them.
      return {
        name: m.name,
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            [m.name]: {
              transport: 'stdio',
              command: m.stdio.command,
              args: m.stdio.args,
              ...(m.stdio.env ? { env: m.stdio.env } : {}),
              ...(m.stdio.cwd ? { cwd: m.stdio.cwd } : {}),
            },
          },
        },
      };
    }
    if (m.type === 'mcp') {
      // Remote (HTTP/streamable) MCP server. Exact plugin field shape is
      // finalized in Phase 4 (native `@utcp/mcp`); the proxy try/catches
      // registration so an unsupported template never breaks the session.
      return {
        name: m.name,
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            [m.name]: {
              transport: 'http',
              url: m.url,
              ...(m.headers ? { headers: m.headers } : {}),
            },
          },
        },
      };
    }
    // http: a URL returning a UTCP manual.
    return {
      name: m.name,
      call_template_type: 'http',
      http_method: m.httpMethod ?? 'GET',
      url: m.url,
      content_type: 'application/json',
      ...(m.headers ? { headers: m.headers } : {}),
    };
  }

  private async accessibleManuals(userEmail: string): Promise<ToolManualDescriptor[]> {
    const manuals = await this.scan();
    if (manuals.length === 0) return [];
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    const allowed = await this.accessControl.canReadBatch(
      wsId,
      userEmail,
      manuals.map((m) => m.path),
    );
    // Fail closed: keep a manual only on an explicit `true` verdict (a missing
    // entry is treated as denied, matching the KB's default-deny read model).
    return manuals.filter((m) => allowed.get(m.path) === true);
  }

  private async scan(): Promise<ToolManualDescriptor[]> {
    const cached = this.cache.get();
    if (cached) return cached;
    const manuals = await this.scanDisk();
    await this.decorateMcpOAuth(manuals);
    // AFTER the oauth decoration, so an injected `${MCP_OAUTH}` header ref is
    // already declared and isn't re-surfaced as a bare admin key.
    for (const m of manuals) this.surfaceReferencedVariables(m);
    this.cache.set(manuals);
    return manuals;
  }

  /**
   * Auto-surface every `${VAR}` a manual actually references, for ANY tool
   * type — using UTCP's own required-variables walk, so the surfaced list
   * can't drift from what substitution will demand at registration/call time.
   * Referenced-but-undeclared vars become `scope: admin` entries (matching
   * `scopeOfVariable`'s default for undeclared keys), which puts them in the
   * secrets UI without the author having to write a `variables:` block. The
   * block stays the way to add metadata: `scope: user`, labels, oauth.
   */
  private surfaceReferencedVariables(m: ToolManualDescriptor): void {
    let refs: string[];
    try {
      refs = variableSubstitutor.findRequiredVariables(this.buildCallTemplateDict(m), m.name);
      // An inline manual's credential refs live in its embedded tools'
      // templates, not the (Bevel-hosted) discovery template.
      if (m.type === 'inline' && m.tools) {
        refs.push(...variableSubstitutor.findRequiredVariables(m.tools, m.name));
      }
    } catch {
      return; // a malformed template is reported elsewhere; never break the scan
    }
    const prefix = utcpNamespacePrefix(m.name);
    const declared = new Set((m.variables ?? []).map((v) => v.name));
    for (const ref of new Set(refs)) {
      if (!ref.startsWith(prefix)) continue;
      const name = ref.slice(prefix.length);
      // Reserved names are seeded by the proxy per session — not credentials.
      if (name === 'API_URL' || name === 'CONNECTION_KEY' || declared.has(name)) continue;
      m.variables = [...(m.variables ?? []), { name, scope: 'admin' }];
    }
  }

  /**
   * Zero-config OAuth for bare `type: mcp` manuals: when discovery finds the
   * remote server demands OAuth (and the file doesn't configure auth itself),
   * decorate the descriptor with a synthetic user-scoped `MCP_OAUTH` variable
   * and an `Authorization: Bearer ${MCP_OAUTH}` header. Decorating HERE — the
   * one place descriptors are built — means every consumer inherits it:
   * /connect lists the sign-in, `scopeOfVariable` resolves it per-user,
   * `userScopedKeysForManual` gates unauthorized callers, and the call
   * template carries the header for the variable loader to fill.
   */
  private async decorateMcpOAuth(manuals: ToolManualDescriptor[]): Promise<void> {
    const discovery = this.mcpAuthDiscovery;
    if (!discovery) return;
    const eligible = manuals.filter((m) => {
      if (m.type !== 'mcp' || !m.url) return false;
      // Local-only servers aren't probeable from here; templated URLs aren't
      // resolvable without a caller. Both keep their file-declared behavior.
      if (m.remote === false || m.url.includes('${')) return false;
      // The file configures auth itself — explicit wins over discovery.
      const hasAuthHeader = Object.keys(m.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
      const hasOAuthVar = (m.variables ?? []).some((v) => v.oauth != null);
      return !hasAuthHeader && !hasOAuthVar;
    });
    // Probe every eligible server CONCURRENTLY — a cold scan with several bare
    // mcp tools shouldn't pay one network round-trip per tool in series. The
    // mutation still happens per-manual after its own probe settles.
    await Promise.all(
      eligible.map(async (m) => {
        try {
          const found = await discovery.statusFor(m.name, m.url!);
          // Record the setup requirement so the secrets UI can tell an admin
          // whether anything needs configuring — especially the `unsupported`
          // case, which otherwise only surfaced in server logs.
          if (found.status === 'open') {
            m.setup = { kind: 'open' };
            return;
          }
          if (found.status === 'unsupported') {
            m.setup = { kind: 'oauth-manual', reason: found.reason };
            return;
          }
          m.setup = { kind: 'oauth-auto' };
          m.headers = { ...(m.headers ?? {}), Authorization: `Bearer \${${MCP_OAUTH_VAR}}` };
          m.variables = [
            ...(m.variables ?? []),
            {
              name: MCP_OAUTH_VAR,
              scope: 'user',
              label: `${m.name} sign-in`,
              // NO `scopes` here, deliberately. A variable's declared scopes are
              // REQUIRED back from the token (needsReauth + the call-time gate),
              // which is right for file-authored scopes but not for discovery's
              // machine-guessed ones (the PRM's `scopes_supported`): providers
              // don't reliably echo them (e.g. Granola's AS grants OIDC scopes
              // instead), which would permanently flag-and-block an authorized
              // sign-in. The shared provider row still carries them, so the
              // authorize request itself is unchanged; an under-scoped token
              // simply 401s at call time and re-enters auth there.
              oauth: {
                authorizationUrl: found.provider.authorizationUrl,
                tokenUrl: found.provider.tokenUrl,
                clientId: found.provider.clientId,
              },
            },
          ];
        } catch (err) {
          // Discovery must never break the catalog — the tool just stays bare.
          console.warn(
            `[tool-manuals] mcp auth discovery failed for "${m.path}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  private async scanDisk(): Promise<ToolManualDescriptor[]> {
    let wsId: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
    } catch {
      return [];
    }
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

    // A `.tool` sits under `Plugins/`, beside the skills that use it.
    const files: { abs: string; rel: string }[] = [];
    const root = path.join(kbRoot, PLUGINS_DIR);
    for (const rel of await walkFiles(root, (n) => n.toLowerCase().endsWith('.tool'))) {
      files.push({ abs: path.join(root, rel), rel: `${PLUGINS_DIR}/${rel}` });
    }

    // MCP servers come from each plugin's mcp.json — the AUTHORITATIVE source
    // (the Agent Plugins fixed location), synthesized into the same descriptor
    // shape. Listed BEFORE the `.tool` files: on a name collision (a legacy
    // mcp `.tool` the migration has not converted yet), the shared dedup keeps
    // the first occurrence, and the authoritative source must be the one kept.
    const parsed: ToolManualDescriptor[] = [];
    let pluginFolders: string[] = [];
    try {
      pluginFolders = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      /* no Plugins/ root — nothing to scan */
    }
    for (const folder of pluginFolders) {
      let mcpJson: string;
      try {
        mcpJson = await fs.readFile(path.join(root, folder, PLUGIN_MCP_FILE), 'utf-8');
      } catch {
        continue; // no mcp.json is the common case, not an error
      }
      const pluginJson = await fs
        .readFile(path.join(root, folder, PLUGIN_MANIFEST_FILE), 'utf-8')
        .catch(() => null);
      parsed.push(...descriptorsFromMcpJson(folder, mcpJson, pluginJson));
    }

    for (const f of files) {
      let content: string;
      try {
        content = await fs.readFile(f.abs, 'utf-8');
      } catch {
        continue;
      }
      let descriptor: ToolManualDescriptor;
      try {
        descriptor = normalizeToolManual(baseName(f.rel), f.rel, content);
      } catch {
        // A malformed `.tool` is skipped rather than breaking the catalog.
        continue;
      }
      // The route slug IS the id (unique after dedup below, snake_case → URL-safe),
      // so the URL a user sees matches the tool's declared identity.
      descriptor.slug = descriptor.name;
      parsed.push(descriptor);
    }
    // The manual name (= its id) is the UTCP variable namespace secrets bind to, so
    // it must be unique. A collision is REFUSED — not auto-suffixed, which would
    // silently rebind a configured secret to a different file. The winner is
    // deterministic (files scanned in sorted path order); the shared `dedupeById`
    // is the one dedup rule across tools and skills.
    return dedupeById(parsed, (m) => m.name, (m, id) =>
      console.warn(
        `[tool-manuals] skipping "${m.path}": manual id "${id}" is already used by another ` +
          '`.tool` — give it a unique `id` (the id is the secret-variable namespace and must be unique).',
      ),
    );
  }
}

// --- helpers ------------------------------------------------------------------

/**
 * The one descriptor → summary projection, shared by every list surface
 * (`listAccessible`, `listAllSummaries`, and the summary half of `getDetail`).
 */
function toSummary(m: ToolManualDescriptor): ToolManualSummary {
  return {
    slug: m.slug,
    name: m.name,
    path: m.path,
    type: m.type,
    description: m.description,
    variables: m.variables,
    remote: m.remote,
    setup: m.setup,
  };
}

/**
 * What an `inline` manual's embedded tools say the assistant can do. `tools` is
 * typed `unknown[]` (it is only validated when actually served as a UTCP
 * manual), so every entry is re-checked here: an entry without a string `name`
 * has nothing to display and is dropped rather than rendering a blank bullet.
 * Non-inline manuals discover their tools over the network at call time, so
 * there is nothing to derive without a round-trip this endpoint won't make.
 */
function capabilitiesOf(m: ToolManualDescriptor): ToolCapability[] {
  if (m.type !== 'inline' || !Array.isArray(m.tools)) return [];
  const out: ToolCapability[] = [];
  for (const entry of m.tools) {
    if (out.length >= MAX_CAPABILITIES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) continue;
    out.push({
      name: t.name.trim(),
      description: typeof t.description === 'string' && t.description.trim() ? t.description.trim() : null,
    });
  }
  return out;
}

function baseName(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.replace(/\.tool$/i, '');
}

/**
 * Deterministically derive a `.tool`'s UTCP manual name — the variable namespace
 * secrets bind to via `<manual>_<VAR>`. ALPHANUMERIC ONLY (no underscores) so the
 * prefix splits cleanly on a single underscore, and a pure function of the file's
 * own declared name: it never depends on what other `.tool`s exist, so a
 * configured secret's namespace can't drift when the catalog changes. Collisions
 * are refused by the scanner (see `scanDisk`), not silently suffixed. A name that
 * strips to empty (or starts with a digit) is prefixed `tool`; because the KB
 * manual name (`KNOWLEDGE_BASE`) contains an underscore, a user name can never
 * collide with it after stripping.
 */
function manualName(raw: string): string {
  const name = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (!name || /^[0-9]/.test(name)) return `tool${name}`;
  return name;
}

/**
 * Parse + normalize a `.tool` file into a descriptor. THE TOOL IS THE
 * FRONTMATTER: a fenced file's single `---` YAML block carries everything —
 * `id`/`name`, access verbs (`read`/`write`/`owner`/`download`, read straight
 * from the file by the access resolver, not here), and the config
 * (`type`/`url`/`variables`/…). Text after the closing fence is free-form notes
 * the parser ignores. A fence-less file is the legacy form (the whole file is
 * the object — JSON can't carry fences). Throws on a structurally invalid
 * object or a malformed explicit `id`. `slug` is provisional (the scanner
 * dedups it); `name` is the FINAL UTCP manual namespace.
 */
export function normalizeToolManual(
  provisionalSlug: string,
  repoPath: string,
  content: string,
): ToolManualDescriptor {
  // THE TOOL IS THE FRONTMATTER. A fenced `.tool` is one `---` YAML block
  // carrying everything — identity (`id`/`name`), access verbs, and config —
  // and anything after the closing fence is free-form notes the parser ignores
  // (like a SKILL.md body). One object serves every reader: the access resolver
  // finds its verbs inside the fence, the id index finds `id`/`name`, and the
  // config keys live in the same object. A fence-less file is the legacy form
  // (the whole file is the object) — JSON `.tool`s can't carry fences.
  const fm = extractFrontmatter(content);
  const source = fm ? fm.frontmatter : content;
  const parsed = parseYaml(source) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('`.tool` file must be a YAML/JSON object (in the `---` block when fenced)');
  }
  const obj = parsed as Record<string, unknown>;
  const type = normalizeType(obj.type);

  // Identity: an explicit `id` is used VERBATIM as the UTCP manual namespace, so
  // it must be lowercase snake_case (UTCP's namespace grammar). With no explicit
  // id, fall back to `name` then the filename and sanitize (legacy behaviour —
  // keeps existing tools' namespaces).
  const explicitId = typeof obj.id === 'string' ? obj.id.trim() : '';
  let name: string;
  if (explicitId) {
    if (!isValidId(explicitId)) {
      throw new Error(`tool id "${explicitId}" must be lowercase snake_case (letters, digits, underscores)`);
    }
    name = explicitId;
  } else {
    name = manualName(resolveDeclaredId(obj, provisionalSlug));
  }

  // A `.tool` may not reproduce a built-in manual's UTCP namespace — that would
  // let it read the loopback creds seeded under that namespace on the agent's
  // code-mode client (internal token, connector creds, KB bearer).
  if (RESERVED_TOOL_NAMESPACES.includes(name.toLowerCase())) {
    throw new Error(
      `tool namespace "${name}" is reserved for a built-in manual — choose a different \`id\`/\`name\` ` +
        "(a `.tool` sharing a built-in namespace could read that manual's seeded credentials).",
    );
  }

  // Any `.tool` content — url, headers, inline tool templates, notes — may not
  // reference the platform-seeded variables.
  assertNoReservedVariableRefs(obj, name);

  // The non-stdio constituent of the union, by name: `.tool` parsing can
  // never produce a spawn spec, and the stdio side pins `remote: false`,
  // which this builder must stay free to set from the file's own `remote:`.
  const descriptor: ToolManualDescriptorBase & { remote?: boolean; stdio?: undefined } = {
    slug: provisionalSlug,
    name,
    path: repoPath,
    type,
  };

  // Cosmetic prose for the browser tool page. Unlike every other field here, a
  // malformed value is IGNORED rather than thrown on: `description` buys the
  // reader a sentence, and no sentence is worth taking a working integration out
  // of the catalog (a throw skips the whole file). So: a non-empty string wins,
  // anything else — number, object, null, blank — silently leaves it absent.
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  if (description) descriptor.description = description;

  const variables = normalizeVariables(obj.variables);
  if (variables.length) descriptor.variables = variables;

  descriptor.remote = normalizeRemote(obj.remote);

  if (type === 'inline') {
    const tools = Array.isArray(obj.tools) ? obj.tools : undefined;
    if (!tools) throw new Error('inline `.tool` must have a `tools` array');
    descriptor.tools = tools;
  } else {
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!url) throw new Error(`${type} \`.tool\` must have a \`url\``);
    descriptor.url = url;
    // SSRF: a remote-capable `.tool` triggers a server-side discovery fetch to
    // this URL (the MCP proxy AND now the in-process agent + headless routines),
    // so a literal private/loopback/metadata host is refused at the producing
    // boundary. Only a TEMPLATED HOSTNAME (resolved at call time) is
    // uncheckable here — a `${...}` in the scheme, userinfo, port, path, or
    // query still leaves a concrete network target (`${S}://169.254.169.254/x`
    // and `http://${U}@169.254.169.254/x` target the metadata IP no matter what
    // resolves), so the guard must still run against the literal host. The
    // authority is therefore taken from `://` INDEPENDENT of the scheme being
    // literal, and when the raw url can't parse (templated scheme or port) the
    // check runs on a synthetic `<scheme-or-http>//host`. A BACKSLASH behaves as
    // a slash for http(s) in WHATWG `new URL` — BOTH as the scheme separator
    // (`${S}:\\169.254.169.254\\p` → the IP is the host) and inside the
    // authority (`http://169.254.169.254\@${HOST}/x` fetches the IP, the `\@…`
    // becoming path). So the authority separator is `:` + two `[\/]` (not just
    // `://`), and `\` also terminates the authority alongside `/?#`; otherwise a
    // literal internal host slips past as a templated scheme or userinfo.
    // Local-only (`remote: false`) `.tool`s are never fetched server-side, so
    // are exempt.
    const literalScheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)[\\/]{2}/.exec(url)?.[1];
    const sepMatch = /:[\\/]{2}/.exec(url);
    const sepIdx = sepMatch ? sepMatch.index : -1;
    const authority = sepIdx >= 0 ? url.slice(sepIdx + 3).split(/[/\\?#]/, 1)[0] : url;
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const host = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.split(':')[0];
    if (descriptor.remote !== false && !host.includes('${')) {
      const checkUrl =
        literalScheme && !authority.includes('${')
          ? url // fully literal scheme + authority → validate the URL as-is
          : sepIdx >= 0
            ? `${literalScheme ?? 'http:'}//${host}` // templated scheme/userinfo/port, literal host
            : url; // no authority shape at all → parse raw (refuses malformed)
      assertSafeFetchUrl(checkUrl, { label: `\`.tool\` "${name}" url` });
    }
    if (obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)) {
      descriptor.headers = obj.headers as Record<string, string>;
    }
    if (type === 'http') {
      const m = typeof obj.httpMethod === 'string' ? obj.httpMethod.toUpperCase() : 'GET';
      descriptor.httpMethod = m === 'POST' ? 'POST' : 'GET';
    }
  }
  return descriptor;
}

/**
 * Parse the optional `variables:` block of a `.tool` file. Each entry names a
 * `${VAR}` and who provisions it (`admin` default | `user`). Throws on a
 * malformed entry so the whole file is skipped (never silently mis-scoped) — a
 * mis-scoped variable is a security-relevant mistake, not a soft warning.
 */
function normalizeVariables(raw: unknown): ToolVariable[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('`variables` must be an array');
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('each `variables` entry must be an object');
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      throw new Error(`variable name "${name}" must match [A-Za-z0-9_]+`);
    }
    if (RESERVED_VARIABLE_NAMES.includes(name)) {
      throw new Error(`variable name "${name}" is reserved for platform seeding and may not be declared by a \`.tool\``);
    }
    if (seen.has(name)) throw new Error(`duplicate variable "${name}"`);
    seen.add(name);
    const rawScope = typeof e.scope === 'string' ? e.scope.toLowerCase().trim() : '';
    if (rawScope && rawScope !== 'admin' && rawScope !== 'user') {
      throw new Error(`variable "${name}" has invalid scope "${e.scope}" (expected admin|user)`);
    }
    const scope: ToolVariableScope = rawScope === 'user' ? 'user' : 'admin';
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined;
    const oauth = normalizeVariableOAuth(name, e.oauth);
    // OAuth is inherently per-caller — each user signs in for their own token. An
    // admin-shared OAuth token would leak one user's token to all callers.
    if (oauth && scope !== 'user') {
      throw new Error(`variable "${name}" with oauth must be scope:user`);
    }
    return {
      name,
      scope,
      ...(label ? { label } : {}),
      ...(oauth ? { oauth } : {}),
    };
  });
}

/**
 * Parse a variable's optional OAuth provider config. Carries PUBLIC config only —
 * never a client secret. Both URLs are validated with the SAME SSRF-safe check the
 * vault uses for OAuth endpoints (`assertSafeFetchUrl` with https required), so a
 * `.tool` author can't aim a sign-in/token exchange at an internal host.
 */
function normalizeVariableOAuth(name: string, raw: unknown): ToolVariableOAuth | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`variable "${name}" oauth must be an object`);
  }
  const o = raw as Record<string, unknown>;
  // Confidential OAuth material is provisioned only through the protected
  // client-secret route; reject it here so a plaintext `.tool` can't smuggle one in.
  for (const forbidden of ['clientSecret', 'client_secret', 'secret']) {
    if (o[forbidden] !== undefined) {
      throw new Error(`variable "${name}" oauth.${forbidden} must be set through the protected client-secret route`);
    }
  }
  const safeUrl = (v: unknown, field: string): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    try {
      assertSafeFetchUrl(s, { requireHttps: true, label: `${name} oauth.${field}` });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : `variable "${name}" oauth.${field} invalid`);
    }
    return s;
  };
  const authorizationUrl = safeUrl(o.authorizationUrl, 'authorizationUrl');
  const tokenUrl = safeUrl(o.tokenUrl, 'tokenUrl');
  const clientId = typeof o.clientId === 'string' && o.clientId.trim() ? o.clientId.trim() : '';
  if (!clientId) throw new Error(`variable "${name}" oauth.clientId is required`);
  let scopes: string[] | undefined;
  if (o.scopes !== undefined) {
    if (!Array.isArray(o.scopes) || !o.scopes.every((s) => typeof s === 'string')) {
      throw new Error(`variable "${name}" oauth.scopes must be string[]`);
    }
    scopes = o.scopes as string[];
  }
  let authParams: Record<string, string> | undefined;
  if (o.authParams !== undefined) {
    if (typeof o.authParams !== 'object' || Array.isArray(o.authParams)) {
      throw new Error(`variable "${name}" oauth.authParams must be an object of string values`);
    }
    const entries = Object.entries(o.authParams as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === 'string')) {
      throw new Error(`variable "${name}" oauth.authParams values must be strings`);
    }
    authParams = Object.fromEntries(entries) as Record<string, string>;
  }
  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    ...(scopes ? { scopes } : {}),
    ...(authParams ? { authParams } : {}),
  };
}

/**
 * Parse the optional `remote` flag. Absent ⇒ `true` (remote-capable, the default).
 * A non-boolean throws so the file is skipped rather than silently mis-classified.
 */
function normalizeRemote(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'boolean') throw new Error('`remote` must be a boolean');
  return raw;
}

function normalizeType(raw: unknown): ToolManualType {
  const t = typeof raw === 'string' ? raw.toLowerCase().trim() : '';
  if (t === 'http') return 'http';
  if (t === 'mcp') return 'mcp';
  if (t === 'inline' || t === 'text' || t === '') return 'inline';
  throw new Error(`unknown \`.tool\` type: ${raw}`);
}
